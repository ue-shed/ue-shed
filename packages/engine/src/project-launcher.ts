import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
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
			"spawn_failed"
		]),
		message: Schema.String,
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

export function unrealEditorExecutable(engineRoot: string, platform = process.platform): string {
	if (platform === "win32") {
		return join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor.exe");
	}
	if (platform === "darwin") {
		return join(engineRoot, "Engine", "Binaries", "Mac", "UnrealEditor");
	}
	return join(engineRoot, "Engine", "Binaries", "Linux", "UnrealEditor");
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
