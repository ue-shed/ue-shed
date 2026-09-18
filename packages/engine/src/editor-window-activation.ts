import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
	decodeCompanionCapabilityManifest,
	EditorWindowActivationRequest,
	EditorWindowActivationResult
} from "@ue-shed/protocol";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, Schema } from "effect";

export class EditorWindowActivationError extends Schema.TaggedErrorClass<EditorWindowActivationError>()(
	"EditorWindowActivationError",
	{ message: Schema.String, recovery: Schema.String, operation: Schema.String }
) {}

/** Optional local OS permission handoff; a remote editor must never receive a local PID grant. */
export class EditorForegroundPermission extends Context.Service<
	EditorForegroundPermission,
	{
		readonly grant: (processId: number) => Effect.Effect<void, EditorWindowActivationError>;
	}
>()("@ue-shed/engine/EditorForegroundPermission") {}

const failure = (operation: string, cause: unknown) =>
	new EditorWindowActivationError({
		operation,
		message: String(cause),
		recovery: "Check the connected editor and compatible UE Shed Core plugin."
	});

export const EditorForegroundPermissionLive = Layer.succeed(EditorForegroundPermission, {
	grant: Effect.fn("EditorForegroundPermission.grant")(function* (processId: number) {
		if (process.platform !== "win32") return;
		yield* Schema.decodeUnknownEffect(EditorWindowActivationRequest)({
			expectedProcessId: processId
		}).pipe(Effect.mapError((cause) => failure("grant.validate", cause)));
		const result = yield* Effect.tryPromise({
			try: (signal) =>
				new Promise<string>((resolve, reject) => {
					const require = createRequire(import.meta.url);
					const manifest = require.resolve("@ue-shed/engine-win32-x64/package.json");
					const executable = join(
						dirname(manifest),
						"bin",
						"ue-shed-process-supervisor.exe"
					);
					execFile(
						executable,
						["--allow-foreground", String(processId)],
						{ windowsHide: true, timeout: 3000, maxBuffer: 4096, signal },
						(error, stdout) => (error ? reject(error) : resolve(stdout.trim()))
					);
				}),
			catch: (cause) => failure("grant", cause)
		});
		if (result !== "granted")
			yield* Effect.logDebug("Foreground permission was not granted", { result });
	})
});

export interface EditorWindowActivationApi {
	/** Call from an explicit user action. Does not select actors, move cameras, or change maps. */
	readonly activate: (
		endpoint: string
	) => Effect.Effect<EditorWindowActivationResult, EditorWindowActivationError>;
}
export class EditorWindowActivation extends Context.Service<
	EditorWindowActivation,
	EditorWindowActivationApi
>()("@ue-shed/engine/EditorWindowActivation") {}

export const EditorWindowActivationLive = Layer.effect(
	EditorWindowActivation,
	Effect.gen(function* () {
		const remote = yield* RemoteControlClient;
		const permission = yield* EditorForegroundPermission;
		return EditorWindowActivation.of({
			activate: Effect.fn("EditorWindowActivation.activate")(function* (endpoint: string) {
				const manifest = yield* remote
					.request({
						endpoint,
						objectPath: "/Script/UEShedCore.Default__UEShedCoreLibrary",
						functionName: "GetCapabilityManifest",
						operation: "editor.window.negotiate",
						parameters: {}
					})
					.pipe(
						Effect.flatMap(decodeCompanionCapabilityManifest),
						Effect.mapError((cause) => failure("negotiate", cause))
					);
				if (
					!manifest.capabilities.includes("editor.window-activation.v1") ||
					!manifest.windowActivationObjectPath ||
					!manifest.identity
				) {
					return yield* Effect.fail(
						failure(
							"negotiate",
							"The connected editor does not provide verified window activation. Update UE Shed Core."
						)
					);
				}
				const processId = manifest.identity.processId;
				const url = yield* Effect.try({
					try: () => new URL(endpoint),
					catch: (cause) => failure("endpoint", cause)
				});
				if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
					yield* permission
						.grant(processId)
						.pipe(
							Effect.catch((cause) =>
								Effect.logDebug(
									"Foreground handoff unavailable; trying editor activation",
									cause
								)
							)
						);
				}
				const result = yield* remote
					.request({
						endpoint,
						objectPath: manifest.windowActivationObjectPath,
						functionName: "ActivateEditorWindow",
						operation: "editor.window.activate",
						parameters: {
							RequestJson: JSON.stringify({ expectedProcessId: processId })
						}
					})
					.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(EditorWindowActivationResult)),
						Effect.mapError((cause) => failure("activate", cause))
					);
				if (result.processId !== processId)
					return yield* Effect.fail(
						failure("verify", "The editor process changed during activation.")
					);
				return result;
			})
		});
	})
);
