import { contractParser } from "./contract-parser.js";
import { Effect, Schema } from "effect";
import { ErrorCauseFields, ErrorGuidanceFields } from "./error-guidance.js";

/**
 * Identifier categories used in validation failures. These identify toolkit entities, not
 * Unreal package or object paths.
 */
export const IdentifierKind = Schema.Literals([
	"actor",
	"capability",
	"producer",
	"session",
	"world"
]);
export type IdentifierKind = Schema.Schema.Type<typeof IdentifierKind>;

/**
 * An identifier was empty after trimming. The error names its category and original input; its
 * cause retains the schema issue. Supply a non-empty value before retrying.
 */
export class IdentifierValidationError extends Schema.TaggedError<IdentifierValidationError>()(
	"IdentifierValidationError",
	{
		kind: IdentifierKind,
		input: Schema.String,
		...ErrorGuidanceFields,
		...ErrorCauseFields
	}
) {}

const IdentifierString = Schema.Trim.check(Schema.isNonEmpty());

/**
 * Caller-assigned actor identity within an observation/session. Decoding trims surrounding
 * whitespace; it does not resolve an Unreal object path.
 */
export const ActorId = IdentifierString.pipe(Schema.brand("ActorId"));
export type ActorId = Schema.Schema.Type<typeof ActorId>;

/**
 * Stable producer capability name. Trimming and a non-empty check establish the brand; support
 * and version compatibility still require manifest negotiation.
 */
export const CapabilityId = IdentifierString.pipe(Schema.brand("CapabilityId"));
export type CapabilityId = Schema.Schema.Type<typeof CapabilityId>;

/**
 * Identity of the capability producer. Validation does not discover a process or prove that the
 * producer is still available.
 */
export const ProducerId = IdentifierString.pipe(Schema.brand("ProducerId"));
export type ProducerId = Schema.Schema.Type<typeof ProducerId>;

/**
 * Identity for one connection/session lifetime. Hosts must not reuse a session's handles after
 * reconnecting to a different producer session.
 */
export const SessionId = IdentifierString.pipe(Schema.brand("SessionId"));
export type SessionId = Schema.Schema.Type<typeof SessionId>;

/**
 * Caller-assigned world identity within a producer session. This is distinct from a map package
 * name or live World object path.
 */
export const WorldId = IdentifierString.pipe(Schema.brand("WorldId"));
export type WorldId = Schema.Schema.Type<typeof WorldId>;

function identifierError(
	kind: IdentifierKind,
	input: string,
	cause?: unknown
): IdentifierValidationError {
	return new IdentifierValidationError({
		kind,
		input,
		...(cause === undefined ? undefined : { cause }),
		message: `The ${kind} identifier is empty or whitespace.`,
		recovery: `Provide a non-empty ${kind} identifier.`,
		retrySafe: true,
		nextStep: "fix_input"
	});
}

function decodeIdentifier<S extends Schema.ConstraintDecoder<string>>(
	schema: S,
	kind: IdentifierKind,
	input: string
): Effect.Effect<S["Type"], IdentifierValidationError, S["DecodingServices"]> {
	return Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError((cause) => identifierError(kind, input, cause))
	);
}

function createIdentifier<S extends Schema.ConstraintDecoder<string>>(
	schema: S,
	kind: IdentifierKind,
	input: string
): S["Type"] {
	try {
		return Schema.decodeUnknownSync(schema)(input);
	} catch (cause) {
		throw identifierError(kind, input, cause);
	}
}

/**
 * Validates and trims an actor identifier at an untrusted boundary. Empty or whitespace-only
 * input fails with IdentifierValidationError and the original schema cause.
 */
export const decodeActorId = (input: string) => decodeIdentifier(ActorId, "actor", input);
/**
 * Validates and trims an advertised capability identifier at an untrusted boundary. Empty or
 * whitespace-only input fails with IdentifierValidationError and the original schema cause.
 */
export const decodeCapabilityId = (input: string) =>
	decodeIdentifier(CapabilityId, "capability", input);
/**
 * Validates and trims a producer identifier at an untrusted boundary. Empty or whitespace-only
 * input fails with IdentifierValidationError and the original schema cause.
 */
export const decodeProducerId = (input: string) => decodeIdentifier(ProducerId, "producer", input);
/**
 * Validates and trims a connection session identifier at an untrusted boundary. Empty or
 * whitespace-only input fails with IdentifierValidationError and the original schema cause.
 */
export const decodeSessionId = (input: string) => decodeIdentifier(SessionId, "session", input);
/**
 * Validates and trims an observed world identifier at an untrusted boundary. Empty or
 * whitespace-only input fails with IdentifierValidationError and the original schema cause.
 */
export const decodeWorldId = (input: string) => decodeIdentifier(WorldId, "world", input);

/**
 * Synchronous construction of an actor identifier: trims whitespace and throws
 * IdentifierValidationError for an empty value. Prefer the Effect parser at effectful
 * boundaries; this does not generate a new ID.
 */
export function createActorId(input: string): ActorId {
	return createIdentifier(ActorId, "actor", input);
}

/**
 * Synchronous construction of an advertised capability identifier: trims whitespace and throws
 * IdentifierValidationError for an empty value. Prefer the Effect parser at effectful
 * boundaries; this does not generate a new ID.
 */
export function createCapabilityId(input: string): CapabilityId {
	return createIdentifier(CapabilityId, "capability", input);
}

/**
 * Synchronous construction of a producer identifier: trims whitespace and throws
 * IdentifierValidationError for an empty value. Prefer the Effect parser at effectful
 * boundaries; this does not generate a new ID.
 */
export function createProducerId(input: string): ProducerId {
	return createIdentifier(ProducerId, "producer", input);
}

/**
 * Synchronous construction of a connection session identifier: trims whitespace and throws
 * IdentifierValidationError for an empty value. Prefer the Effect parser at effectful
 * boundaries; this does not generate a new ID.
 */
export function createSessionId(input: string): SessionId {
	return createIdentifier(SessionId, "session", input);
}

/**
 * Synchronous construction of an observed world identifier: trims whitespace and throws
 * IdentifierValidationError for an empty value. Prefer the Effect parser at effectful
 * boundaries; this does not generate a new ID.
 */
export function createWorldId(input: string): WorldId {
	return createIdentifier(WorldId, "world", input);
}

/**
 * Non-negative major/minor version of a producer capability. Per-operation wire contracts,
 * including uasset-io, carry their own independent version headers.
 */
export const ProtocolVersion = Schema.Struct({
	major: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export type ProtocolVersion = Schema.Schema.Type<typeof ProtocolVersion>;

/**
 * Current capability-manifest protocol version (0.1), independent of the saved-asset reader's
 * 1.x operation contracts.
 */
export const CURRENT_PROTOCOL_VERSION = ProtocolVersion.make({ major: 0, minor: 1 });

/**
 * Transports a producer can advertise. Advertising a transport does not create a connection or
 * guarantee a domain capability.
 */
export const TransportKind = Schema.Literals([
	"remote-control-http",
	"remote-control-websocket",
	"named-pipe"
]);
export type TransportKind = Schema.Schema.Type<typeof TransportKind>;

/**
 * One advertised capability, its version and supported transports. Hosts negotiate the specific
 * capability before invoking its domain operations.
 */
export const CapabilityDescriptor = Schema.Struct({
	id: CapabilityId,
	version: ProtocolVersion,
	transports: Schema.Array(TransportKind)
});
export type CapabilityDescriptor = Schema.Schema.Type<typeof CapabilityDescriptor>;

/**
 * Producer identity and advertised capabilities for a connection. It is discovery evidence, not
 * authorization or a guarantee that a future request will succeed.
 */
export const CapabilityManifest = Schema.Struct({
	producerId: ProducerId,
	displayName: Schema.String,
	capabilities: Schema.Array(CapabilityDescriptor)
});
export type CapabilityManifest = Schema.Schema.Type<typeof CapabilityManifest>;

/**
 * Connection lifecycle with session identity retained during recovery and termination.
 * Consumers discriminate on status and discard handles from ended sessions.
 */
export const ConnectionState = Schema.Union([
	Schema.Struct({ status: Schema.Literal("disconnected") }),
	Schema.Struct({ status: Schema.Literal("connecting"), endpoint: Schema.String }),
	Schema.Struct({
		status: Schema.Literal("connected"),
		sessionId: SessionId,
		manifest: CapabilityManifest
	}),
	Schema.Struct({
		status: Schema.Literal("recovering"),
		sessionId: SessionId,
		reason: Schema.String
	}),
	Schema.Struct({
		status: Schema.Literal("ended"),
		sessionId: SessionId,
		reason: Schema.Literals(["requested", "producer-exited", "transport-lost"])
	}),
	Schema.Struct({ status: Schema.Literal("error"), message: Schema.String })
]);
export type ConnectionState = Schema.Schema.Type<typeof ConnectionState>;

/**
 * Parses untrusted capability discovery data. A shape or identifier mismatch fails with
 * ContractParseError, preserving the schema issue as its cause.
 */
export const decodeCapabilityManifest = contractParser(CapabilityManifest, "CapabilityManifest");
/**
 * Parses a transported connection lifecycle snapshot. Invalid states fail with
 * ContractParseError; a successfully decoded ended/error state remains an ordinary lifecycle
 * value.
 */
export const decodeConnectionState = contractParser(ConnectionState, "ConnectionState");

export {
	AUTHORING_MUTATION_CONTRACT_VERSION,
	AUTHORING_SAVE_CONTRACT_VERSION,
	AUTHORING_SNAPSHOT_CONTRACT_VERSION,
	AUTHORING_TABLE_LIST_CONTRACT_VERSION,
	AuthoringApplyRequest,
	AuthoringApplyResult,
	AuthoringCommand,
	AuthoringEndpointError,
	type AuthoringEnumOption,
	AuthoringFieldDescriptor,
	AuthoringFieldValue,
	AuthoringOperationError,
	AuthoringRow,
	AuthoringSaveRequest,
	AuthoringSaveResult,
	type AuthoringSnapshotCompatibility,
	AuthoringTableList,
	AuthoringTableSnapshot,
	AuthoringTableSnapshotV1,
	AuthoringTableSnapshotV2,
	AuthoringTextIdentity,
	AuthoringTypeDescriptor,
	AuthoringValue,
	classifyAuthoringSnapshot,
	decodeAuthoringApplyRequest,
	decodeAuthoringApplyResult,
	decodeAuthoringSaveRequest,
	decodeAuthoringSaveResult,
	decodeAuthoringTableList,
	decodeAuthoringTableSnapshot,
	decodeAuthoringValue,
	editAuthoringText,
	makeAuthoringJsonSchema
} from "./authoring.js";
export {
	AuthoringActorReferencesContract,
	AuthoringActorReferencesRequest,
	AuthoringActorReferencesResult,
	decodeAuthoringActorReferencesRequest,
	decodeAuthoringActorReferencesResult
} from "./authoring-actor-references.js";
export {
	GAME_TEXT_ACTIONS_CONTRACT,
	GAME_TEXT_ACTIONS_MAX_ACTIONS,
	GAME_TEXT_ACTIONS_VERSION,
	GameTextAction,
	GameTextActionEdit,
	GameTextActionError,
	GameTextActionErrorCode,
	GameTextActionIdentity,
	GameTextActionNextStep,
	GameTextActionOutcome,
	GameTextActionOutcomeIdentity,
	GameTextActionPlace,
	GameTextActionsRequest,
	GameTextActionsResult
} from "./game-text-actions.js";
export {
	AutomationCsvContract,
	AutomationCsvRequest,
	AutomationCsvResult,
	AutomationError,
	AutomationInputContract,
	AutomationInputRequest,
	AutomationInputResult,
	AutomationInputValue,
	AutomationObjectPath,
	AutomationPlayersContract,
	AutomationPlayersRequest,
	AutomationPlayersResult,
	decodeAutomationCsvRequest,
	decodeAutomationCsvResult,
	decodeAutomationInputRequest,
	decodeAutomationInputResult,
	decodeAutomationPlayersRequest,
	decodeAutomationPlayersResult
} from "./automation.js";
export {
	AuthoringCommandGroupReview,
	AuthoringReviewDiagnostic,
	AuthoringSessionPipeline,
	AuthoringSessionReview,
	AuthoringSessionValidation,
	AuthoringTableChange,
	AuthoringTableReview
} from "./authoring-review.js";
export {
	BlueprintComponentNode,
	BlueprintDefinition,
	BlueprintGraph,
	BlueprintGraphCoverageGap,
	BlueprintGraphDiagnostic,
	BlueprintGraphProjection,
	BlueprintGraphRead,
	BlueprintLink,
	BlueprintMemberReference,
	BlueprintNode,
	BlueprintPin,
	BlueprintPinReference,
	BlueprintPinType,
	BlueprintSavedObject,
	BlueprintTerminalType,
	BlueprintText,
	BlueprintVariable,
	decodeBlueprintGraphProjection
} from "./blueprint-graph.js";
export {
	CompanionCapabilityManifest,
	CompanionProducerIdentity,
	decodeCompanionCapabilityManifest
} from "./companion.js";
export {
	CameraControlFailure,
	CameraDescriptor,
	CameraId,
	CameraScheduleConfig,
	CameraStatus,
	CameraStreamStats,
	decodeCameraScheduleConfig,
	decodeCameraStatus
} from "./cameras.js";
export {
	decodeEditorPlaySessionCommandResponse,
	decodeEditorPlaySessionStateResponse,
	EditorPlaySessionCommand,
	EditorPlaySessionCommandResponse,
	EditorPlaySessionContract,
	EditorPlaySessionId,
	EditorPlaySessionMode,
	EditorPlaySessionState,
	EditorPlaySessionStateResponse,
	makeEditorPlaySessionJsonSchema
} from "./editor-play-session.js";
export {
	decodeEditorWorldOpenRequest,
	decodeEditorWorldOpenResponse,
	EditorWorldControlContract,
	EditorWorldOpenRequest,
	EditorWorldOpenResponse,
	EditorWorldOperation,
	EditorWorldSnapshot,
	EditorWorldState
} from "./editor-world-control.js";
export {
	decodeEditorAssetLocateResult,
	EditorAssetLocateResult,
	EditorAssetLocateUnavailableReason,
	EditorAssetNavigationContract
} from "./editor-asset-navigation.js";
export {
	decodeSavedWorld,
	decodeSavedWorldChoice,
	decodeSavedWorldProgress,
	SavedWorld,
	SavedWorldActor,
	SavedWorldAttachment,
	SavedWorldChoice,
	SavedWorldMap,
	SavedWorldPackageError,
	SavedWorldProgress,
	SavedWorldQuaternion,
	SavedWorldTransform,
	SavedWorldVector
} from "./saved-world.js";
export {
	decodeUAssetIoEvent,
	decodeUAssetIoRequest,
	makeUAssetIoJsonSchema,
	UASSET_IO_PROJECT_INDEX_MAX_DIAGNOSTICS,
	UASSET_IO_PROJECT_INDEX_MAX_PAGE_SIZE,
	UAssetIoContract,
	UAssetIoEvent,
	UAssetIoOperation,
	type UAssetIoOperationKind,
	UAssetIoProjectIndexCount,
	UAssetIoProjectIndexCountResult,
	UAssetIoProjectIndexDiagnostic,
	UAssetIoProjectIndexDictionaryPage,
	UAssetIoProjectIndexFilter,
	UAssetIoProjectIndexHeader,
	UAssetIoProjectIndexItem,
	UAssetIoProjectIndexMap,
	UAssetIoProjectIndexPage,
	UAssetIoProjectIndexQuery,
	UAssetIoProjectIndexStatus,
	UAssetIoProjectIndexSummary,
	UAssetIoRequest,
	UAssetIoResourceLimits,
	UAssetIoResult
} from "./uasset-io.js";
export {
	decodeSavedAssetCatalogInspection,
	decodeSavedAssetInspection,
	isFullScanEntry,
	isHeaderScanEntry,
	PackageHeaderData,
	SavedAssetBlueprintClasses,
	SavedAssetCatalogInspection,
	SavedAssetDecodeError,
	type SavedAssetFullScanEntry,
	SavedAssetGatherCoverage,
	SavedAssetHeader,
	SavedAssetHeaderExport,
	type SavedAssetHeaderScanEntry,
	SavedAssetInspection,
	SavedAssetManifestEntry,
	SavedAssetMissingGatherableText,
	SavedAssetPackageTextEvent,
	SavedAssetPackageTextRecord,
	SavedAssetScan,
	SavedAssetScanEntry,
	SavedAssetScanFailure,
	SavedAssetScanProgress,
	SavedAssetScanSummary,
	SavedAssetTextCoverageGap,
	SavedAssetTextExtractionEvent,
	SavedAssetTextOccurrence,
	SavedAssetTextureExtractionEvent,
	SavedAssetTextureRecord,
	SavedProperty,
	SavedPropertyValue,
	SavedTableCatalog,
	SavedTableCatalogProgress,
	SavedTableDescriptor
} from "./uasset-inspection.js";
export {
	EditorWindowActivationRequest,
	EditorWindowActivationResult
} from "./editor-window-activation.js";
export {
	EDITOR_FOREGROUND_LEASE_LIMITS,
	EditorForegroundLeaseId,
	EditorForegroundLeaseRequest,
	EditorForegroundLeaseResult,
	EditorForegroundLeaseTtlMs,
	EditorForegroundStateRequest,
	EditorForegroundStateResult
} from "./editor-foreground-responsiveness.js";
export {
	LevelSequenceProjection,
	LevelSequenceRead,
	SequenceBinding,
	SequenceBound,
	SequenceCameraCut,
	SequenceDiscreteChannel,
	SequenceGap,
	SequenceNumericChannel,
	SequenceNumericKey,
	SequenceObjectValue,
	SequenceRange,
	SequenceRate,
	SequenceReference,
	SequenceReferenceGap,
	SequenceSection,
	SequenceSectionSettings,
	SequenceTextKey,
	SequenceTrack,
	SequenceValueChannel
} from "./level-sequence.js";
export { ErrorCauseFields, ErrorGuidanceFields, ErrorNextStep } from "./error-guidance.js";

export { makeWireJsonSchemaDocument, canonicalJsonSchemaReferences } from "./json-schema.js";

export {
	encodeGameTextJoinInput,
	GameTextIndexBuildOutcome,
	GameTextIndexBuildRequest,
	GameTextIndexConfiguration,
	GameTextIndexJoinOutcome
} from "./game-text-index.js";

export { ContractParseError, contractParser, contractParserSync } from "./contract-parser.js";
