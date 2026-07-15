import {
	decodeAuthoringApplyResult,
	decodeAuthoringSaveResult,
	decodeAuthoringTableList,
	decodeAuthoringTableSnapshot,
	decodeCompanionCapabilityManifest,
	type AuthoringApplyRequest,
	type AuthoringApplyResult,
	type AuthoringSaveRequest,
	type AuthoringSaveResult,
	type AuthoringTableSnapshot,
	type CompanionCapabilityManifest
} from "@ue-shed/protocol";
import { Effect, Schema } from "effect";
import {
	RemoteControlClient,
	type RemoteControlClientError,
	type RemoteControlClientShape
} from "./remote-control-client.js";

export * from "./remote-control-client.js";

const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";
const requiredCapabilities = [
	"authoring.snapshot.v2",
	"authoring.table-list.v1",
	"authoring.apply.v1",
	"authoring.apply-result.v1",
	"authoring.save.v1"
] as const;

export class UnrealConnectionError extends Schema.TaggedErrorClass<UnrealConnectionError>()(
	"UnrealConnectionError",
	{
		endpoint: Schema.String,
		operation: Schema.String,
		message: Schema.String,
		retrySafe: Schema.Boolean,
		status: Schema.optional(Schema.Number)
	}
) {}

export class UnrealCapabilityError extends Schema.TaggedErrorClass<UnrealCapabilityError>()(
	"UnrealCapabilityError",
	{ capability: Schema.String, message: Schema.String }
) {}

export interface UnrealAuthoringConnection {
	readonly endpoint: string;
	readonly manifest: CompanionCapabilityManifest;
	readonly listTableObjectPaths: () => Effect.Effect<readonly string[], UnrealConnectionError>;
	readonly getTableSnapshot: (
		objectPath: string
	) => Effect.Effect<AuthoringTableSnapshot, UnrealConnectionError>;
	readonly apply: (
		request: AuthoringApplyRequest
	) => Effect.Effect<AuthoringApplyResult, UnrealConnectionError>;
	readonly lookupApplyResult: (
		operationId: string
	) => Effect.Effect<AuthoringApplyResult, UnrealConnectionError>;
	readonly save: (
		request: AuthoringSaveRequest
	) => Effect.Effect<AuthoringSaveResult, UnrealConnectionError>;
}

function normalizedEndpoint(endpoint: string): string {
	return endpoint.replace(/\/+$/, "");
}

function connectionError(error: RemoteControlClientError): UnrealConnectionError {
	return new UnrealConnectionError({
		endpoint: error.endpoint,
		message: error.message,
		operation: error.operation,
		retrySafe: error.retrySafe,
		...(error.status === undefined ? {} : { status: error.status })
	});
}

function remoteCall(
	client: RemoteControlClientShape,
	endpoint: string,
	objectPath: string,
	functionName: string,
	parameters: Readonly<Record<string, unknown>>
): Effect.Effect<unknown, UnrealConnectionError> {
	const operation = `remote_control.${functionName}`;
	return client
		.request({ endpoint, functionName, objectPath, operation, parameters })
		.pipe(Effect.mapError(connectionError));
}

function decodeResult<A>(
	effect: Effect.Effect<unknown, UnrealConnectionError>,
	endpoint: string,
	operation: string,
	decode: (input: unknown) => Effect.Effect<A, unknown>
): Effect.Effect<A, UnrealConnectionError> {
	return effect.pipe(
		Effect.flatMap((input) =>
			decode(input).pipe(
				Effect.mapError(
					(cause) =>
						new UnrealConnectionError({
							endpoint,
							message: `Invalid ${operation} response: ${String(cause)}`,
							operation,
							retrySafe: false
						})
				)
			)
		)
	);
}

export function connectUnrealAuthoring(
	configuredEndpoint: string
): Effect.Effect<
	UnrealAuthoringConnection,
	UnrealConnectionError | UnrealCapabilityError,
	RemoteControlClient
> {
	const endpoint = normalizedEndpoint(configuredEndpoint);
	return Effect.gen(function* () {
		const client = yield* RemoteControlClient;
		const manifest = yield* decodeResult(
			remoteCall(client, endpoint, coreObjectPath, "GetCapabilityManifest", {}),
			endpoint,
			"capability manifest",
			decodeCompanionCapabilityManifest
		);
		const missing = requiredCapabilities.find(
			(capability) => !manifest.capabilities.includes(capability)
		);
		if (missing) {
			return yield* Effect.fail(
				new UnrealCapabilityError({
					capability: missing,
					message: `Connected editor does not advertise ${missing}`
				})
			);
		}
		if (!manifest.authoringObjectPath) {
			return yield* Effect.fail(
				new UnrealCapabilityError({
					capability: "authoring.endpoint.v1",
					message:
						"Connected editor advertises authoring capabilities without an object path"
				})
			);
		}
		if (
			!manifest.authoringLimits ||
			manifest.authoringLimits.maxCommands < 1 ||
			manifest.authoringLimits.maxPayloadBytes < 1 ||
			manifest.authoringLimits.maxTables < 1
		) {
			return yield* Effect.fail(
				new UnrealCapabilityError({
					capability: "authoring.limits.v1",
					message: "Connected editor does not advertise valid authoring mutation limits"
				})
			);
		}
		const authoringObjectPath = manifest.authoringObjectPath;
		const call = (functionName: string, parameters: Readonly<Record<string, unknown>>) =>
			remoteCall(client, endpoint, authoringObjectPath, functionName, parameters);
		return {
			endpoint,
			manifest,
			listTableObjectPaths: () =>
				decodeResult(
					call("ListTableObjectPaths", {}),
					endpoint,
					"table list",
					decodeAuthoringTableList
				).pipe(Effect.map((result) => result.objectPaths)),
			getTableSnapshot: (objectPath) =>
				decodeResult(
					call("GetTableSnapshot", { TableObjectPath: objectPath }),
					endpoint,
					"table snapshot",
					decodeAuthoringTableSnapshot
				),
			apply: (request) =>
				decodeResult(
					call("Apply", { RequestJson: JSON.stringify(request) }),
					endpoint,
					"Apply",
					decodeAuthoringApplyResult
				),
			lookupApplyResult: (operationId) =>
				decodeResult(
					call("LookupApplyResult", { OperationId: operationId }),
					endpoint,
					"Apply lookup",
					decodeAuthoringApplyResult
				),
			save: (request) =>
				decodeResult(
					call("Save", { RequestJson: JSON.stringify(request) }),
					endpoint,
					"Save",
					decodeAuthoringSaveResult
				)
		} satisfies UnrealAuthoringConnection;
	}).pipe(
		Effect.withSpan("unreal.authoring.connect", {
			attributes: { "unreal.endpoint": endpoint }
		})
	);
}
