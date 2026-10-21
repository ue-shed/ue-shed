import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ErrorCauseFields, ErrorGuidanceFields, type ErrorNextStep } from "@ue-shed/protocol";
import { Context, Effect, Layer, Schema } from "effect";
import {
	RemoteControlAllowedClass,
	unrealRemoteControlPermissions
} from "./remote-control-permissions.js";
import {
	EngineInstallationDiscovery,
	type EngineVersion,
	type EngineInstallationError
} from "./engine-installation.js";

const PluginId = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_]+$/u));
const HttpPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_534 }));

/**
 * Explicit plugin descriptor path and plugin ID for a launch. IDs are restricted to letters,
 * digits and underscores; descriptor existence and binary compatibility are checked by the
 * launcher.
 */
export const UnrealLaunchPlugin = Schema.Struct({
	descriptor: Schema.NonEmptyString,
	id: PluginId
});
export type UnrealLaunchPlugin = typeof UnrealLaunchPlugin.Type;

/**
 * Normal launch or explicit plugin-enabled launch, optionally with a Remote Control HTTP
 * port. Plugin enablement is per launch rather than a persistent project-descriptor edit.
 * `remoteControlAllowedClasses` adds a host's own Remote Control classes to the per-launch
 * allowlist beside the enabled UE Shed plugins' classes.
 */
export const UnrealProjectLaunchMode = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("normal") }),
	Schema.Struct({
		kind: Schema.Literal("with_plugins"),
		plugins: Schema.Array(UnrealLaunchPlugin),
		remoteControlHttpPort: Schema.optional(HttpPort),
		remoteControlAllowedClasses: Schema.optional(
			Schema.Array(RemoteControlAllowedClass).check(Schema.isMaxLength(64))
		)
	})
]);
export type UnrealProjectLaunchMode = typeof UnrealProjectLaunchMode.Type;

/**
 * Explicit .uproject descriptor, launch mode and optional engine root. The launcher validates
 * the request and installed binaries before spawning the editor.
 */
export const UnrealProjectLaunchRequest = Schema.Struct({
	explicitEngineRoot: Schema.optional(Schema.NonEmptyString),
	mode: UnrealProjectLaunchMode,
	projectDescriptor: Schema.NonEmptyString
});
export type UnrealProjectLaunchRequest = typeof UnrealProjectLaunchRequest.Type;

/**
 * Spawned editor PID and resolved engine/executable/project paths. Successful spawning is not
 * editor readiness; use EditorConnection or a supervised session for readiness evidence.
 */
export const UnrealProjectLaunchResult = Schema.Struct({
	engineRoot: Schema.NonEmptyString,
	executable: Schema.NonEmptyString,
	mode: Schema.Literals(["normal", "with_plugins"]),
	pid: Schema.Int.check(Schema.isGreaterThan(0)),
	projectDescriptor: Schema.NonEmptyString
});
export type UnrealProjectLaunchResult = typeof UnrealProjectLaunchResult.Type;

/**
 * Launch validation, engine discovery, binary compatibility or spawn failure. Guidance
 * identifies repairable input and uncertain spawning; cause retains the originating failure.
 */
export class UnrealProjectLaunchError extends Schema.TaggedError<UnrealProjectLaunchError>()(
	"UnrealProjectLaunchError",
	{
		code: Schema.Literals([
			"invalid_request",
			"engine_discovery_failed",
			"editor_missing",
			"build_mismatch",
			"invalid_module_manifest",
			"plugin_unavailable",
			"engine_plugins_stale",
			"spawn_failed"
		]),
		details: Schema.optionalKey(Schema.String),
		enginePlugins: Schema.optionalKey(
			Schema.Struct({
				engineRoot: Schema.NonEmptyString,
				stalePlugins: Schema.Array(PluginId),
				buildable: Schema.Boolean
			})
		),
		...ErrorGuidanceFields,
		...ErrorCauseFields
	}
) {}
const isUnrealProjectLaunchError = Schema.is(UnrealProjectLaunchError);

/**
 * Executable, working directory and literal argument array for an editor spawn. No shell
 * command is constructed; these options do not themselves validate the project or engine.
 */
export interface UnrealProjectProcessLaunchOptions {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly executable: string;
}

/**
 * Detached editor-spawn port returning its PID. For scope-owned termination and readiness,
 * use SupervisedEditorSession rather than treating this PID as a managed session.
 */
export interface UnrealProjectProcessApi {
	readonly launch: (
		options: UnrealProjectProcessLaunchOptions
	) => Effect.Effect<number, UnrealProjectLaunchError>;
}

/**
 * Replaceable low-level detached editor launcher. Its lifecycle ends at spawning; it does not
 * own the editor process tree after a successful launch.
 */
export class UnrealProjectProcess extends Context.Service<
	UnrealProjectProcess,
	UnrealProjectProcessApi
>()("@ue-shed/engine/UnrealProjectProcess") {}

/**
 * Validates an explicit launch request, resolves the engine and starts the editor. A
 * successful result proves spawn, not connection readiness or capability availability.
 */
export interface UnrealProjectLauncherApi {
	readonly launch: (
		request: UnrealProjectLaunchRequest
	) => Effect.Effect<UnrealProjectLaunchResult, UnrealProjectLaunchError>;
}

/**
 * High-level detached editor-launch port requiring engine discovery and a process-spawn
 * implementation. It does not own host project selection.
 */
export class UnrealProjectLauncher extends Context.Service<
	UnrealProjectLauncher,
	UnrealProjectLauncherApi
>()("@ue-shed/engine/UnrealProjectLauncher") {}

function launchError(
	code: UnrealProjectLaunchError["code"],
	message: string,
	recovery: string,
	retrySafe = false,
	nextStep: ErrorNextStep = "fix_input",
	cause?: unknown
): UnrealProjectLaunchError {
	return new UnrealProjectLaunchError({
		code,
		message,
		recovery,
		retrySafe,
		nextStep,
		...(cause === undefined ? undefined : { cause })
	});
}

function fromEngineDiscovery(cause: EngineInstallationError): UnrealProjectLaunchError {
	return launchError(
		"engine_discovery_failed",
		cause.message,
		cause.recovery,
		cause.retrySafe,
		cause.nextStep,
		cause
	);
}

const ModuleBuild = Schema.Struct({ BuildId: Schema.String });

/** UE4 names editor binaries and module manifests `UE4Editor`; UE5 renamed them `UnrealEditor`. */
export function unrealEditorBinaryName(version?: EngineVersion): "UE4Editor" | "UnrealEditor" {
	return version?.major === 4 ? "UE4Editor" : "UnrealEditor";
}

/** Compare binary identities, not just the engine's major/minor version. */
export const validateUnrealProjectBuildId = Effect.fn("UnrealProjectLauncher.validateBuildId")(
	function* (
		engineRoot: string,
		projectDescriptor: string,
		platform = process.platform,
		version?: EngineVersion
	) {
		const binaryPlatform =
			platform === "win32" ? "Win64" : platform === "darwin" ? "Mac" : "Linux";
		const manifest = `${unrealEditorBinaryName(version)}.modules`;
		const paths = [
			join(engineRoot, "Engine", "Binaries", binaryPlatform, manifest),
			join(dirname(projectDescriptor), "Binaries", binaryPlatform, manifest)
		];
		const builds = yield* Effect.forEach(paths, (path) =>
			Effect.tryPromise({
				try: async () => {
					try {
						return Schema.decodeUnknownSync(ModuleBuild)(
							JSON.parse(await readFile(path, "utf8"))
						);
					} catch (cause) {
						if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
							return undefined;
						throw cause;
					}
				},
				catch: (cause) =>
					launchError(
						"invalid_module_manifest",
						`Cannot read module identity: ${path}`,
						"Repair the engine or project build before launching.",
						false,
						"fix_input",
						cause
					)
			})
		);
		const [engine, project] = builds;
		if (engine && project && engine.BuildId !== project.BuildId)
			return yield* new UnrealProjectLaunchError({
				code: "build_mismatch",
				message: "Your project's compiled modules don't match the selected Unreal engine.",
				recovery:
					"Close Unreal, build this project's Editor target using its associated engine, then launch again. Rebuild the project first; a full engine rebuild may not be necessary.",
				details: `Project: ${projectDescriptor}\nEngine: ${engineRoot}\nProject build ID: ${project.BuildId}\nEngine build ID: ${engine.BuildId}`,
				retrySafe: false,
				nextStep: "fix_input"
			});
	}
);

const EnginePluginDescriptor = Schema.Struct({
	Modules: Schema.optionalKey(Schema.Array(Schema.Struct({ Name: PluginId }))),
	Plugins: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				Name: PluginId,
				Enabled: Schema.Boolean,
				Optional: Schema.optionalKey(Schema.Boolean)
			})
		)
	)
});
const PluginModuleBuild = Schema.Struct({
	BuildId: Schema.NonEmptyString,
	Modules: Schema.Record(Schema.String, Schema.NonEmptyString)
});

/** Validate the engine plugins needed by the optional Remote Control connection before spawning. */
export const validateUnrealRemoteControlBuild = Effect.fn(
	"UnrealProjectLauncher.validateRemoteControl"
)((engineRoot: string, platform = process.platform, version?: EngineVersion) =>
	Effect.tryPromise({
		try: async () => {
			const binaryPlatform =
				platform === "win32" ? "Win64" : platform === "darwin" ? "Mac" : "Linux";
			const manifestName = `${unrealEditorBinaryName(version)}.modules`;
			const engine = Schema.decodeUnknownSync(ModuleBuild)(
				JSON.parse(
					await readFile(
						join(engineRoot, "Engine", "Binaries", binaryPlatform, manifestName),
						"utf8"
					)
				)
			);
			const descriptors = new Map<string, string>();
			const directories = [join(engineRoot, "Engine", "Plugins")];
			for (const directory of directories) {
				const entries = await readdir(directory, { withFileTypes: true });
				const plugins = entries.filter(
					(entry) => entry.isFile() && entry.name.endsWith(".uplugin")
				);
				for (const plugin of plugins)
					descriptors.set(
						basename(plugin.name, ".uplugin"),
						join(directory, plugin.name)
					);
				if (plugins.length) continue;
				for (const entry of entries) {
					if (
						entry.isDirectory() &&
						!entry.name.startsWith(".") &&
						!["Binaries", "Intermediate"].includes(entry.name)
					)
						directories.push(join(directory, entry.name));
				}
			}
			const pending = ["RemoteControl"],
				seen = new Set<string>(),
				issues: string[] = [],
				stalePlugins: string[] = [];
			for (const id of pending) {
				if (seen.has(id)) continue;
				seen.add(id);
				const descriptor = descriptors.get(id);
				if (!descriptor) {
					issues.push(`${id}: plugin is missing`);
					continue;
				}
				const plugin = Schema.decodeUnknownSync(EnginePluginDescriptor)(
					JSON.parse(await readFile(descriptor, "utf8"))
				);
				for (const dependency of plugin.Plugins ?? []) {
					if (dependency.Enabled && !dependency.Optional) pending.push(dependency.Name);
				}
				if (!plugin.Modules?.length) continue;
				const binaries = join(dirname(descriptor), "Binaries", binaryPlatform);
				try {
					const manifest = Schema.decodeUnknownSync(PluginModuleBuild)(
						JSON.parse(await readFile(join(binaries, manifestName), "utf8"))
					);
					if (manifest.BuildId !== engine.BuildId) {
						stalePlugins.push(id);
						issues.push(
							`${id}: plugin build ${manifest.BuildId}; engine build ${engine.BuildId}`
						);
					}
					for (const file of Object.values(manifest.Modules)) {
						try {
							await access(join(binaries, file));
						} catch {
							issues.push(`${id}: missing binary ${file}`);
						}
					}
				} catch {
					issues.push(`${id}: missing or invalid module manifest at ${binaries}`);
				}
			}
			if (issues.length) {
				const exists = (path: string) =>
					access(path).then(
						() => true,
						() => false
					);
				const buildable =
					platform === "win32" &&
					(await exists(
						join(engineRoot, "Engine", "Build", "BatchFiles", "Build.bat")
					)) &&
					(await exists(
						join(
							engineRoot,
							"Engine",
							"Source",
							"Programs",
							"UnrealBuildTool",
							"UnrealBuildTool.csproj"
						)
					)) &&
					!(await exists(join(engineRoot, "Engine", "Build", "InstalledBuild.txt")));
				if (buildable && stalePlugins.length === issues.length)
					throw new UnrealProjectLaunchError({
						code: "engine_plugins_stale",
						message:
							"A project build updated this engine, but Remote Control's plugins were left behind.",
						recovery:
							"Close editors and builds using this engine, then rebuild the stale plugins with this project's Editor target.",
						details: `Engine: ${engineRoot}\n${issues.join("\n")}`,
						enginePlugins: { engineRoot, stalePlugins, buildable },
						retrySafe: true,
						nextStep: "fix_input"
					});
				throw new UnrealProjectLaunchError({
					code: "plugin_unavailable",
					message:
						"Remote Control or its engine dependencies are missing or built for a different engine.",
					recovery:
						"Build this project's Editor target with Remote Control enabled (-EnablePlugin=RemoteControl), then launch again.",
					details: `Engine: ${engineRoot}\n${issues.join("\n")}`,
					retrySafe: false,
					nextStep: "fix_input"
				});
			}
		},
		catch: (cause) =>
			isUnrealProjectLaunchError(cause)
				? cause
				: new UnrealProjectLaunchError({
						cause: cause,
						code: "plugin_unavailable",
						message: "Could not verify this engine's Remote Control installation.",
						recovery:
							"Repair the selected engine's Remote Control plugin and its dependencies before launching.",
						details: String(cause),
						retrySafe: false,
						nextStep: "fix_input"
					})
	})
);

/**
 * Builds the platform-specific editor executable path under an engine root, using UE4Editor
 * for UE4 and UnrealEditor for UE5. This pure helper does not check file existence.
 */
export function unrealEditorExecutable(
	engineRoot: string,
	platform = process.platform,
	version?: EngineVersion
): string {
	const name = unrealEditorBinaryName(version);
	if (platform === "win32") {
		return join(engineRoot, "Engine", "Binaries", "Win64", `${name}.exe`);
	}
	if (platform === "darwin") {
		// Mac editors are app bundles; Epic's UAT runs `<Name>.app/Contents/MacOS/<Name>` too.
		const bundle = join(engineRoot, "Engine", "Binaries", "Mac", `${name}.app`);
		return join(bundle, "Contents", "MacOS", name);
	}
	return join(engineRoot, "Engine", "Binaries", "Linux", name);
}

/** Commandlet binaries are console apps, so they stay outside a Mac app bundle. */
export function unrealEditorCommandletExecutable(
	engineRoot: string,
	platform = process.platform,
	version?: EngineVersion
): string {
	const name = `${unrealEditorBinaryName(version)}-Cmd`;
	if (platform === "win32") {
		return join(engineRoot, "Engine", "Binaries", "Win64", `${name}.exe`);
	}
	if (platform === "darwin") {
		return join(engineRoot, "Engine", "Binaries", "Mac", name);
	}
	return join(engineRoot, "Engine", "Binaries", "Linux", name);
}

/**
 * Builds per-launch plugin and Remote Control arguments, including HTTP and adjacent
 * WebSocket ports. Accepts already validated input; does not persist settings or start a
 * process. `allowedClasses` adds a host's own classes to the UE 5.8 Remote Control allowlist.
 */
export function unrealRemoteControlArguments(
	plugins: readonly UnrealLaunchPlugin[],
	httpPort: number,
	allowedClasses: readonly RemoteControlAllowedClass[] = []
): readonly string[] {
	const enabledPlugins = [...new Set([...plugins.map(({ id }) => id), "RemoteControl"])];
	return [
		`-EnablePlugins=${enabledPlugins.join(",")}`,
		"-RCWebControlEnable",
		`-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlHttpServerPort=${httpPort}`,
		`-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlWebSocketServerPort=${httpPort + 1}`,
		"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:bAutoStartWebServer=True",
		...unrealRemoteControlPermissions(enabledPlugins, allowedClasses),
		"-NoLiveCoding"
	];
}

/**
 * Builds literal editor arguments for a validated normal or plugin-enabled request. Resolves
 * descriptor paths and adds Remote Control configuration only when its port is explicitly
 * requested.
 */
export function unrealProjectLaunchArguments(
	request: UnrealProjectLaunchRequest
): readonly string[] {
	if (request.mode.kind === "normal") return [resolve(request.projectDescriptor)];
	const args = [
		resolve(request.projectDescriptor),
		...request.mode.plugins.map(({ descriptor }) => `-PLUGIN=${resolve(descriptor)}`)
	];
	if (request.mode.remoteControlHttpPort !== undefined) {
		args.push(
			...unrealRemoteControlArguments(
				request.mode.plugins,
				request.mode.remoteControlHttpPort,
				request.mode.remoteControlAllowedClasses
			)
		);
	}
	return args;
}

/**
 * Spawns the editor without a shell, detaches it and returns its PID. Cancellation before
 * settlement kills the pending child; a successfully detached editor remains running.
 */
export const UnrealProjectProcessLive = Layer.succeed(
	UnrealProjectProcess,
	UnrealProjectProcess.of({
		launch: Effect.fn("UnrealProjectProcess.launch")((options) =>
			Effect.callback<number, UnrealProjectLaunchError>((resume) => {
				let settled = false;
				const child = spawn(options.executable, [...options.args], {
					cwd: options.cwd,
					detached: true,
					shell: false,
					stdio: "ignore",
					windowsHide: false
				});
				child.once("spawn", () => {
					settled = true;
					child.unref();
					const pid = child.pid;
					resume(
						pid === undefined
							? Effect.fail(
									launchError(
										"spawn_failed",
										"Unreal Editor started without a process identity.",
										"An editor may have started anyway. Check for a running Unreal Editor and the operating-system process limits before launching again.",
										false,
										"reconcile"
									)
								)
							: Effect.succeed(pid)
					);
				});
				child.once("error", (cause) => {
					settled = true;
					resume(
						Effect.fail(
							launchError(
								"spawn_failed",
								`Unreal Editor could not be started: ${cause.message}`,
								"Verify the selected engine installation and project descriptor.",
								false,
								"fix_input",
								cause
							)
						)
					);
				});
				return Effect.sync(() => {
					if (!settled && !child.killed) child.kill();
				});
			})
		)
	})
);

/**
 * Validates project/plugin build identities and executable availability before delegating to
 * UnrealProjectProcess. Requires EngineInstallationDiscovery and the process port; does not
 * silently rebuild stale binaries.
 */
export const UnrealProjectLauncherLive = Layer.effect(
	UnrealProjectLauncher,
	Effect.gen(function* () {
		const engines = yield* EngineInstallationDiscovery;
		const processes = yield* UnrealProjectProcess;
		const launch = Effect.fn("UnrealProjectLauncher.launch")(function* (
			input: UnrealProjectLaunchRequest
		) {
			const request = yield* Schema.decodeUnknownEffect(UnrealProjectLaunchRequest)(
				input
			).pipe(
				Effect.mapError((cause) =>
					launchError(
						"invalid_request",
						"The Unreal project launch request is invalid.",
						"Choose one .uproject descriptor and valid plugin descriptors.",
						false,
						"fix_input",
						cause
					)
				)
			);
			const installation = yield* engines
				.resolve({
					projectDescriptor: request.projectDescriptor,
					...(request.explicitEngineRoot === undefined
						? undefined
						: { explicitRoot: request.explicitEngineRoot })
				})
				.pipe(Effect.mapError(fromEngineDiscovery));
			const executable = unrealEditorExecutable(
				installation.root,
				process.platform,
				installation.version
			);
			yield* Effect.tryPromise({
				try: () => access(executable),
				catch: (cause) =>
					launchError(
						"editor_missing",
						"The selected Unreal installation has no runnable editor executable.",
						"Choose a complete Unreal Editor installation.",
						false,
						"fix_input",
						cause
					)
			});
			const projectDescriptor = resolve(request.projectDescriptor);
			yield* validateUnrealProjectBuildId(
				installation.root,
				projectDescriptor,
				process.platform,
				installation.version
			);
			if (
				request.mode.kind === "with_plugins" &&
				request.mode.remoteControlHttpPort !== undefined
			)
				yield* validateUnrealRemoteControlBuild(
					installation.root,
					process.platform,
					installation.version
				);
			const pid = yield* processes.launch({
				args: unrealProjectLaunchArguments(request),
				cwd: dirname(projectDescriptor),
				executable
			});
			return UnrealProjectLaunchResult.make({
				engineRoot: installation.root,
				executable,
				mode: request.mode.kind,
				pid,
				projectDescriptor
			});
		});
		return UnrealProjectLauncher.of({ launch });
	})
);

/**
 * Provides a complete explicit UnrealProjectProcess test port. The supplied implementation
 * owns outcomes and synchronization; no missing operation falls back to the production
 * service.
 */
export function makeUnrealProjectProcessTestLayer(
	launch: UnrealProjectProcessApi["launch"]
): Layer.Layer<UnrealProjectProcess> {
	return Layer.succeed(UnrealProjectProcess, UnrealProjectProcess.of({ launch }));
}

/**
 * Provides a complete explicit UnrealProjectLauncher test port. The supplied implementation
 * owns outcomes and synchronization; no missing operation falls back to the production
 * service.
 */
export function makeUnrealProjectLauncherTestLayer(
	service: UnrealProjectLauncherApi
): Layer.Layer<UnrealProjectLauncher> {
	return Layer.succeed(UnrealProjectLauncher, UnrealProjectLauncher.of(service));
}
