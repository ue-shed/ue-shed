import {
	decodeCompanionCapabilityManifest,
	EDITOR_FOREGROUND_LEASE_LIMITS,
	EditorForegroundLeaseId,
	EditorForegroundLeaseRequest,
	EditorForegroundLeaseResult,
	EditorForegroundStateResult,
	ErrorGuidanceFields,
	type ErrorNextStep
} from "@ue-shed/protocol";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import { Clock, Context, Duration, Effect, Layer, Metric, Ref, Schema, Scope } from "effect";
import { isLoopbackEndpoint } from "./loopback-endpoint.js";

export const EDITOR_FOREGROUND_RESPONSIVENESS_CAPABILITY = "editor.foreground-responsiveness.v1";

export const EditorForegroundResponsivenessFailure = Schema.Literals([
	"remote_endpoint",
	"capability_missing",
	"rejected",
	"unsupported",
	"transport",
	"invalid_response"
]);
export type EditorForegroundResponsivenessFailure =
	typeof EditorForegroundResponsivenessFailure.Type;

export class EditorForegroundResponsivenessError extends Schema.TaggedError<EditorForegroundResponsivenessError>()(
	"EditorForegroundResponsivenessError",
	{
		cause: Schema.optionalKey(Schema.Defect()),
		reason: EditorForegroundResponsivenessFailure,
		operation: Schema.String,
		endpoint: Schema.String,
		...ErrorGuidanceFields
	}
) {}

/** What a held lease is doing now. Only `Held` keeps Unreal responsive. */
export const EditorForegroundLeaseState = Schema.Union([
	Schema.TaggedStruct("Held", {
		editorProcessId: Schema.Int,
		leaseId: EditorForegroundLeaseId,
		ttlMs: Schema.Int
	}),
	/** No lease is believed held; Unreal's normal policy applies while this keeps retrying. */
	Schema.TaggedStruct("Lapsed", {
		failures: Schema.Int,
		reason: Schema.String,
		recovery: Schema.String
	}),
	Schema.TaggedStruct("Released", {})
]);
export type EditorForegroundLeaseState = typeof EditorForegroundLeaseState.Type;

export interface EditorForegroundLease {
	readonly state: Effect.Effect<EditorForegroundLeaseState>;
}

export interface EditorForegroundHoldOptions {
	readonly endpoint: string;
	/** The process whose window being in the foreground should keep Unreal responsive. */
	readonly clientProcessId: number;
	readonly ttlMs?: number;
}

export interface EditorForegroundResponsivenessApi {
	/**
	 * Holds a lease for the life of the scope: acquire now, renew at a third of the TTL, release
	 * when the scope closes. Fails only if the first acquire fails. Later failures never fail the
	 * scope: they log, count, and retry with backoff while Unreal's normal policy applies.
	 */
	readonly hold: (
		options: EditorForegroundHoldOptions
	) => Effect.Effect<EditorForegroundLease, EditorForegroundResponsivenessError, Scope.Scope>;
	/** Diagnostics from the editor: lease count, whether the exemption is in effect, and the setting. */
	readonly state: (
		endpoint: string
	) => Effect.Effect<EditorForegroundStateResult, EditorForegroundResponsivenessError>;
}

export class EditorForegroundResponsiveness extends Context.Service<
	EditorForegroundResponsiveness,
	EditorForegroundResponsivenessApi
>()("@ue-shed/engine/EditorForegroundResponsiveness") {}

const leaseOutcomes = Metric.frequency("ue_shed_editor_foreground_lease_total", {
	description: "Editor foreground lease operations by operation and outcome"
});
const maxBackoffMs = 30_000;

interface Target {
	readonly endpoint: string;
	readonly objectPath: string;
	readonly editorProcessId: number;
}

const failure = (
	endpoint: string,
	operation: string,
	reason: EditorForegroundResponsivenessFailure,
	message: string,
	recovery: string,
	retrySafe: boolean,
	nextStep: ErrorNextStep,
	cause?: unknown
) =>
	new EditorForegroundResponsivenessError({
		endpoint,
		operation,
		reason,
		message,
		recovery,
		retrySafe,
		nextStep,
		...(cause === undefined ? undefined : { cause })
	});

/**
 * A refused acquire grants no lease, so asking again is safe. A full lease table may free up; a
 * replaced editor needs a fresh negotiation, which the next acquire performs.
 */
function rejectedAcquireGuidance(
	reason: string
): Pick<EditorForegroundResponsivenessError, "retrySafe" | "nextStep"> {
	if (reason === "lease_limit") return { retrySafe: true, nextStep: "retry" };
	if (reason === "target_changed") return { retrySafe: true, nextStep: "reconcile" };
	return { retrySafe: false, nextStep: "fix_input" };
}

/** Backoff after consecutive failures: 1 s doubling to 30 s. */
export function editorForegroundBackoffMs(failures: number): number {
	return Math.min(maxBackoffMs, 1_000 * 2 ** Math.max(0, Math.min(failures - 1, 5)));
}

export const EditorForegroundResponsivenessLive = Layer.effect(
	EditorForegroundResponsiveness,
	Effect.gen(function* () {
		const remote = yield* RemoteControlClient;

		const refuseRemote = (endpoint: string, operation: string) =>
			isLoopbackEndpoint(endpoint)
				? Effect.void
				: Effect.fail(
						failure(
							endpoint,
							operation,
							"remote_endpoint",
							"Foreground responsiveness is only offered to an editor on this machine.",
							"Connect to a local editor; a remote editor keeps Unreal's normal policy.",
							false,
							"fix_input"
						)
					);

		const negotiate = Effect.fn("EditorForegroundResponsiveness.negotiate")(function* (
			endpoint: string
		) {
			const manifest = yield* remote
				.request({
					endpoint,
					objectPath: "/Script/UEShedCore.Default__UEShedCoreLibrary",
					functionName: "GetCapabilityManifest",
					idempotent: true,
					operation: "editor.foreground.negotiate",
					parameters: {}
				})
				.pipe(
					Effect.flatMap(decodeCompanionCapabilityManifest),
					Effect.mapError((cause) =>
						failure(
							endpoint,
							"negotiate",
							"transport",
							`Could not read the editor capability manifest.`,
							"Start the editor with UE Shed Core and Remote Control, then retry.",
							true,
							"retry",
							cause
						)
					)
				);
			if (
				!manifest.capabilities.includes(EDITOR_FOREGROUND_RESPONSIVENESS_CAPABILITY) ||
				!manifest.foregroundResponsivenessObjectPath ||
				!manifest.identity
			) {
				return yield* failure(
					endpoint,
					"negotiate",
					"capability_missing",
					"The connected editor does not offer foreground responsiveness.",
					"Update UE Shed Core in the project. The feature is Windows only.",
					false,
					"fix_input"
				);
			}
			return {
				endpoint,
				objectPath: manifest.foregroundResponsivenessObjectPath,
				editorProcessId: manifest.identity.processId
			} satisfies Target;
		});

		const update = (
			target: Target,
			request: EditorForegroundLeaseRequest,
			timeout: Duration.Input
		) =>
			Effect.gen(function* () {
				const json = yield* Effect.gen(function* () {
					const encoded = yield* Schema.encodeEffect(EditorForegroundLeaseRequest)(
						request
					);
					return yield* remote.request({
						endpoint: target.endpoint,
						objectPath: target.objectPath,
						functionName: "UpdateForegroundLease",
						operation: `editor.foreground.${request.operation}`,
						parameters: { RequestJson: JSON.stringify(encoded) },
						timeout
					});
				}).pipe(
					Effect.mapError((cause) =>
						failure(
							target.endpoint,
							request.operation,
							"transport",
							`The ${request.operation} request did not complete.`,
							"Check that the editor is still running; the lease is retried automatically.",
							true,
							"retry",
							cause
						)
					)
				);
				const result = yield* Schema.decodeUnknownEffect(EditorForegroundLeaseResult)(
					json
				).pipe(
					Effect.mapError((cause) =>
						failure(
							target.endpoint,
							request.operation,
							"invalid_response",
							`The editor returned an unrecognised lease result.`,
							"Update UE Shed Core or this client so their contracts match.",
							false,
							"escalate",
							cause
						)
					)
				);
				yield* Metric.update(leaseOutcomes, `${request.operation}:${result.status}`);
				return result;
			}).pipe(
				Effect.tapError(() => Metric.update(leaseOutcomes, `${request.operation}:failed`)),
				Effect.withSpan(`EditorForegroundResponsiveness.${request.operation}`, {
					attributes: { "unreal.endpoint": target.endpoint }
				})
			);

		/** Negotiates and acquires; succeeds only with a granted lease. */
		const acquire = Effect.fn("EditorForegroundResponsiveness.acquire")(function* (
			options: EditorForegroundHoldOptions,
			ttlMs: number
		) {
			const target = yield* negotiate(options.endpoint);
			const result = yield* update(
				target,
				{
					operation: "acquire",
					expectedProcessId: target.editorProcessId,
					clientProcessId: options.clientProcessId,
					ttlMs
				},
				Duration.millis(ttlMs)
			);
			if (result.status === "granted") return { target, result };
			if (result.status === "rejected" || result.status === "unsupported") {
				const guidance =
					result.status === "rejected"
						? rejectedAcquireGuidance(result.reason)
						: ({ retrySafe: false, nextStep: "escalate" } as const);
				return yield* failure(
					options.endpoint,
					"acquire",
					result.status,
					`${result.message} (${result.reason})`,
					result.recovery,
					guidance.retrySafe,
					guidance.nextStep
				);
			}
			return yield* failure(
				options.endpoint,
				"acquire",
				"invalid_response",
				`An acquire returned ${result.status}.`,
				"Update UE Shed Core or this client so their contracts match.",
				false,
				"escalate"
			);
		});

		const hold = Effect.fn("EditorForegroundResponsiveness.hold")(function* (
			options: EditorForegroundHoldOptions
		) {
			yield* refuseRemote(options.endpoint, "acquire");
			const ttlMs = Math.min(
				EDITOR_FOREGROUND_LEASE_LIMITS.maxTtlMs,
				Math.max(
					EDITOR_FOREGROUND_LEASE_LIMITS.minTtlMs,
					Math.round(options.ttlMs ?? EDITOR_FOREGROUND_LEASE_LIMITS.defaultTtlMs)
				)
			);
			const renewEveryMs = Math.floor(ttlMs / 3);
			const first = yield* acquire(options, ttlMs);
			let target = first.target;
			const state = yield* Ref.make<EditorForegroundLeaseState>({
				_tag: "Held",
				editorProcessId: target.editorProcessId,
				leaseId: first.result.leaseId,
				ttlMs: first.result.ttlMs
			});
			let confirmedAt = yield* Clock.currentTimeMillis;
			let failures = 0;

			const lapse = (reason: string, recovery: string) =>
				Ref.set(state, { _tag: "Lapsed", failures, reason, recovery }).pipe(
					Effect.andThen(
						Effect.logInfo("Foreground lease lapsed; Unreal's normal policy applies", {
							endpoint: options.endpoint,
							reason,
							failures
						})
					)
				);

			const reacquire = acquire(options, ttlMs).pipe(
				Effect.tap(({ target: next, result }) =>
					Effect.gen(function* () {
						target = next;
						failures = 0;
						confirmedAt = yield* Clock.currentTimeMillis;
						yield* Ref.set(state, {
							_tag: "Held",
							editorProcessId: next.editorProcessId,
							leaseId: result.leaseId,
							ttlMs: result.ttlMs
						});
					})
				),
				Effect.catch((error) =>
					Effect.gen(function* () {
						failures += 1;
						yield* lapse(error.message, error.recovery);
					})
				)
			);

			const renew = (leaseId: EditorForegroundLeaseId) =>
				update(
					target,
					{
						operation: "renew",
						expectedProcessId: target.editorProcessId,
						clientProcessId: options.clientProcessId,
						leaseId,
						ttlMs
					},
					Duration.millis(renewEveryMs)
				).pipe(
					Effect.flatMap((result) =>
						Effect.gen(function* () {
							if (result.status === "renewed") {
								failures = 0;
								confirmedAt = yield* Clock.currentTimeMillis;
								return;
							}
							// Ended, editor replaced, or contract drift: the lease is gone, so start over.
							yield* Effect.logInfo("Foreground lease ended; acquiring again", {
								endpoint: options.endpoint,
								status: result.status,
								reason: "reason" in result ? result.reason : undefined
							});
							yield* reacquire;
						})
					),
					Effect.catch((error) =>
						Effect.gen(function* () {
							failures += 1;
							yield* Effect.logDebug("Foreground lease renewal failed", {
								endpoint: options.endpoint,
								failures,
								message: error.message
							});
							const now = yield* Clock.currentTimeMillis;
							if (now - confirmedAt >= ttlMs)
								yield* lapse(error.message, error.recovery);
						})
					)
				);

			const maintain = Effect.gen(function* () {
				while (true) {
					yield* Effect.sleep(
						Duration.millis(
							failures === 0 ? renewEveryMs : editorForegroundBackoffMs(failures)
						)
					);
					const current = yield* Ref.get(state);
					// A lapsed lease may still exist in the editor; renewing it first avoids a duplicate.
					if (current._tag === "Held") yield* renew(current.leaseId);
					else yield* reacquire;
				}
			});

			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					const current = yield* Ref.getAndSet(state, { _tag: "Released" });
					if (current._tag !== "Held") return;
					yield* update(
						target,
						{
							operation: "release",
							expectedProcessId: target.editorProcessId,
							clientProcessId: options.clientProcessId,
							leaseId: current.leaseId
						},
						Duration.seconds(2)
					).pipe(
						Effect.catch((error) =>
							Effect.logDebug(
								"Foreground lease release failed; it expires on its own",
								{
									endpoint: options.endpoint,
									message: error.message
								}
							)
						)
					);
				})
			);
			yield* Effect.forkScoped(maintain);
			return { state: Ref.get(state) } satisfies EditorForegroundLease;
		});

		const state = Effect.fn("EditorForegroundResponsiveness.state")(function* (
			endpoint: string
		) {
			yield* refuseRemote(endpoint, "state");
			const target = yield* negotiate(endpoint);
			return yield* remote
				.request({
					endpoint,
					objectPath: target.objectPath,
					functionName: "GetForegroundResponsivenessState",
					idempotent: true,
					operation: "editor.foreground.state",
					parameters: {
						RequestJson: JSON.stringify({ expectedProcessId: target.editorProcessId })
					}
				})
				.pipe(
					Effect.mapError((cause) =>
						failure(
							endpoint,
							"state",
							"transport",
							"The editor foreground state request failed.",
							"Check that the editor is still running.",
							true,
							"retry",
							cause
						)
					),
					Effect.flatMap((json) =>
						Schema.decodeUnknownEffect(EditorForegroundStateResult)(json).pipe(
							Effect.mapError((cause) =>
								failure(
									endpoint,
									"state",
									"invalid_response",
									"The editor foreground state response is invalid.",
									"Update UE Shed Core or this client so their contracts match.",
									false,
									"escalate",
									cause
								)
							)
						)
					)
				);
		});

		return EditorForegroundResponsiveness.of({ hold, state });
	})
);
