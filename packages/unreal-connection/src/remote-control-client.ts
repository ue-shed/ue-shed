import { Config, Context, Duration, Effect, Layer, Schema } from "effect";

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

export function makeRemoteControlClient(options: {
	readonly defaultTimeout: Duration.Input;
	readonly fetch?: typeof globalThis.fetch;
}): RemoteControlClientShape {
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	const request = Effect.fn("RemoteControlClient.request")(
		function* (request: RemoteControlRequest) {
			const endpoint = normalizedEndpoint(request.endpoint);
			const response = yield* Effect.tryPromise({
				try: (signal) =>
					fetchImplementation(`${endpoint}/remote/object/call`, {
						body: JSON.stringify({
							generateTransaction: false,
							functionName: request.functionName,
							objectPath: request.objectPath,
							parameters: request.parameters
						}),
						headers: { "content-type": "application/json" },
						method: "PUT",
						signal
					}),
				catch: (cause) =>
					cause instanceof RemoteControlClientError
						? cause
						: clientError(request, {
								message: String(cause),
								retrySafe: true
							})
			});

			if (!response.ok) {
				const detail = yield* Effect.tryPromise({
					try: () => response.text(),
					catch: (cause) => cause
				}).pipe(Effect.orElseSucceed(() => ""));
				return yield* Effect.fail(
					clientError(request, {
						message: `Remote Control returned HTTP ${response.status}${
							detail.trim() ? `: ${detail.slice(0, 4_096).trim()}` : ""
						}`,
						retrySafe: response.status >= 500,
						status: response.status
					})
				);
			}

			const body = yield* Effect.tryPromise({
				try: async () => (await response.json()) as unknown,
				catch: (cause) =>
					clientError(request, {
						message: `Invalid Remote Control response body: ${String(cause)}`,
						retrySafe: false
					})
			});
			const envelope = yield* decodeRemoteCallEnvelope(body).pipe(
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
				Effect.timeoutOrElse({
					duration: request.timeout ?? options.defaultTimeout,
					orElse: () =>
						Effect.fail(
							clientError(request, {
								message: `Remote Control call timed out after ${Duration.format(
									Duration.fromInputUnsafe(
										request.timeout ?? options.defaultTimeout
									)
								)}`,
								retrySafe: true
							})
						)
				}),
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
