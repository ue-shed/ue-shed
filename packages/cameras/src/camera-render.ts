import { ContractParseError } from "@ue-shed/protocol";
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
import {
	RemoteControlClient,
	RemoteControlClientError,
	type RemoteControlClientApi
} from "@ue-shed/unreal-connection";
import {
	decodeCompanionCapabilityManifest,
	ErrorCauseFields,
	ErrorGuidanceFields
} from "@ue-shed/protocol";
import {
	CameraRenderBeginResult,
	CameraRenderCapabilities,
	CameraRenderCapabilitiesV1,
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

/**
 * Rendering capability, policy, session/correlation, artifact or restoration failure with
 * original cause and optional native failure evidence. Lost mutation replies require
 * reconciliation rather than automatic replay.
 */
export class CameraRenderError extends Schema.TaggedError<CameraRenderError>()(
	"CameraRenderError",
	{
		code: Schema.Union([
			CameraRenderFailureCode,
			Schema.Literals([
				"render_connection_failed",
				"render_response_invalid",
				"unsupported_capability",
				"policy_mismatch",
				"session_mismatch",
				"correlation_mismatch",
				"frame_evidence_mismatch",
				"frame_size_mismatch",
				"artifact_identity_mismatch",
				"artifact_outside_staging",
				"artifact_missing",
				"artifact_unreadable",
				"artifact_size_mismatch",
				"artifact_not_png",
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
		...ErrorGuidanceFields,
		...ErrorCauseFields,
		nativeFailure: Schema.optionalKey(CameraRenderFailure)
	}
) {}
const isCameraRenderError = Schema.is(CameraRenderError);

/**
 * Open was refused because another owner holds the editor: a camera set (`authoring_open`) or
 * another render session (`editor_busy`). Nothing was acquired, so retrying after it ends is safe.
 */
export const isEditorOwnershipRejection = (error: CameraRenderError): boolean =>
	error.operation === "open" &&
	(error.code === "authoring_open" || error.code === "editor_busy") &&
	error.nativeFailure?.restoration === "not_acquired";

function renderError(
	operation: CameraRenderError["operation"],
	sessionId: string,
	cause: unknown
): CameraRenderError {
	if (isCameraRenderError(cause)) return cause;
	// Capability and preflight reads hold no editor state; later operations may have acquired it.
	const readOnly = operation === "capabilities" || operation === "preflight";
	if (Schema.isSchemaError(cause) || Schema.is(ContractParseError)(cause))
		return new CameraRenderError({
			code: "render_response_invalid",
			operation,
			sessionId,
			message: `The editor's camera render ${operation} response for session ${sessionId} does not match camera render contract 1.0.`,
			nextStep: readOnly ? "escalate" : "reconcile",
			recovery: readOnly
				? "The editor returned an invalid camera rendering response. Install matching host/plugin versions or report the protocol failure."
				: "Install matching UE Shed Cameras/Core plugins and package, and inspect the native session before retrying.",
			retrySafe: readOnly,
			cause
		});
	return new CameraRenderError({
		code: "render_connection_failed",
		operation,
		sessionId,
		message: `The camera render ${operation} request for session ${sessionId} did not complete against the editor.`,
		nextStep: readOnly
			? Schema.is(RemoteControlClientError)(cause)
				? cause.nextStep
				: "escalate"
			: "reconcile",
		recovery: readOnly
			? Schema.is(RemoteControlClientError)(cause)
				? cause.recovery
				: "The editor returned an invalid camera rendering response. Install matching host/plugin versions or report the protocol failure."
			: "Inspect the existing native operation before retrying. The native lease bounds abandoned ownership.",
		retrySafe: readOnly,
		cause
	});
}
/**
 * Guidance for a failure the plugin reported. Repeating is safe only when nothing was acquired or
 * the operation was a read; a restored capture still produced work, and failed restoration leaves
 * the editor in an unknown state.
 */
function nativeRenderGuidance(
	operation: CameraRenderError["operation"],
	failure: CameraRenderFailure
): Pick<CameraRenderError, "nextStep" | "retrySafe"> {
	const retrySafe =
		failure.restoration !== "failed" &&
		(operation === "capabilities" ||
			operation === "preflight" ||
			failure.restoration === "not_acquired");
	switch (failure.code) {
		case "invalid_policy":
		case "invalid_frame":
		case "invalid_region":
		case "unsupported_policy":
		case "unsupported_size":
		case "editor_required":
		case "map_mismatch":
		case "project_mismatch":
		case "preparation_budget_exceeded":
		case "frame_budget_exceeded":
			return { nextStep: "fix_input", retrySafe };
		case "editor_busy":
		case "authoring_open":
		case "rendering_unavailable":
		case "viewport_unavailable":
		case "viewport_locked":
		case "settling_timeout":
			return { nextStep: retrySafe ? "retry" : "reconcile", retrySafe };
		case "world_changed":
		case "lease_expired":
		case "exposure_unavailable":
		case "cancelled":
		case "session_unknown":
		case "session_closed":
		case "session_conflict":
		case "operation_unknown":
		case "operation_expired":
		case "operation_conflict":
			return { nextStep: "reconcile", retrySafe };
		case "preparation_failed":
		case "capture_failed":
		case "artifact_invalid":
		case "restoration_failed":
			return { nextStep: "escalate", retrySafe };
	}
}
function nativeError(
	operation: CameraRenderError["operation"],
	failure: CameraRenderFailure
): CameraRenderError {
	return new CameraRenderError({
		...failure,
		...nativeRenderGuidance(operation, failure),
		cause: failure,
		operation,
		nativeFailure: failure
	});
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
		message: `The ${operation === "capture" ? "frame" : "session"} request for camera render session ${sessionId} does not match camera render contract 1.0.`,
		recovery: "Correct the request to match camera render contract 1.0 before retrying.",
		retrySafe: true,
		nextStep: "fix_input",
		cause
	});
}
const decode = <S extends Schema.Top, Input>(schema: S, input: Input) =>
	Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" });

/** Older plugins reject unknown renderer fields; report the missing capability instead. */
function unsupportedRendererPolicy(
	request: CameraRenderSessionRequest,
	capabilities: CameraRenderCapabilities,
	operation: "preflight" | "open"
): CameraRenderError | undefined {
	const renderer = request.policy.renderer;
	if (
		renderer.kind === "editor_viewport" &&
		renderer.screenshotWarmupFrames !== undefined &&
		renderer.screenshotWarmupFrames >
			(capabilities.highResolutionScreenshot?.maximumWarmupFrames ?? 0)
	)
		return new CameraRenderError({
			code: "unsupported_capability",
			operation,
			sessionId: request.sessionId,
			message:
				"The connected plugin does not support the requested screenshot warmup frames.",
			recovery:
				"Choose a value within highResolutionScreenshot.maximumWarmupFrames, omit the setting, or install matching Cameras plugins.",
			retrySafe: true,
			nextStep: "fix_input"
		});
	if (renderer.editorPreviews === undefined) return undefined;
	const support = capabilities.editorPreviews;
	if (support?.[renderer.kind === "editor_viewport" ? "viewport" : "sceneCapture"])
		return undefined;
	return new CameraRenderError({
		code: "unsupported_capability",
		operation,
		sessionId: request.sessionId,
		message: `The connected plugin does not support renderer.editorPreviews for ${renderer.kind}.`,
		recovery:
			"Omit renderer.editorPreviews or install a matching UE Shed Cameras plugin that advertises editorPreviews.",
		retrySafe: true,
		nextStep: "fix_input"
	});
}

/**
 * Scope-owned render session with resolved policy, progress stream and correlated frame
 * capture. Its validity ends with the acquisition scope; closing restores temporary editor
 * state.
 */
export interface CameraRenderSession {
	readonly id: CameraRenderSessionId;
	readonly resolvedPolicy: CameraRenderPolicy;
	readonly progress: Stream.Stream<CameraRenderProgress>;
	readonly capture: (
		request: CameraFrameRequest
	) => Effect.Effect<CameraFrameResult, CameraRenderError>;
}
/**
 * Capability/preflight reads and scoped render-session acquisition. An opened session must be
 * kept inside its Scope so success, failure and interruption all trigger restoration.
 */
export interface CameraRendererApi {
	readonly capabilities: () => Effect.Effect<CameraRenderCapabilities, CameraRenderError>;
	readonly preflight: (
		request: CameraRenderSessionRequest
	) => Effect.Effect<CameraRenderPreflight, CameraRenderError>;
	readonly open: (
		request: CameraRenderSessionRequest
	) => Effect.Effect<CameraRenderSession, CameraRenderError, Scope.Scope>;
}
/**
 * Backend-neutral scoped camera rendering port. Host composition supplies transport and
 * endpoint without making Workbench privileged.
 */
export class CameraRenderer extends Context.Service<CameraRenderer, CameraRendererApi>()(
	"@ue-shed/cameras/CameraRenderer"
) {}

/**
 * Provides a camera renderer for an explicit endpoint using RemoteControlClient. Construction
 * does not open a render session or mutate editor state.
 */
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
/**
 * Provides all renderer capability, preflight and session-acquisition behavior explicitly.
 * Tests must model scoped lifecycle and failures rather than falling back to a live editor.
 */
export function cameraRendererTestLayer(api: CameraRendererApi): Layer.Layer<CameraRenderer> {
	return Layer.succeed(CameraRenderer, CameraRenderer.of(api));
}

/**
 * Builds the validated Remote Control renderer, including capability negotiation, correlated
 * polling and artifact identity/PNG checks. Session acquisition attaches close/restoration to
 * the owning scope.
 */
export function makeCameraRenderer(
	client: RemoteControlClientApi,
	endpoint: string
): CameraRendererApi {
	const call = Effect.fn("CameraRenderer.remote")(
		function* (
			operation: CameraRenderError["operation"],
			sessionId: string,
			functionName: string,
			parameters: Record<string, string>
		) {
			return yield* client.request({
				endpoint,
				objectPath: libraryPath,
				functionName,
				parameters,
				operation: `camera.render.${operation}`,
				idempotent: operation === "capabilities" || operation === "preflight",
				timeout: "30 seconds"
			});
		},
		(effect, operation, sessionId) =>
			effect.pipe(Effect.mapError((cause) => renderError(operation, sessionId, cause)))
	);
	const capabilities = Effect.fn("CameraRenderer.capabilities")(function* () {
		const manifest = yield* client
			.request({
				endpoint,
				objectPath: "/Script/UEShedCore.Default__UEShedCoreLibrary",
				functionName: "GetCapabilityManifest",
				idempotent: true,
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
					"Install a matching UE Shed Cameras/Core plugin bundle. Renderer substitution is never automatic.",
				retrySafe: true,
				nextStep: "fix_input"
			});
		const extended = manifest.capabilities.includes("cameras.render-session.capabilities.v2");
		return yield* call(
			"capabilities",
			"none",
			extended ? "GetCameraRenderCapabilitiesV2" : "GetCameraRenderCapabilities",
			{}
		).pipe(
			Effect.flatMap((input) =>
				decode(extended ? CameraRenderCapabilities : CameraRenderCapabilitiesV1, input)
			),
			Effect.mapError((cause) => renderError("capabilities", "none", cause))
		);
	});
	const preflight = Effect.fn("CameraRenderer.preflight")(function* (
		input: CameraRenderSessionRequest
	) {
		const request = yield* decode(CameraRenderSessionRequest, input).pipe(
			Effect.mapError((cause) => inputError("preflight", input.sessionId, cause))
		);
		const unsupported = unsupportedRendererPolicy(request, yield* capabilities(), "preflight");
		if (unsupported) return yield* unsupported;
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
		const unsupported = unsupportedRendererPolicy(request, yield* capabilities(), "open");
		if (unsupported) return yield* unsupported;
		const events = yield* PubSub.sliding<CameraRenderProgress>(32);
		let ownsOrUncertain = true;
		let leaseFailure: CameraRenderError | undefined;
		yield* Effect.addFinalizer(() => PubSub.shutdown(events));
		// Register before Begin: a lost response can still leave native ownership acquired.
		yield* Effect.addFinalizer((exit) =>
			!ownsOrUncertain
				? Effect.void
				: Effect.gen(function* () {
						const value = yield* call("close", request.sessionId, "EndCameraRender", {
							SessionId: request.sessionId
						});
						const result = yield* decode(CameraRenderEndResult, value);
						if (result.status === "failed" && result.code !== "session_unknown")
							return yield* Effect.fail(nativeError("close", result));
					}).pipe(
						Effect.mapError((cause) => renderError("close", request.sessionId, cause)),
						Effect.catchCause((cleanup) =>
							Effect.die(
								new CameraRenderError({
									code: "render_or_restoration_failed",
									operation: "close",
									sessionId: request.sessionId,
									message: `Camera render session ${request.sessionId} did not close cleanly; editor restoration state is unknown.`,
									recovery:
										"Inspect the capture and restoration failures before reusing the editor.",
									retrySafe: false,
									nextStep: "escalate",
									cause: Exit.isFailure(exit)
										? Cause.combine(exit.cause, cleanup)
										: cleanup
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
				recovery: "Update the plugin and host together; inspect the native session.",
				retrySafe: false,
				nextStep: "escalate"
			});
		yield* Effect.gen(function* () {
			yield* Effect.sleep(request.leaseMs / 3);
			const value = yield* call("open", request.sessionId, "BeginCameraRender", {
				RequestJson: JSON.stringify(request)
			});
			const result = yield* decode(CameraRenderBeginResult, value);
			if (result.status === "failed") return yield* Effect.fail(nativeError("open", result));
		}).pipe(
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
					recovery: "Use the session ID returned by open.",
					retrySafe: true,
					nextStep: "fix_input"
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
										recovery: "Inspect the native session before retrying.",
										retrySafe: false,
										nextStep: "reconcile"
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
			if (result.status === "running")
				return yield* Effect.die(
					new Error("Camera polling ended before a terminal status.")
				);
			if (result.status === "failed") return yield* nativeError("capture", result);
			if (
				!isDeepStrictEqual(result.evidence.camera, frame.camera) ||
				!isDeepStrictEqual(result.evidence.policy, request.policy)
			)
				return yield* new CameraRenderError({
					code: "frame_evidence_mismatch",
					operation: "capture",
					sessionId: request.sessionId,
					message: `Frame ${frame.operationId} in session ${request.sessionId} was captured with a different camera or renderer policy than requested.`,
					recovery: "Inspect the capture evidence and matching plugin version.",
					retrySafe: false,
					nextStep: "escalate"
				});
			if (
				result.artifact.width !== frame.size.width ||
				result.artifact.height !== frame.size.height
			)
				return yield* new CameraRenderError({
					code: "frame_size_mismatch",
					operation: "capture",
					sessionId: request.sessionId,
					message: `Frame ${frame.operationId} in session ${request.sessionId} is ${result.artifact.width}x${result.artifact.height}, not the requested ${frame.size.width}x${frame.size.height}.`,
					recovery: "Inspect the capture evidence and matching plugin version.",
					retrySafe: false,
					nextStep: "escalate"
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
	// Scope cleanup can fail alongside capture. Retain the complete cause on the error.
	return yield* new CameraRenderError({
		code: "render_or_restoration_failed",
		operation: "capture",
		sessionId: args.session.sessionId,
		message: `Camera render session ${args.session.sessionId} failed during capture or restoration; editor state is unknown.`,
		recovery: "Inspect both capture and restoration failures before reusing the editor.",
		retrySafe: false,
		nextStep: "escalate",
		cause: outcome.cause
	});
});

type ArtifactFailureCode = Extract<CameraRenderError["code"], `artifact_${string}`>;

const isMissingFile = (cause: unknown): boolean =>
	cause instanceof Error &&
	"code" in cause &&
	(cause.code === "ENOENT" || cause.code === "ENOTDIR");

const maximumArtifactBytes = 512 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const rerenderRecovery =
	"Check the matching local project and contained native staging artifact, then render the frame again.";

/**
 * Read a staged frame after checking, in order: its identity, containment in the project's staging
 * root, file size against the frame, and PNG signature and dimensions. Each check has its own code;
 * the native `artifact_invalid` code stays reserved for failures the plugin reports.
 */
export const readCameraFrameArtifact = Effect.fn("CameraRenderer.readArtifact")(function* (args: {
	readonly projectRoot: string;
	readonly frame: CameraFrameResult;
}) {
	const frame = args.frame;
	const artifact = frame.artifact;
	const subject = `Staged artifact ${artifact.relativePath} for frame ${frame.operationId} in session ${frame.sessionId}`;
	const fail = (
		code: ArtifactFailureCode,
		message: string,
		recovery: string,
		nextStep: CameraRenderError["nextStep"],
		cause?: unknown
	) =>
		new CameraRenderError({
			code,
			operation: "artifact",
			sessionId: frame.sessionId,
			message,
			recovery,
			retrySafe: true,
			nextStep,
			...(cause === undefined ? undefined : { cause })
		});
	const fileSystem = <A>(step: string, run: () => PromiseLike<A>) =>
		Effect.tryPromise({
			try: run,
			catch: (cause) =>
				isMissingFile(cause)
					? fail(
							"artifact_missing",
							`${subject} was not found while ${step}.`,
							"Check that projectRoot is the project the editor rendered into and that the staging artifact was not removed.",
							"fix_input",
							cause
						)
					: fail(
							"artifact_unreadable",
							`${subject} could not be read while ${step}.`,
							"Check permissions and locks on the project's CameraRenderStaging folder, then read the artifact again.",
							"retry",
							cause
						)
		});
	if (artifact.relativePath !== `${frame.sessionId}/${frame.operationId}.png`)
		return yield* fail(
			"artifact_identity_mismatch",
			`${subject} is not named for that session and frame.`,
			"Install matching UE Shed Cameras plugins and package; the editor reported an artifact for another frame.",
			"escalate"
		);
	const project = yield* fileSystem("resolving the project root", () =>
		realpath(args.projectRoot)
	);
	const root = yield* fileSystem("resolving the staging root", () =>
		realpath(resolve(project, "Saved", "UEShed", "CameraRenderStaging"))
	);
	const path = yield* fileSystem("resolving the artifact path", () =>
		realpath(resolve(root, artifact.relativePath))
	);
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
			return yield* fail(
				"artifact_outside_staging",
				`${subject} resolves outside the project's CameraRenderStaging folder.`,
				"Remove links that redirect the staging folder or artifact, then render the frame again.",
				"escalate"
			);
	}
	const info = yield* fileSystem("reading its file metadata", () => stat(path));
	if (!info.isFile())
		return yield* fail(
			"artifact_size_mismatch",
			`${subject} is not a regular file.`,
			rerenderRecovery,
			"escalate"
		);
	if (info.size !== artifact.bytes || info.size > maximumArtifactBytes)
		return yield* fail(
			"artifact_size_mismatch",
			`${subject} is ${info.size} bytes; the editor reported ${artifact.bytes} bytes and the limit is ${maximumArtifactBytes}.`,
			rerenderRecovery,
			"escalate"
		);
	const bytes = yield* fileSystem("reading its contents", () => readFile(path));
	if (
		bytes.length < 33 ||
		!bytes.subarray(0, 8).equals(pngSignature) ||
		bytes.toString("ascii", 12, 16) !== "IHDR" ||
		bytes.readUInt32BE(16) !== artifact.width ||
		bytes.readUInt32BE(20) !== artifact.height
	)
		return yield* fail(
			"artifact_not_png",
			`${subject} is not a ${artifact.width}x${artifact.height} PNG.`,
			rerenderRecovery,
			"escalate"
		);
	return {
		bytes: new Uint8Array(bytes),
		contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
		stagingPath: path
	};
});
