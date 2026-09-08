import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	PubSub,
	Schedule,
	Schema,
	Scope,
	Stream
} from "effect";
import { RemoteControlClient, type RemoteControlClientApi } from "@ue-shed/unreal-connection";
import { decodeCompanionCapabilityManifest } from "@ue-shed/protocol";
import {
	CameraRenderBeginResult,
	CameraRenderCapabilities,
	CameraRenderEndResult,
	CameraRenderFailure,
	CameraFrameRequest,
	CameraFrameStatus,
	CameraRenderPreflight,
	CameraRenderFailureCode,
	CameraRenderSessionRequest,
	type CameraFrameResult,
	type CameraRenderPolicy,
	type CameraRenderProgress,
	type CameraRenderSessionId
} from "./camera-render-schema.js";

const libraryPath = "/Script/UEShedCamerasEditor.Default__UEShedCameraRenderingLibrary";

/** Include a caller-owned scene revision: camera equality alone never proves reusable pixels. */
export function cameraRenderReuseIdentity(args: {
	readonly frame: Pick<CameraFrameRequest, "camera" | "size" | "region">;
	readonly policy: CameraRenderPolicy;
	readonly engineVersion: string;
	readonly pluginVersion: string;
	readonly sceneRevision: string;
	readonly workflow: string;
}): string {
	const canonical = <Value>(value: Value): string => {
		if (!(value instanceof Object)) return JSON.stringify(value);
		if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
		return (
			"{" +
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, entry]) => JSON.stringify(key) + ":" + canonical(entry))
				.join(",") +
			"}"
		);
	};
	return `sha256:${createHash("sha256")
		.update(
			canonical({
				rendererContract: "ue-shed-camera-render/1.0",
				...args,
				frame: {
					camera: args.frame.camera,
					size: args.frame.size,
					region: args.frame.region
				}
			})
		)
		.digest("hex")}`;
}

export class CameraRenderError extends Schema.TaggedErrorClass<CameraRenderError>()(
	"CameraRenderError",
	{
		code: Schema.Union([
			CameraRenderFailureCode,
			Schema.Literals([
				"render_connection_failed",
				"unsupported_capability",
				"policy_mismatch",
				"session_mismatch",
				"correlation_mismatch",
				"render_or_restoration_failed",
				"review_render_or_restoration_failed"
			])
		]),
		operation: Schema.Literals([
			"capabilities",
			"preflight",
			"open",
			"capture",
			"close",
			"artifact"
		]),
		sessionId: Schema.String,
		message: Schema.String,
		recovery: Schema.String,
		nativeFailure: Schema.optionalKey(CameraRenderFailure)
	}
) {}

function renderError(
	operation: CameraRenderError["operation"],
	sessionId: string,
	cause: unknown
): CameraRenderError {
	if (cause instanceof CameraRenderError) return cause;
	return new CameraRenderError({
		code: "render_connection_failed",
		operation,
		sessionId,
		message: String(cause),
		recovery:
			"Inspect the existing native operation before retrying. The native lease bounds abandoned ownership."
	});
}
function nativeError(
	operation: CameraRenderError["operation"],
	failure: CameraRenderFailure
): CameraRenderError {
	return new CameraRenderError({ ...failure, operation, nativeFailure: failure });
}
function inputError(
	operation: "preflight" | "open" | "capture",
	sessionId: string,
	cause: unknown
) {
	return new CameraRenderError({
		code: operation === "capture" ? "invalid_frame" : "invalid_policy",
		operation,
		sessionId,
		message: String(cause),
		recovery: "Correct the request to match camera render contract 1.0 before retrying."
	});
}
const decode = <S extends Schema.Top, Input>(schema: S, input: Input) =>
	Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" });

export interface CameraRenderSession {
	readonly id: CameraRenderSessionId;
	readonly resolvedPolicy: CameraRenderPolicy;
	readonly progress: Stream.Stream<CameraRenderProgress>;
	readonly capture: (
		request: CameraFrameRequest
	) => Effect.Effect<CameraFrameResult, CameraRenderError>;
}
export interface CameraRendererApi {
	readonly capabilities: () => Effect.Effect<CameraRenderCapabilities, CameraRenderError>;
	readonly preflight: (
		request: CameraRenderSessionRequest
	) => Effect.Effect<CameraRenderPreflight, CameraRenderError>;
	readonly open: (
		request: CameraRenderSessionRequest
	) => Effect.Effect<CameraRenderSession, CameraRenderError, Scope.Scope>;
}
export class CameraRenderer extends Context.Service<CameraRenderer, CameraRendererApi>()(
	"@ue-shed/cameras/CameraRenderer"
) {}

export function cameraRendererLayer(
	endpoint: string
): Layer.Layer<CameraRenderer, never, RemoteControlClient> {
	return Layer.effect(
		CameraRenderer,
		Effect.gen(function* () {
			const client = yield* RemoteControlClient;
			return makeCameraRenderer(client, endpoint);
		})
	);
}
export function cameraRendererTestLayer(api: CameraRendererApi): Layer.Layer<CameraRenderer> {
	return Layer.succeed(CameraRenderer, CameraRenderer.of(api));
}

export function makeCameraRenderer(
	client: RemoteControlClientApi,
	endpoint: string
): CameraRendererApi {
	const call = Effect.fn("CameraRenderer.remote")(function* (
		operation: CameraRenderError["operation"],
		sessionId: string,
		functionName: string,
		parameters: Record<string, string>
	) {
		return yield* client
			.request({
				endpoint,
				objectPath: libraryPath,
				functionName,
				parameters,
				operation: `camera.render.${operation}`,
				timeout: "30 seconds"
			})
			.pipe(Effect.mapError((cause) => renderError(operation, sessionId, cause)));
	});
	const capabilities = Effect.fn("CameraRenderer.capabilities")(function* () {
		const manifest = yield* client
			.request({
				endpoint,
				objectPath: "/Script/UEShedCore.Default__UEShedCoreLibrary",
				functionName: "GetCapabilityManifest",
				parameters: {},
				operation: "camera.render.negotiate"
			})
			.pipe(
				Effect.flatMap(decodeCompanionCapabilityManifest),
				Effect.mapError((cause) => renderError("capabilities", "none", cause))
			);
		if (!manifest.capabilities.includes("cameras.render-session.v1"))
			return yield* new CameraRenderError({
				code: "unsupported_capability",
				operation: "capabilities",
				sessionId: "none",
				message: "The connected plugin does not provide shared camera rendering.",
				recovery:
					"Install a matching UE Shed Cameras/Core plugin bundle. Renderer substitution is never automatic."
			});
		return yield* call("capabilities", "none", "GetCameraRenderCapabilities", {}).pipe(
			Effect.flatMap((input) => decode(CameraRenderCapabilities, input)),
			Effect.mapError((cause) => renderError("capabilities", "none", cause))
		);
	});
	const preflight = Effect.fn("CameraRenderer.preflight")(function* (
		input: CameraRenderSessionRequest
	) {
		const request = yield* decode(CameraRenderSessionRequest, input).pipe(
			Effect.mapError((cause) => inputError("preflight", input.sessionId, cause))
		);
		yield* capabilities();
		return yield* call("preflight", request.sessionId, "PreflightCameraRender", {
			RequestJson: JSON.stringify(request)
		}).pipe(
			Effect.flatMap((value) => decode(CameraRenderPreflight, value)),
			Effect.mapError((cause) => renderError("preflight", request.sessionId, cause))
		);
	});
	const open = Effect.fn("CameraRenderer.open")(function* (input: CameraRenderSessionRequest) {
		const request = yield* decode(CameraRenderSessionRequest, input).pipe(
			Effect.mapError((cause) => inputError("open", input.sessionId, cause))
		);
		yield* capabilities();
		const events = yield* PubSub.sliding<CameraRenderProgress>(32);
		let ownsOrUncertain = true;
		let leaseFailure: CameraRenderError | undefined;
		yield* Effect.addFinalizer(() => PubSub.shutdown(events));
		// Register before Begin: a lost response can still leave native ownership acquired.
		yield* Effect.addFinalizer((exit) =>
			!ownsOrUncertain
				? Effect.void
				: call("close", request.sessionId, "EndCameraRender", {
						SessionId: request.sessionId
					}).pipe(
						Effect.flatMap((value) => decode(CameraRenderEndResult, value)),
						Effect.flatMap((result) =>
							result.status === "failed" && result.code !== "session_unknown"
								? Effect.fail(nativeError("close", result))
								: Effect.void
						),
						Effect.mapError((cause) => renderError("close", request.sessionId, cause)),
						Effect.catchCause((cleanup) =>
							Effect.die(
								new CameraRenderError({
									code: "render_or_restoration_failed",
									operation: "close",
									sessionId: request.sessionId,
									message: Cause.pretty(
										Exit.isFailure(exit)
											? Cause.combine(exit.cause, cleanup)
											: cleanup
									),
									recovery:
										"Inspect the capture and restoration failures before reusing the editor."
								})
							)
						)
					)
		);
		const opened = yield* call("open", request.sessionId, "BeginCameraRender", {
			RequestJson: JSON.stringify(request)
		}).pipe(
			Effect.flatMap((value) => decode(CameraRenderBeginResult, value)),
			Effect.mapError((cause) => renderError("open", request.sessionId, cause))
		);
		if (opened.status === "failed") {
			ownsOrUncertain = false;
			return yield* nativeError("open", opened);
		}
		if (
			opened.sessionId !== request.sessionId ||
			!isDeepStrictEqual(opened.resolvedPolicy, request.policy)
		)
			return yield* new CameraRenderError({
				code: "policy_mismatch",
				operation: "open",
				sessionId: request.sessionId,
				message: "The editor returned a different session or renderer policy.",
				recovery: "Update the plugin and host together; inspect the native session."
			});
		yield* Effect.sleep(request.leaseMs / 3).pipe(
			Effect.andThen(
				call("open", request.sessionId, "BeginCameraRender", {
					RequestJson: JSON.stringify(request)
				})
			),
			Effect.flatMap((value) => decode(CameraRenderBeginResult, value)),
			Effect.flatMap((result) =>
				result.status === "failed" ? Effect.fail(nativeError("open", result)) : Effect.void
			),
			Effect.repeat(Schedule.forever),
			Effect.catch((cause) =>
				Effect.sync(() => {
					leaseFailure = renderError("open", request.sessionId, cause);
				})
			),
			Effect.forkScoped
		);
		const capture = Effect.fn("CameraRenderSession.capture")(function* (
			input: CameraFrameRequest
		) {
			if (leaseFailure) return yield* leaseFailure;
			const frame = yield* decode(CameraFrameRequest, input).pipe(
				Effect.mapError((cause) => inputError("capture", request.sessionId, cause))
			);
			if (frame.sessionId !== request.sessionId)
				return yield* new CameraRenderError({
					code: "session_mismatch",
					operation: "capture",
					sessionId: request.sessionId,
					message: "The frame belongs to another session.",
					recovery: "Use the session ID returned by open."
				});
			const decodeStatus = (value: Schema.Json) =>
				decode(CameraFrameStatus, value).pipe(
					Effect.flatMap((status) =>
						status.sessionId === request.sessionId &&
						((status.status === "failed" && status.operationId === undefined) ||
							status.operationId === frame.operationId)
							? Effect.succeed(status)
							: Effect.fail(
									new CameraRenderError({
										code: "correlation_mismatch",
										operation: "capture",
										sessionId: request.sessionId,
										message: "The frame response belongs to another operation.",
										recovery: "Inspect the native session before retrying."
									})
								)
					),
					Effect.mapError((cause) => renderError("capture", request.sessionId, cause)),
					Effect.tap((status) =>
						status.status === "running" ? PubSub.publish(events, status) : Effect.void
					)
				);
			// Start is issued once. A transport failure is reconciled by polling this operation.
			const first = yield* call("capture", request.sessionId, "StartCameraFrame", {
				RequestJson: JSON.stringify(frame)
			}).pipe(
				Effect.catch(() =>
					call("capture", request.sessionId, "PollCameraFrame", {
						SessionId: request.sessionId,
						OperationId: frame.operationId
					})
				),
				Effect.flatMap(decodeStatus)
			);
			const result =
				first.status !== "running"
					? first
					: yield* call("capture", request.sessionId, "PollCameraFrame", {
							SessionId: request.sessionId,
							OperationId: frame.operationId
						}).pipe(
							Effect.flatMap(decodeStatus),
							Effect.repeat({
								schedule: Schedule.spaced("100 millis"),
								while: (status) => status.status === "running"
							}),
							Effect.timeout(request.policy.settling.timeoutMs + 30000),
							Effect.mapError((cause) =>
								renderError("capture", request.sessionId, cause)
							)
						);
			if (result.status === "failed") return yield* nativeError("capture", result);
			if (
				!isDeepStrictEqual(result.evidence.camera, frame.camera) ||
				!isDeepStrictEqual(result.evidence.policy, request.policy) ||
				result.artifact.width !== frame.size.width ||
				result.artifact.height !== frame.size.height
			)
				return yield* new CameraRenderError({
					code: "artifact_invalid",
					operation: "capture",
					sessionId: request.sessionId,
					message:
						"The effective camera, policy or output dimensions differ from the requested frame.",
					recovery: "Inspect the capture evidence and matching plugin version."
				});
			return result;
		});
		return {
			id: opened.sessionId,
			resolvedPolicy: opened.resolvedPolicy,
			capture,
			progress: Stream.fromPubSub(events)
		} satisfies CameraRenderSession;
	});
	return CameraRenderer.of({ capabilities, preflight, open });
}

/** Same scoped session implementation, including native restoration before returning success. */
export const renderCamera = Effect.fn("CameraRenderer.renderCamera")(function* (args: {
	readonly session: CameraRenderSessionRequest;
	readonly frame: CameraFrameRequest;
}) {
	const outcome = yield* Effect.exit(
		Effect.scoped(
			Effect.gen(function* () {
				const renderer = yield* CameraRenderer;
				const session = yield* renderer.open(args.session);
				return yield* session.capture(args.frame);
			})
		)
	);
	if (Exit.isSuccess(outcome)) return outcome.value;
	if (Cause.hasInterrupts(outcome.cause)) return yield* Effect.failCause(outcome.cause);
	const failure = Cause.findErrorOption(outcome.cause);
	if (!Cause.hasDies(outcome.cause) && Option.isSome(failure)) return yield* failure.value;
	// Scope cleanup can fail alongside capture. Retain the complete cause in the error message.
	return yield* new CameraRenderError({
		code: "render_or_restoration_failed",
		operation: "capture",
		sessionId: args.session.sessionId,
		message: Cause.pretty(outcome.cause),
		recovery: "Inspect both capture and restoration failures before reusing the editor."
	});
});

export const readCameraFrameArtifact = Effect.fn("CameraRenderer.readArtifact")(function* (args: {
	readonly projectRoot: string;
	readonly frame: CameraFrameResult;
}) {
	return yield* Effect.tryPromise({
		try: async () => {
			const frame = args.frame;
			if (frame.artifact.relativePath !== `${frame.sessionId}/${frame.operationId}.png`)
				throw new Error("Artifact identity does not match the frame.");
			const project = await realpath(args.projectRoot);
			const root = await realpath(resolve(project, "Saved", "UEShed", "CameraRenderStaging"));
			const path = await realpath(resolve(root, frame.artifact.relativePath));
			for (const [parent, child] of [
				[project, root],
				[root, path]
			] as const) {
				const local = relative(parent, child);
				if (
					local === ".." ||
					local.startsWith("../") ||
					local.startsWith("..\\") ||
					isAbsolute(local)
				)
					throw new Error("Artifact escapes the authorized staging root.");
			}
			const info = await stat(path);
			if (
				!info.isFile() ||
				info.size !== frame.artifact.bytes ||
				info.size > 512 * 1024 * 1024
			)
				throw new Error("Staged artifact size is invalid.");
			const bytes = await readFile(path);
			if (
				bytes.length < 33 ||
				!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
				bytes.toString("ascii", 12, 16) !== "IHDR" ||
				bytes.readUInt32BE(16) !== frame.artifact.width ||
				bytes.readUInt32BE(20) !== frame.artifact.height
			)
				throw new Error("Staged PNG dimensions or signature are invalid.");
			return {
				bytes: new Uint8Array(bytes),
				contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
				stagingPath: path
			};
		},
		catch: (cause) =>
			new CameraRenderError({
				code: "artifact_invalid",
				operation: "artifact",
				sessionId: args.frame.sessionId,
				message: String(cause),
				recovery: "Check the matching local project and contained native staging artifact."
			})
	});
});
