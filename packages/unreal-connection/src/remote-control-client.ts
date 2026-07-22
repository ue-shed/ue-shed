import { Config, Context, Duration, Effect, Layer, Schema } from "effect";
import { TransportRequestError, UnrealRC } from "unreal-rc";

const RemoteCallEnvelope = Schema.Struct({ ResultJson: Schema.String });
const decodeRemoteCallEnvelope = Schema.decodeUnknownEffect(RemoteCallEnvelope);

export class RemoteControlClientError extends Schema.TaggedErrorClass<RemoteControlClientError>()(
	"RemoteControlClientError",
	{
		endpoint: Schema.String,
		functionName: Schema.String,
		message: Schema.String,
		operation: Schema.String,
		retrySafe: Schema.Boolean,
		status: Schema.optional(Schema.Number)
	}
) {}

export interface RemoteControlRequest {
	readonly endpoint: string;
	readonly functionName: string;
	readonly objectPath: string;
	readonly operation?: string;
	readonly parameters: Readonly<Record<string, unknown>>;
	readonly timeout?: Duration.Input;
}

export interface RemoteControlClientShape {
	readonly request: (
		request: RemoteControlRequest
	) => Effect.Effect<unknown, RemoteControlClientError>;
}

export class RemoteControlClient extends Context.Service<
	RemoteControlClient,
	RemoteControlClientShape
>()("@ue-shed/unreal-connection/RemoteControlClient") {}

function normalizedEndpoint(endpoint: string): string {
	return endpoint.replace(/\/+$/, "");
}

function clientError(
	request: RemoteControlRequest,
	fields: {
		readonly message: string;
		readonly retrySafe: boolean;
		readonly status?: number;
	}
): RemoteControlClientError {
	return new RemoteControlClientError({
		endpoint: normalizedEndpoint(request.endpoint),
		functionName: request.functionName,
		message: fields.message,
		operation: request.operation ?? `remote_control.${request.functionName}`,
		retrySafe: fields.retrySafe,
		...(fields.status === undefined ? {} : { status: fields.status })
	});
}

function transportError(request: RemoteControlRequest, cause: unknown): RemoteControlClientError {
	if (!(cause instanceof TransportRequestError)) {
		return clientError(request, {
			message: `Remote Control transport failed: ${String(cause)}`,
			retrySafe: false
		});
	}

	const status = cause.statusCode;
	const retrySafe =
		cause.kind === "connect" ||
		cause.kind === "disconnect" ||
		cause.kind === "timeout" ||
		(status !== undefined && status >= 500);
	return clientError(request, {
		message:
			status === undefined
				? cause.message
				: `Remote Control returned HTTP ${status}: ${cause.message}`,
		retrySafe,
		...(status === undefined ? {} : { status })
	});
}

export function makeRemoteControlClient(options: {
	readonly defaultTimeout: Duration.Input;
}): RemoteControlClientShape {
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
								http: {
									baseUrl: endpoint,
									requestTimeoutMs: Duration.toMillis(timeout)
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
						message: `Invalid Remote Control envelope: ${String(cause)}`,
						retrySafe: false
					})
				)
			);
			return yield* Effect.try({
				try: () => JSON.parse(envelope.ResultJson) as unknown,
				catch: (cause) =>
					clientError(request, {
						message: `Invalid Remote Control JSON: ${String(cause)}`,
						retrySafe: false
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

const defaultTimeout = Config.duration("UE_SHED_REMOTE_CONTROL_TIMEOUT").pipe(
	Config.withDefault(Duration.seconds(10))
);

export const RemoteControlClientLive = Layer.effect(
	RemoteControlClient,
	Effect.gen(function* () {
		return makeRemoteControlClient({ defaultTimeout: yield* defaultTimeout });
	})
);

export function makeRemoteControlClientTestLayer(
	handle: RemoteControlClientShape["request"]
): Layer.Layer<RemoteControlClient> {
	return Layer.succeed(RemoteControlClient, RemoteControlClient.of({ request: handle }));
}
