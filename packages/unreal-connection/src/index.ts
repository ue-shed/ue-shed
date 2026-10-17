import {
	ErrorCauseFields,
	ErrorGuidanceFields,
	AutomationCsvRequest,
	AutomationInputRequest,
	AutomationPlayersRequest,
	AuthoringActorReferencesRequest,
	AuthoringEndpointError,
	decodeAutomationCsvResult,
	decodeAutomationInputResult,
	decodeAutomationPlayersResult,
	decodeAuthoringActorReferencesResult,
	decodeAuthoringApplyResult,
	decodeAuthoringSaveResult,
	decodeAuthoringTableList,
	decodeAuthoringTableSnapshot,
	decodeCompanionCapabilityManifest,
	decodeEditorAssetLocateResult,
	type AuthoringApplyRequest,
	type AuthoringApplyResult,
	type AuthoringSaveRequest,
	type AuthoringSaveResult,
	type AuthoringTableSnapshot,
	type AutomationCsvResult,
	type AutomationInputResult,
	type AutomationPlayersResult,
	type CompanionCapabilityManifest,
	type EditorAssetLocateResult
} from "@ue-shed/protocol";
import { Effect, Schema } from "effect";
import {
	RemoteControlClient,
	type RemoteControlClientError,
	type RemoteControlClientApi
} from "./remote-control-client.js";

export {
	makeRemoteControlClient,
	makeRemoteControlClientTestLayer,
	RemoteControlClient,
	type RemoteControlClientApi,
	RemoteControlClientError,
	RemoteControlClientLive,
	type RemoteControlRequest
} from "./remote-control-client.js";
export {
	makeSelectedUnrealTarget,
	SelectedUnrealTarget,
	type SelectedUnrealTargetApi,
	selectedUnrealTargetLayer
} from "./selected-target.js";

const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";
const assetNavigationCapability = "editor.asset-navigation.v1";
const requiredCapabilities = [
	"authoring.snapshot.v2",
	"authoring.table-list.v1",
	"authoring.apply.v1",
	"authoring.apply-result.v1",
	"authoring.save.v1"
] as const;

/**
 * A connection, producer refusal or result-contract failure. Stable code and recovery guidance distinguish invalid requests from uncertain editor mutations; cause retains transport or parser evidence.
 */
export class UnrealConnectionError extends Schema.TaggedError<UnrealConnectionError>()(
	"UnrealConnectionError",
	{
		endpoint: Schema.String,
		operation: Schema.String,
		status: Schema.optional(Schema.Number),
		/** Producer refusal code, such as `invalid_request` or `operation_not_found`. */
		code: Schema.optional(Schema.String),
		...ErrorGuidanceFields,
		...ErrorCauseFields
	}
) {}

/**
 * The editor manifest cannot satisfy the requested capability or endpoint contract. Install matching enabled plugins or choose an advertised capability before retrying.
 */
export class UnrealCapabilityError extends Schema.TaggedError<UnrealCapabilityError>()(
	"UnrealCapabilityError",
	{ capability: Schema.String, ...ErrorGuidanceFields }
) {}

/**
 * Negotiated live table authoring port. After an uncertain Apply, use its operation ID with lookupApplyResult before deciding whether to issue another mutation. Saving is a separate explicit operation.
 */
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

/**
 * Negotiated PIE automation port for player inspection, input injection and the owned CSV profiler. Each operation checks its capability and request/result correlation; input injection may change the live editor session.
 */
export interface UnrealAutomationConnection {
	readonly endpoint: string;
	readonly manifest: CompanionCapabilityManifest;
	readonly listPlayers: (
		request: AutomationPlayersRequest
	) => Effect.Effect<AutomationPlayersResult, UnrealConnectionError | UnrealCapabilityError>;
	readonly injectInput: (
		request: AutomationInputRequest
	) => Effect.Effect<AutomationInputResult, UnrealConnectionError | UnrealCapabilityError>;
	readonly csvProfiler: (
		request: AutomationCsvRequest
	) => Effect.Effect<AutomationCsvResult, UnrealConnectionError | UnrealCapabilityError>;
}

function requireCapability(
	manifest: CompanionCapabilityManifest,
	capability: string,
	objectPath: string | undefined
): Effect.Effect<string, UnrealCapabilityError> {
	if (!manifest.capabilities.includes(capability) || !objectPath) {
		return Effect.fail(
			new UnrealCapabilityError({
				capability,
				message: `Connected producer does not advertise ${capability} with an object path.`,
				...missingCapabilityGuidance(capability)
			})
		);
	}
	return Effect.succeed(objectPath);
}

function validateRequest<A, DecodeError>(
	input: A,
	endpoint: string,
	operation: string,
	decode: (value: A) => Effect.Effect<A, DecodeError>
): Effect.Effect<A, UnrealConnectionError> {
	return decode(input).pipe(
		Effect.mapError(
			(cause) =>
				new UnrealConnectionError({
					endpoint,
					operation,
					message: `The ${operation} request does not match its schema.`,
					recovery:
						"Correct the request fields named in the cause's schema issue, then send it again.",
					cause,
					retrySafe: false,
					nextStep: "fix_input"
				})
		),
		Effect.flatMap((request) =>
			new TextEncoder().encode(JSON.stringify(request)).byteLength <= 16384
				? Effect.succeed(request)
				: Effect.fail(
						new UnrealConnectionError({
							endpoint,
							operation,
							message: "Companion requests are limited to 16384 UTF-8 bytes.",
							recovery:
								"Split the request into smaller requests of at most 16384 UTF-8 bytes.",
							retrySafe: false,
							nextStep: "fix_input"
						})
					)
		)
	);
}

const producerContractRecovery =
	"The editor plugin answered outside its contract. Install the UE Shed editor plugin version paired with this host, or report the response.";

const invalidManifestGuidance = {
	recovery:
		"The editor plugin advertised an incomplete capability manifest. Install the UE Shed editor plugin version paired with this host.",
	retrySafe: false,
	nextStep: "escalate"
} as const;

function missingCapabilityGuidance(capability: string) {
	return {
		recovery: `Enable the UE Shed editor plugin that provides ${capability}, restart the editor, then reconnect.`,
		retrySafe: true,
		nextStep: "fix_input"
	} as const;
}

function resultMismatch(endpoint: string, operation: string): UnrealConnectionError {
	return new UnrealConnectionError({
		endpoint,
		operation,
		message: "The producer response does not match the selected target or request limits.",
		recovery: producerContractRecovery,
		retrySafe: false,
		nextStep: "escalate"
	});
}

/** Query one explicitly selected loaded world; partial scans remain visible. */
export const findUnrealActorsReferencingRow = Effect.fn(
	"UnrealConnection.findActorsReferencingRow"
)(function* (options: {
	readonly endpoint: string;
	readonly request: AuthoringActorReferencesRequest;
}) {
	const endpoint = normalizedEndpoint(options.endpoint);
	const operation = "unreal.authoring.actor_references";
	const request = yield* validateRequest(
		options.request,
		endpoint,
		operation,
		Schema.decodeUnknownEffect(AuthoringActorReferencesRequest)
	);
	const client = yield* RemoteControlClient;
	const manifest = yield* decodeResult(
		remoteCall(client, endpoint, coreObjectPath, "GetCapabilityManifest", {}, true),
		endpoint,
		"capability manifest",
		decodeCompanionCapabilityManifest
	);
	const objectPath = yield* requireCapability(
		manifest,
		"authoring.actor-references.v1",
		manifest.authoringObjectPath
	);
	const result = yield* decodeResult(
		remoteCall(
			client,
			endpoint,
			objectPath,
			"FindActorsReferencingRow",
			{
				RequestJson: JSON.stringify(request)
			},
			true
		),
		endpoint,
		operation,
		decodeAuthoringActorReferencesResult
	);
	if (
		result.worldObjectPath !== request.worldObjectPath ||
		result.tableObjectPath !== request.tableObjectPath ||
		result.rowName !== request.rowName ||
		result.scannedActorCount > request.maxActors ||
		result.actorObjectPaths.length > request.maxResults ||
		(result.status === "rejected" && result.isComplete)
	) {
		return yield* Effect.fail(resultMismatch(endpoint, operation));
	}
	return result;
});

/** Optional runtime capabilities negotiate independently; mutation failures are never replay-safe. */
export const connectUnrealAutomation = Effect.fn("UnrealConnection.connectAutomation")(function* (
	configuredEndpoint: string
) {
	const endpoint = normalizedEndpoint(configuredEndpoint);
	const client = yield* RemoteControlClient;
	const manifest = yield* decodeResult(
		remoteCall(client, endpoint, coreObjectPath, "GetCapabilityManifest", {}, true),
		endpoint,
		"capability manifest",
		decodeCompanionCapabilityManifest
	);
	const call = <A, DecodeError>(
		capability: string,
		functionName: string,
		parameters: Schema.JsonObject,
		decode: (input: Schema.Json) => Effect.Effect<A, DecodeError>,
		isMutation: boolean
	) =>
		requireCapability(manifest, capability, manifest.automationObjectPath).pipe(
			Effect.flatMap((objectPath) =>
				decodeResult(
					remoteCall(
						client,
						endpoint,
						objectPath,
						functionName,
						parameters,
						!isMutation
					).pipe(
						Effect.mapError((cause) =>
							isMutation
								? new UnrealConnectionError({
										endpoint: cause.endpoint,
										operation: cause.operation,
										message: cause.message,
										recovery:
											"The change may or may not have reached the editor. Read the current editor state before sending it again.",
										retrySafe: false,
										nextStep: "reconcile",
										...(cause.status === undefined
											? undefined
											: { status: cause.status })
									})
								: cause
						)
					),
					endpoint,
					functionName,
					decode
				)
			)
		);
	const listPlayers = Effect.fn("UnrealAutomation.listPlayers")(function* (
		input: AutomationPlayersRequest
	) {
		const request = yield* validateRequest(
			input,
			endpoint,
			"ListPlayers",
			Schema.decodeUnknownEffect(AutomationPlayersRequest)
		);
		const result = yield* call(
			"automation.players.v1",
			"ListPlayers",
			{ RequestJson: JSON.stringify(request) },
			decodeAutomationPlayersResult,
			false
		);
		if (result.worldObjectPath !== request.worldObjectPath) {
			return yield* Effect.fail(resultMismatch(endpoint, "ListPlayers"));
		}
		return result;
	});
	const injectInput = Effect.fn("UnrealAutomation.injectInput")(function* (
		input: AutomationInputRequest
	) {
		const request = yield* validateRequest(
			input,
			endpoint,
			"InjectInput",
			Schema.decodeUnknownEffect(AutomationInputRequest)
		);
		const result = yield* call(
			"automation.input.v1",
			"InjectInput",
			{ RequestJson: JSON.stringify(request) },
			decodeAutomationInputResult,
			true
		);
		if (
			result.worldObjectPath !== request.worldObjectPath ||
			result.playerControllerObjectPath !== request.playerControllerObjectPath ||
			result.actionObjectPath !== request.actionObjectPath
		) {
			return yield* Effect.fail(resultMismatch(endpoint, "InjectInput"));
		}
		return result;
	});
	const csvProfiler = Effect.fn("UnrealAutomation.csvProfiler")(function* (
		input: AutomationCsvRequest
	) {
		const request = yield* validateRequest(
			input,
			endpoint,
			"CsvProfiler",
			Schema.decodeUnknownEffect(AutomationCsvRequest)
		);
		return yield* call(
			"automation.csv.v1",
			"CsvProfiler",
			{ RequestJson: JSON.stringify(request) },
			decodeAutomationCsvResult,
			request.command !== "status"
		);
	});
	return {
		endpoint,
		manifest,
		listPlayers,
		injectInput,
		csvProfiler
	} satisfies UnrealAutomationConnection;
});

function normalizedEndpoint(endpoint: string): string {
	return endpoint.replace(/\/+$/, "");
}

function connectionError(error: RemoteControlClientError): UnrealConnectionError {
	return new UnrealConnectionError({
		code: error.code,
		cause: error,
		endpoint: error.endpoint,
		message: error.message,
		operation: error.operation,
		recovery: error.recovery,
		retrySafe: error.retrySafe,
		nextStep: error.nextStep,
		...(error.status === undefined ? undefined : { status: error.status })
	});
}

function remoteCall(
	client: RemoteControlClientApi,
	endpoint: string,
	objectPath: string,
	functionName: string,
	parameters: Schema.JsonObject,
	idempotent = false
): Effect.Effect<Schema.Json, UnrealConnectionError> {
	const operation = `remote_control.${functionName}`;
	return client
		.request({ endpoint, functionName, objectPath, operation, parameters, idempotent })
		.pipe(Effect.mapError(connectionError));
}

function decodeResult<A, DecodeError>(
	effect: Effect.Effect<Schema.Json, UnrealConnectionError>,
	endpoint: string,
	operation: string,
	decode: (input: Schema.Json) => Effect.Effect<A, DecodeError>
): Effect.Effect<A, UnrealConnectionError> {
	return effect.pipe(
		Effect.flatMap((input) =>
			decode(input).pipe(
				Effect.mapError(
					(cause) =>
						new UnrealConnectionError({
							endpoint,
							message: `The editor's ${operation} response does not match its schema.`,
							operation,
							cause,
							recovery: producerContractRecovery,
							retrySafe: false,
							nextStep: "escalate"
						})
				)
			)
		)
	);
}

const isAuthoringEndpointError = Schema.is(AuthoringEndpointError);

/** Authoring endpoints answer refusals with `{ status: "error", code }` instead of a result. */
function decodeAuthoringResult<A, DecodeError>(
	effect: Effect.Effect<Schema.Json, UnrealConnectionError>,
	endpoint: string,
	operation: string,
	decode: (input: Schema.Json) => Effect.Effect<A, DecodeError>
): Effect.Effect<A, UnrealConnectionError> {
	const refusalChecked = effect.pipe(
		Effect.flatMap((input) =>
			isAuthoringEndpointError(input)
				? Effect.fail(
						new UnrealConnectionError({
							code: input.code,
							endpoint,
							message: `${operation} refused (${input.code}): ${input.message}`,
							operation,
							// The producer refused before acting. Only a missing table may appear later.
							retrySafe: input.code === "table_not_found",
							...(input.code === "table_not_found"
								? {
										recovery:
											"Refresh the table list; retry once the table exists in the editor.",
										nextStep: "reconcile" as const
									}
								: {
										recovery:
											"The editor refused the request before changing anything. Correct it using the refusal code, then send it again.",
										nextStep: "fix_input" as const
									})
						})
					)
				: Effect.succeed(input)
		)
	);
	return decodeResult(refusalChecked, endpoint, operation, decode);
}

/**
 * Asks a capable connected editor to reveal a top-level asset in its Content Browser. Missing assets return an unavailable result; connection and capability negotiation failures remain typed errors. Does not select a project or launch an editor.
 */
export function locateUnrealAsset(options: {
	readonly bringToFront: boolean;
	readonly endpoint: string;
	readonly objectPath: string;
}): Effect.Effect<
	EditorAssetLocateResult,
	UnrealConnectionError | UnrealCapabilityError,
	RemoteControlClient
> {
	const endpoint = normalizedEndpoint(options.endpoint);
	return Effect.gen(function* () {
		const client = yield* RemoteControlClient;
		const manifest = yield* decodeResult(
			remoteCall(client, endpoint, coreObjectPath, "GetCapabilityManifest", {}, true),
			endpoint,
			"capability manifest",
			decodeCompanionCapabilityManifest
		);
		if (!manifest.capabilities.includes(assetNavigationCapability)) {
			return yield* Effect.fail(
				new UnrealCapabilityError({
					capability: assetNavigationCapability,
					message: `Connected editor does not advertise ${assetNavigationCapability}`,
					...missingCapabilityGuidance(assetNavigationCapability)
				})
			);
		}
		if (!manifest.assetNavigationObjectPath) {
			return yield* Effect.fail(
				new UnrealCapabilityError({
					capability: "editor.asset-navigation.endpoint.v1",
					message: "Connected editor advertises asset navigation without an object path",
					...invalidManifestGuidance
				})
			);
		}
		return yield* decodeResult(
			remoteCall(client, endpoint, manifest.assetNavigationObjectPath, "LocateAsset", {
				BringToFront: options.bringToFront,
				ObjectPath: options.objectPath
			}),
			endpoint,
			"asset location",
			decodeEditorAssetLocateResult
		);
	}).pipe(
		Effect.withSpan("unreal.asset_navigation.locate", {
			attributes: { "unreal.endpoint": endpoint }
		})
	);
}

/**
 * Negotiates all required authoring capabilities and producer limits before returning the live port. Requires a RemoteControlClient layer; does not launch Unreal or change the host's selected project.
 */
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
			remoteCall(client, endpoint, coreObjectPath, "GetCapabilityManifest", {}, true),
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
					message: `Connected editor does not advertise ${missing}`,
					...missingCapabilityGuidance(missing)
				})
			);
		}
		if (!manifest.authoringObjectPath) {
			return yield* Effect.fail(
				new UnrealCapabilityError({
					capability: "authoring.endpoint.v1",
					message:
						"Connected editor advertises authoring capabilities without an object path",
					...invalidManifestGuidance
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
					message: "Connected editor does not advertise valid authoring mutation limits",
					...invalidManifestGuidance
				})
			);
		}
		const authoringObjectPath = manifest.authoringObjectPath;
		const call = (functionName: string, parameters: Schema.JsonObject, idempotent = false) =>
			remoteCall(client, endpoint, authoringObjectPath, functionName, parameters, idempotent);
		return {
			endpoint,
			manifest,
			listTableObjectPaths: () =>
				decodeAuthoringResult(
					call("ListTableObjectPaths", {}, true),
					endpoint,
					"table list",
					decodeAuthoringTableList
				).pipe(Effect.map((result) => result.objectPaths)),
			getTableSnapshot: (objectPath) =>
				decodeAuthoringResult(
					call("GetTableSnapshot", { TableObjectPath: objectPath }, true),
					endpoint,
					"table snapshot",
					decodeAuthoringTableSnapshot
				),
			apply: (request) =>
				decodeAuthoringResult(
					call("Apply", { RequestJson: JSON.stringify(request) }),
					endpoint,
					"Apply",
					decodeAuthoringApplyResult
				),
			lookupApplyResult: (operationId) =>
				decodeAuthoringResult(
					call("LookupApplyResult", { OperationId: operationId }, true),
					endpoint,
					"Apply lookup",
					decodeAuthoringApplyResult
				),
			save: (request) =>
				decodeAuthoringResult(
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

/** Read producer identity and capabilities without requiring a domain plugin. */
export const inspectUnrealProducer = Effect.fn("UnrealConnection.inspectProducer")(function* (
	endpoint: string
) {
	const client = yield* RemoteControlClient;
	return yield* client
		.request({
			endpoint,
			objectPath: coreObjectPath,
			functionName: "GetCapabilityManifest",
			idempotent: true,
			operation: "unreal.producer.inspect",
			parameters: {}
		})
		.pipe(Effect.flatMap(decodeCompanionCapabilityManifest));
});
