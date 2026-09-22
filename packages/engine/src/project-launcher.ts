import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { unrealRemoteControlPermissions } from "./remote-control-permissions.js";
import {
	EngineInstallationDiscovery,
	type EngineInstallationError
} from "./engine-installation.js";

const PluginId = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_]+$/u));
const HttpPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_534 }));

export const UnrealLaunchPlugin = Schema.Struct({
	descriptor: Schema.NonEmptyString,
	id: PluginId
});
export type UnrealLaunchPlugin = typeof UnrealLaunchPlugin.Type;

export const UnrealProjectLaunchMode = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("normal") }),
	Schema.Struct({
		kind: Schema.Literal("with_plugins"),
		plugins: Schema.Array(UnrealLaunchPlugin),
		remoteControlHttpPort: Schema.optional(HttpPort)
	})
]);
export type UnrealProjectLaunchMode = typeof UnrealProjectLaunchMode.Type;

export const UnrealProjectLaunchRequest = Schema.Struct({
	explicitEngineRoot: Schema.optional(Schema.NonEmptyString),
	mode: UnrealProjectLaunchMode,
	projectDescriptor: Schema.NonEmptyString
});
export type UnrealProjectLaunchRequest = typeof UnrealProjectLaunchRequest.Type;

export const UnrealProjectLaunchResult = Schema.Struct({
	engineRoot: Schema.NonEmptyString,
	executable: Schema.NonEmptyString,
	mode: Schema.Literals(["normal", "with_plugins"]),
	pid: Schema.Int.check(Schema.isGreaterThan(0)),
	projectDescriptor: Schema.NonEmptyString
});
export type UnrealProjectLaunchResult = typeof UnrealProjectLaunchResult.Type;

export class UnrealProjectLaunchError extends Schema.TaggedErrorClass<UnrealProjectLaunchError>()(
	"UnrealProjectLaunchError",
	{
		code: Schema.Literals([
			"invalid_request",
			"engine_discovery_failed",
			"editor_missing",
			"build_mismatch",
			"invalid_module_manifest",
			"plugin_unavailable",
			"spawn_failed"
		]),
		message: Schema.String,
		details: Schema.optionalKey(Schema.String),
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface UnrealProjectProcessLaunchOptions {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly executable: string;
}

export interface UnrealProjectProcessApi {
	readonly launch: (
		options: UnrealProjectProcessLaunchOptions
	) => Effect.Effect<number, UnrealProjectLaunchError>;
}

export class UnrealProjectProcess extends Context.Service<
	UnrealProjectProcess,
	UnrealProjectProcessApi
>()("@ue-shed/engine/UnrealProjectProcess") {}

export interface UnrealProjectLauncherApi {
	readonly launch: (
		request: UnrealProjectLaunchRequest
	) => Effect.Effect<UnrealProjectLaunchResult, UnrealProjectLaunchError>;
}

export class UnrealProjectLauncher extends Context.Service<
	UnrealProjectLauncher,
	UnrealProjectLauncherApi
>()("@ue-shed/engine/UnrealProjectLauncher") {}

function launchError(
	code: UnrealProjectLaunchError["code"],
	message: string,
	recovery: string,
	retrySafe = false
): UnrealProjectLaunchError {
	return new UnrealProjectLaunchError({ code, message, recovery, retrySafe });
}

function fromEngineDiscovery(cause: EngineInstallationError): UnrealProjectLaunchError {
	return launchError("engine_discovery_failed", cause.message, cause.recovery, cause.retrySafe);
}

const ModuleBuild = Schema.Struct({ BuildId: Schema.String });

/** Compare binary identities, not just the engine's major/minor version. */
export const validateUnrealProjectBuildId = Effect.fn("UnrealProjectLauncher.validateBuildId")(
	function* (engineRoot: string, projectDescriptor: string, platform = process.platform) {
		const binaryPlatform =
			platform === "win32" ? "Win64" : platform === "darwin" ? "Mac" : "Linux";
		const paths = [
			join(engineRoot, "Engine", "Binaries", binaryPlatform, "UnrealEditor.modules"),
			join(dirname(projectDescriptor), "Binaries", binaryPlatform, "UnrealEditor.modules")
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
				catch: () =>
					launchError(
						"invalid_module_manifest",
						`Cannot read module identity: ${path}`,
						"Repair the engine or project build before launching."
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
				retrySafe: false
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
)((engineRoot: string, platform = process.platform) =>
	Effect.tryPromise({
		try: async () => {
			const binaryPlatform =
				platform === "win32" ? "Win64" : platform === "darwin" ? "Mac" : "Linux";
			const engine = Schema.decodeUnknownSync(ModuleBuild)(
				JSON.parse(
					await readFile(
						join(
							engineRoot,
							"Engine",
							"Binaries",
							binaryPlatform,
							"UnrealEditor.modules"
						),
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
				issues: string[] = [];
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
						JSON.parse(await readFile(join(binaries, "UnrealEditor.modules"), "utf8"))
					);
					if (manifest.BuildId !== engine.BuildId)
						issues.push(
							`${id}: plugin build ${manifest.BuildId}; engine build ${engine.BuildId}`
						);
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
			if (issues.length)
				throw new UnrealProjectLaunchError({
					code: "plugin_unavailable",
					message:
						"Remote Control or its engine dependencies are missing or built for a different engine.",
					recovery:
						"Build this project's Editor target with Remote Control enabled (-EnablePlugin=RemoteControl), then launch again.",
					details: `Engine: ${engineRoot}\n${issues.join("\n")}`,
					retrySafe: false
				});
		},
		catch: (cause) =>
			cause instanceof UnrealProjectLaunchError
				? cause
				: new UnrealProjectLaunchError({
						code: "plugin_unavailable",
						message: "Could not verify this engine's Remote Control installation.",
						recovery:
							"Repair the selected engine's Remote Control plugin and its dependencies before launching.",
						details: String(cause),
						retrySafe: false
					})
	})
);

export function unrealEditorExecutable(engineRoot: string, platform = process.platform): string {
	if (platform === "win32") {
		return join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor.exe");
	}
	if (platform === "darwin") {
		return join(engineRoot, "Engine", "Binaries", "Mac", "UnrealEditor");
	}
	return join(engineRoot, "Engine", "Binaries", "Linux", "UnrealEditor");
}

export function unrealEditorCommandletExecutable(
	engineRoot: string,
	platform = process.platform
): string {
	if (platform === "win32") {
		return join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor-Cmd.exe");
	}
	if (platform === "darwin") {
		return join(engineRoot, "Engine", "Binaries", "Mac", "UnrealEditor-Cmd");
	}
	return join(engineRoot, "Engine", "Binaries", "Linux", "UnrealEditor-Cmd");
}

export function unrealRemoteControlArguments(
	plugins: readonly UnrealLaunchPlugin[],
	httpPort: number
): readonly string[] {
	const enabledPlugins = [...new Set([...plugins.map(({ id }) => id), "RemoteControl"])];
	return [
		`-EnablePlugins=${enabledPlugins.join(",")}`,
		"-RCWebControlEnable",
		`-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlHttpServerPort=${httpPort}`,
		`-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlWebSocketServerPort=${httpPort + 1}`,
		"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:bAutoStartWebServer=True",
		...unrealRemoteControlPermissions(enabledPlugins),
		"-NoLiveCoding"
	];
}

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
				request.mode.remoteControlHttpPort
			)
		);
	}
	return args;
}

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
										"Check the operating-system process limits and retry."
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
								"Verify the selected engine installation and project descriptor."
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
				Effect.mapError(() =>
					launchError(
						"invalid_request",
						"The Unreal project launch request is invalid.",
						"Choose one .uproject descriptor and valid plugin descriptors."
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
			const executable = unrealEditorExecutable(installation.root);
			yield* Effect.tryPromise({
				try: () => access(executable),
				catch: () =>
					launchError(
						"editor_missing",
						"The selected Unreal installation has no runnable editor executable.",
						"Choose a complete Unreal Editor installation."
					)
			});
			const projectDescriptor = resolve(request.projectDescriptor);
			yield* validateUnrealProjectBuildId(installation.root, projectDescriptor);
			if (
				request.mode.kind === "with_plugins" &&
				request.mode.remoteControlHttpPort !== undefined
			)
				yield* validateUnrealRemoteControlBuild(installation.root);
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

export function makeUnrealProjectProcessTestLayer(
	launch: UnrealProjectProcessApi["launch"]
): Layer.Layer<UnrealProjectProcess> {
	return Layer.succeed(UnrealProjectProcess, UnrealProjectProcess.of({ launch }));
}

export function makeUnrealProjectLauncherTestLayer(
	service: UnrealProjectLauncherApi
): Layer.Layer<UnrealProjectLauncher> {
	return Layer.succeed(UnrealProjectLauncher, UnrealProjectLauncher.of(service));
}
