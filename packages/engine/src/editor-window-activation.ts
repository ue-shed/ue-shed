import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
	decodeCompanionCapabilityManifest,
	ContractParseError,
	EditorWindowActivationRequest,
	EditorWindowActivationResult,
	ErrorCauseFields,
	ErrorGuidanceFields,
	type ErrorNextStep
} from "@ue-shed/protocol";
import { RemoteControlClient, type RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, Schema } from "effect";
import { isLoopbackEndpoint } from "./loopback-endpoint.js";

/**
 * Foreground permission, negotiation or activation failure with operation context and
 * original cause. A host may offer manual focusing using the supplied recovery guidance.
 */
export class EditorWindowActivationError extends Schema.TaggedError<EditorWindowActivationError>()(
	"EditorWindowActivationError",
	{
		operation: Schema.String,
		...ErrorGuidanceFields,
		...ErrorCauseFields
	}
) {}

/** Optional local OS permission handoff; a remote editor must never receive a local PID grant. */
export class EditorForegroundPermission extends Context.Service<
	EditorForegroundPermission,
	{
		readonly grant: (processId: number) => Effect.Effect<void, EditorWindowActivationError>;
	}
>()("@ue-shed/engine/EditorForegroundPermission") {}

interface Guidance {
	readonly recovery: string;
	readonly retrySafe: boolean;
	readonly nextStep: ErrorNextStep;
}

const pluginMismatch: Guidance = {
	recovery: "Install the UE Shed Core plugin version paired with this client, then reconnect.",
	retrySafe: false,
	nextStep: "escalate"
};

/** Negotiation and activation only read state or raise a window, so repeating them is safe. */
function requestGuidance(
	cause: RemoteControlClientError | ContractParseError | Schema.SchemaError
): Guidance {
	if (Schema.is(ContractParseError)(cause) || Schema.isSchemaError(cause)) return pluginMismatch;
	return { recovery: cause.recovery, retrySafe: cause.retrySafe, nextStep: cause.nextStep };
}

const failure = (operation: string, message: string, guidance: Guidance, cause?: unknown) =>
	new EditorWindowActivationError({
		...(cause === undefined ? undefined : { cause }),
		operation,
		message,
		...guidance
	});

/**
 * Windows process-supervisor adapter for foreground permission; other platforms complete
 * without a grant. Requires the matching platform package and never launches or selects an
 * editor.
 */
export const EditorForegroundPermissionLive = Layer.succeed(EditorForegroundPermission, {
	grant: Effect.fn("EditorForegroundPermission.grant")(function* (processId: number) {
		if (process.platform !== "win32") return;
		yield* Schema.decodeUnknownEffect(EditorWindowActivationRequest)({
			expectedProcessId: processId
		}).pipe(
			Effect.mapError((cause) =>
				failure(
					"grant.validate",
					`The foreground permission request for process ${processId} is invalid.`,
					pluginMismatch,
					cause
				)
			)
		);
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
			catch: (cause) =>
				failure(
					"grant",
					`The process supervisor could not grant foreground permission to process ${processId}.`,
					{
						recovery:
							"Reinstall UE Shed so its process supervisor is present, or focus the editor window manually.",
						retrySafe: true,
						nextStep: "escalate"
					},
					cause
				)
		});
		if (result !== "granted")
			yield* Effect.logDebug("Foreground permission was not granted", { result });
	})
});

/**
 * Raises the connected editor window after validating its process identity. Local OS
 * permission handoff is optional and never grants a local PID to a remote endpoint.
 */
export interface EditorWindowActivationApi {
	/** Call from an explicit user action. Does not select actors, move cameras, or change maps. */
	readonly activate: (
		endpoint: string
	) => Effect.Effect<EditorWindowActivationResult, EditorWindowActivationError>;
}
/**
 * Editor-window activation port. Window focus is an explicit host action, separate from
 * project selection and editor launch.
 */
export class EditorWindowActivation extends Context.Service<
	EditorWindowActivation,
	EditorWindowActivationApi
>()("@ue-shed/engine/EditorWindowActivation") {}

/**
 * Negotiates the editor window identity and requests activation through RemoteControlClient.
 * Local foreground permission is provided separately; remote endpoints receive no local PID
 * grant.
 */
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
						idempotent: true,
						operation: "editor.window.negotiate",
						parameters: {}
					})
					.pipe(
						Effect.flatMap(decodeCompanionCapabilityManifest),
						Effect.mapError((cause) =>
							failure(
								"negotiate",
								Schema.is(ContractParseError)(cause)
									? `The editor at ${endpoint} returned a capability manifest that does not match the companion contract.`
									: `Could not read the capability manifest from the editor at ${endpoint}.`,
								requestGuidance(cause),
								cause
							)
						)
					);
				if (
					!manifest.capabilities.includes("editor.window-activation.v1") ||
					!manifest.windowActivationObjectPath ||
					!manifest.identity
				) {
					return yield* Effect.fail(
						failure(
							"negotiate",
							"The connected editor does not provide verified window activation. Update UE Shed Core.",
							{
								recovery:
									"Update the project's UE Shed Core plugin to a version with window activation, then reconnect.",
								retrySafe: false,
								nextStep: "fix_input"
							}
						)
					);
				}
				const processId = manifest.identity.processId;
				if (isLoopbackEndpoint(endpoint)) {
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
						Effect.mapError((cause) =>
							failure(
								"activate",
								Schema.isSchemaError(cause)
									? `The editor at ${endpoint} returned a window activation result that does not match the contract.`
									: `The window activation request to the editor at ${endpoint} failed.`,
								requestGuidance(cause),
								cause
							)
						)
					);
				if (result.processId !== processId)
					return yield* Effect.fail(
						failure("verify", "The editor process changed during activation.", {
							recovery:
								"Another editor process answered. Reconnect to the editor you meant, then activate again.",
							retrySafe: true,
							nextStep: "reconcile"
						})
					);
				return result;
			})
		});
	})
);

/**
 * Complete test implementation of window activation. The supplied service owns results and typed
 * failures; no editor is contacted and no local foreground permission is granted.
 */
export function makeEditorWindowActivationTestLayer(
	service: EditorWindowActivationApi
): Layer.Layer<EditorWindowActivation> {
	return Layer.succeed(EditorWindowActivation, EditorWindowActivation.of(service));
}

/**
 * Complete test implementation of the local foreground-permission handoff, for hosts that compose
 * `EditorWindowActivationLive` in tests or run on a platform without the supervisor package.
 */
export function makeEditorForegroundPermissionTestLayer(service: {
	readonly grant: (processId: number) => Effect.Effect<void, EditorWindowActivationError>;
}): Layer.Layer<EditorForegroundPermission> {
	return Layer.succeed(EditorForegroundPermission, EditorForegroundPermission.of(service));
}
