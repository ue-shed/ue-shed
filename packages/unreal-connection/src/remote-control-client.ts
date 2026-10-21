import { Config, Context, Duration, Effect, Layer, Schema } from "effect";
import { ErrorCauseFields, ErrorGuidanceFields, type ErrorNextStep } from "@ue-shed/protocol";
import { TransportRequestError, UnrealRC } from "unreal-rc";

const RemoteCallEnvelope = Schema.Struct({ ResultJson: Schema.String });
const decodeRemoteCallEnvelope = Schema.decodeUnknownEffect(RemoteCallEnvelope);

/**
 * Classified HTTP, connection or response-contract failure with endpoint/function context and
 * the original cause. An interrupted or malformed mutation reply can follow an applied change:
 * honor nextStep before sending it again.
 */
export class RemoteControlClientError extends Schema.TaggedError<RemoteControlClientError>()(
	"RemoteControlClientError",
	{
		code: Schema.Literals([
			"transport_failed",
			"http_decode_failed",
			"http_refused",
			"connection_failed",
			"request_timeout",
			"invalid_envelope",
			"invalid_result_json"
		]),
		endpoint: Schema.String,
		functionName: Schema.String,
		operation: Schema.String,
		status: Schema.optional(Schema.Number),
		...ErrorGuidanceFields,
		...ErrorCauseFields
	}
) {}

/**
 * One UFUNCTION call at an explicit editor endpoint. Timeout overrides the client's default;
 * idempotent is an explicit caller guarantee used for recovery guidance. The adapter never
 * retries automatically.
 */
export interface RemoteControlRequest {
	readonly endpoint: string;
	readonly functionName: string;
	readonly objectPath: string;
	readonly operation?: string;
	readonly parameters: Schema.JsonObject;
	readonly timeout?: Duration.Input;
	/** Explicit caller guarantee: repeating this read or idempotent operation has no new effects. Defaults to false. */
	readonly idempotent?: boolean;
}

/**
 * Effect port for one Remote Control call. It validates the ResultJson envelope and JSON
 * result, scopes the upstream HTTP client, and reports expected failures as
 * RemoteControlClientError.
 */
export interface RemoteControlClientApi {
	readonly request: (
		request: RemoteControlRequest
	) => Effect.Effect<Schema.Json, RemoteControlClientError>;
}

/** @deprecated Use `RemoteControlClientApi`. */
export type RemoteControlClientShape = RemoteControlClientApi;

/**
 * Transport service required by live Unreal domain layers. Provide a production or complete
 * test layer; obtaining the service does not start an editor or send a request.
 */
export class RemoteControlClient extends Context.Service<
	RemoteControlClient,
	RemoteControlClientApi
>()("@ue-shed/unreal-connection/RemoteControlClient") {}

const malformedResponseRecovery =
	"The editor returned a malformed response. Install the UE Shed editor plugin version paired with this host, or report the response.";

function normalizedEndpoint(endpoint: string): string {
	return endpoint.replace(/\/+$/, "");
}

function clientError(
	request: RemoteControlRequest,
	fields: {
		readonly code: RemoteControlClientError["code"];
		readonly cause: unknown;
		readonly message: string;
		readonly recovery: string;
		readonly retrySafe: boolean;
		readonly nextStep: ErrorNextStep;
		readonly status?: number;
	}
): RemoteControlClientError {
	return new RemoteControlClientError({
		code: fields.code,
		cause: fields.cause,
		endpoint: normalizedEndpoint(request.endpoint),
		functionName: request.functionName,
		message: fields.message,
		operation: request.operation ?? `remote_control.${request.functionName}`,
		recovery: fields.recovery,
		retrySafe: fields.retrySafe,
		nextStep: fields.nextStep,
		...(fields.status === undefined ? undefined : { status: fields.status })
	});
}

function transportError(request: RemoteControlRequest, cause: unknown): RemoteControlClientError {
	if (!(cause instanceof TransportRequestError)) {
		return clientError(request, {
			code: "transport_failed",
			cause,
			message: `Remote Control could not complete ${request.functionName} at ${request.endpoint}.`,
			recovery:
				request.idempotent === true
					? "Confirm the editor is running with the Remote Control API enabled; report the error if it persists."
					: "The editor outcome is unknown. Inspect current editor state before sending this mutation again; report the transport failure if it persists.",
			retrySafe: request.idempotent === true,
			nextStep: request.idempotent === true ? "escalate" : "reconcile"
		});
	}

	if (cause.kind === "decode") {
		return clientError(request, {
			code: "http_decode_failed",
			cause,
			message: `The editor at ${request.endpoint} returned malformed HTTP JSON for ${request.functionName}.`,
			recovery:
				request.idempotent === true
					? malformedResponseRecovery
					: `The editor may have applied this request. Reconcile its state before sending it again. ${malformedResponseRecovery}`,
			retrySafe: request.idempotent === true,
			nextStep: request.idempotent === true ? "escalate" : "reconcile",
			...(cause.statusCode === undefined ? undefined : { status: cause.statusCode })
		});
	}

	const status = cause.statusCode;
	const transient =
		cause.kind === "connect" ||
		cause.kind === "disconnect" ||
		cause.kind === "timeout" ||
		(status !== undefined && status >= 500);
	return clientError(request, {
		code:
			cause.kind === "timeout"
				? "request_timeout"
				: status !== undefined
					? "http_refused"
					: "connection_failed",
		cause,
		message:
			status === undefined
				? `Remote Control ${request.functionName} at ${request.endpoint} failed (${cause.kind}).`
				: `Remote Control ${request.functionName} at ${request.endpoint} returned HTTP ${status}.`,
		recovery:
			!request.idempotent && transient
				? "The editor may have applied this request. Inspect the current editor state and reconcile the outcome before sending it again."
				: transient
					? "Start the editor with the Remote Control API enabled at this endpoint, wait until it is responsive, then retry."
					: "The editor rejected the call. Check the endpoint, object path and that the UE Shed editor plugin matches this host.",
		retrySafe: request.idempotent === true,
		nextStep: transient ? (request.idempotent === true ? "retry" : "reconcile") : "fix_input",
		...(status === undefined ? undefined : { status })
	});
}

/**
 * Creates the Effect HTTP adapter with an explicit default timeout. Each request scopes its
 * upstream client, validates both JSON boundaries, and disables upstream retries, including for
 * idempotent calls.
 *
 * `passphrase` is sent as Unreal's Remote Control `Passphrase` header, for editors that enforce a
 * passphrase for remote clients. `headers` are added to every request, for example for a proxy in
 * front of the editor; a `Passphrase` entry there wins over `passphrase`. Omit both to keep the
 * transport's defaults.
 */
export function makeRemoteControlClient(options: {
	readonly defaultTimeout: Duration.Input;
	readonly passphrase?: string;
	readonly headers?: Readonly<Record<string, string>>;
}): RemoteControlClientApi {
	const request = Effect.fn("RemoteControlClient.request")(
		function* (request: RemoteControlRequest) {
			const endpoint = normalizedEndpoint(request.endpoint);
			const timeout = request.timeout ?? options.defaultTimeout;
			const response = yield* Effect.scoped(
				Effect.acquireRelease(
					Effect.try({
						try: () =>
							new UnrealRC({
								transport: "http",
								// This adapter validates ResultJson; the upstream schema strips named return fields.
								validateResponses: false,
								http: {
									baseUrl: endpoint,
									requestTimeoutMs: Duration.toMillis(timeout),
									...(options.passphrase === undefined
										? undefined
										: { passphrase: options.passphrase }),
									...(options.headers === undefined
										? undefined
										: { headers: { ...options.headers } })
								},
								retry: false
							}),
						catch: (cause) => transportError(request, cause)
					}),
					(client) => Effect.promise(() => client.dispose().catch(() => undefined))
				).pipe(
					Effect.flatMap((client) =>
						Effect.tryPromise({
							try: () =>
								client.call({
									functionName: request.functionName,
									objectPath: request.objectPath,
									parameters: request.parameters,
									retry: false,
									timeoutMs: Duration.toMillis(timeout),
									transaction: false
								}),
							catch: (cause) => transportError(request, cause)
						})
					)
				)
			);
			const envelope = yield* decodeRemoteCallEnvelope(response).pipe(
				Effect.mapError((cause) =>
					clientError(request, {
						code: "invalid_envelope",
						cause,
						message: `The editor's ${request.functionName} reply has no valid ResultJson envelope.`,
						recovery:
							request.idempotent === true
								? malformedResponseRecovery
								: `The editor may have applied this request. Reconcile its state before sending it again. ${malformedResponseRecovery}`,
						retrySafe: request.idempotent === true,
						nextStep: request.idempotent === true ? "escalate" : "reconcile"
					})
				)
			);
			return yield* Effect.try({
				try: () => Schema.decodeUnknownSync(Schema.Json)(JSON.parse(envelope.ResultJson)),
				catch: (cause) =>
					clientError(request, {
						code: "invalid_result_json",
						cause,
						message: `The ResultJson returned by ${request.functionName} is not valid JSON.`,
						recovery:
							request.idempotent === true
								? malformedResponseRecovery
								: `The editor may have applied this request. Reconcile its state before sending it again. ${malformedResponseRecovery}`,
						retrySafe: request.idempotent === true,
						nextStep: request.idempotent === true ? "escalate" : "reconcile"
					})
			});
		},
		(effect, request) =>
			effect.pipe(
				Effect.withSpan(request.operation ?? `remote_control.${request.functionName}`, {
					attributes: {
						"unreal.endpoint": normalizedEndpoint(request.endpoint),
						"unreal.function": request.functionName
					}
				})
			)
	);

	return RemoteControlClient.of({ request });
}

const defaultTimeout = Config.Duration("UE_SHED_REMOTE_CONTROL_TIMEOUT").pipe(
	Config.withDefault(Duration.seconds(10))
);

/**
 * Production HTTP transport. Reads UE_SHED_REMOTE_CONTROL_TIMEOUT as an Effect duration
 * (default 10 seconds); per-request timeouts override it. Each call owns and disposes its
 * transport resources.
 */
export const RemoteControlClientLive = Layer.effect(
	RemoteControlClient,
	Effect.gen(function* () {
		return makeRemoteControlClient({ defaultTimeout: yield* defaultTimeout });
	})
);

/**
 * Complete test implementation of the request port. The supplied handler owns responses, typed
 * failures and synchronization; no unstubbed production operation is used as a fallback.
 */
export function makeRemoteControlClientTestLayer(
	handle: RemoteControlClientApi["request"]
): Layer.Layer<RemoteControlClient> {
	return Layer.succeed(RemoteControlClient, RemoteControlClient.of({ request: handle }));
}
