import { ErrorGuidanceFields } from "@ue-shed/protocol/errors";
import { contractParser } from "@ue-shed/protocol";
import { Schema } from "effect";
import { CoActivationSet, CoActivationSourceStatus } from "./coactivation.js";
import { InputPlatformView } from "./platforms.js";

export const InputObjectPath = Schema.String.pipe(Schema.brand("InputObjectPath"));
export type InputObjectPath = Schema.Schema.Type<typeof InputObjectPath>;
export const makeInputObjectPath = InputObjectPath.make;

export const EvidenceUnavailableReason = Schema.Literals([
	"not_serialized",
	"wrong_value_kind",
	"not_an_input_action",
	"not_a_mapping_context",
	/** The saved value names an instanced subobject that is not an export of the same package. */
	"unresolved_reference"
]);
export type EvidenceUnavailableReason = Schema.Schema.Type<typeof EvidenceUnavailableReason>;

export const Evidence = <S extends Schema.Top>(value: S) =>
	Schema.Union([
		Schema.Struct({
			status: Schema.Literal("available"),
			source: Schema.Literal("serialized"),
			value
		}),
		Schema.Struct({
			status: Schema.Literal("unavailable"),
			reason: EvidenceUnavailableReason
		})
	]);

export const StringEvidence = Evidence(Schema.String);
export const BooleanEvidence = Evidence(Schema.Boolean);
export const IntegerEvidence = Evidence(Schema.Int);

/**
 * One saved property of a trigger or modifier subobject. Structs and arrays flatten into dotted
 * and indexed names (`ComboActions[0].ComboStepAction`), so a combo step is as visible as a chord.
 * Only serialized overrides appear: a parameter left at the engine's class default is absent.
 */
export const InputObjectParameter = Schema.Union([
	Schema.Struct({ name: Schema.String, kind: Schema.Literal("bool"), value: Schema.Boolean }),
	Schema.Struct({
		name: Schema.String,
		kind: Schema.Literal("number"),
		value: Schema.NullOr(Schema.Number)
	}),
	Schema.Struct({ name: Schema.String, kind: Schema.Literal("string"), value: Schema.String }),
	/** An object reference. A trigger's `ChordAction` is an action-to-action edge. */
	Schema.Struct({
		name: Schema.String,
		kind: Schema.Literal("object"),
		value: Schema.NullOr(Schema.String)
	}),
	Schema.Struct({
		name: Schema.String,
		kind: Schema.Literal("vector"),
		x: Schema.NullOr(Schema.Number),
		y: Schema.NullOr(Schema.Number),
		z: Schema.NullOr(Schema.Number)
	}),
	/** Saved, but in a value shape this projection does not flatten; the kind names it. */
	Schema.Struct({
		name: Schema.String,
		kind: Schema.Literal("unsupported"),
		valueKind: Schema.String
	})
]);
export type InputObjectParameter = Schema.Schema.Type<typeof InputObjectParameter>;

export const InputInstancedObjectRef = Schema.Struct({
	objectPath: Schema.String,
	classPath: Schema.optional(Schema.String),
	/**
	 * Schema 2. Saved properties of the subobject when it is an export of the same package.
	 * Absent when the subobject could not be resolved or the report predates schema 2.
	 */
	parameters: Schema.optionalKey(Schema.Array(InputObjectParameter))
});
export type InputInstancedObjectRef = Schema.Schema.Type<typeof InputInstancedObjectRef>;

/**
 * `UPlayerMappableKeySettings`, the instanced settings object an action or an overriding mapping
 * carries. Earlier engine releases saved different mappable-key properties, so each field is
 * evidence on its own.
 */
export const PlayerMappableKeySettingsRecord = Schema.Struct({
	objectPath: Schema.String,
	classPath: Schema.optional(Schema.String),
	name: StringEvidence,
	displayName: StringEvidence,
	displayCategory: StringEvidence,
	supportedKeyProfileIds: Evidence(Schema.Array(Schema.String))
});
export type PlayerMappableKeySettingsRecord = Schema.Schema.Type<
	typeof PlayerMappableKeySettingsRecord
>;
export const PlayerMappableKeySettingsEvidence = Evidence(PlayerMappableKeySettingsRecord);

export const InputActionRecord = Schema.Struct({
	objectPath: InputObjectPath,
	classPath: Schema.String,
	packageFile: Schema.String,
	actionDescription: StringEvidence,
	valueType: StringEvidence,
	consumeInput: BooleanEvidence,
	// Schema 2 fields. Optional so schema 1 reports still decode.
	triggerWhenPaused: Schema.optionalKey(BooleanEvidence),
	consumesActionAndAxisMappings: Schema.optionalKey(BooleanEvidence),
	reserveAllMappings: Schema.optionalKey(BooleanEvidence),
	/** The saved `ETriggerEvent` bitmask, as Unreal stores it. */
	triggerEventsThatConsumeLegacyKeys: Schema.optionalKey(IntegerEvidence),
	accumulationBehavior: Schema.optionalKey(StringEvidence),
	/** Action-level triggers, which apply to every mapping of this action. */
	triggers: Schema.optionalKey(Schema.Array(InputInstancedObjectRef)),
	modifiers: Schema.optionalKey(Schema.Array(InputInstancedObjectRef)),
	playerMappableKeySettings: Schema.optionalKey(PlayerMappableKeySettingsEvidence)
});
export type InputActionRecord = Schema.Schema.Type<typeof InputActionRecord>;

export const InputMappingRecord = Schema.Struct({
	action: Schema.NullOr(Schema.String),
	keyName: StringEvidence,
	triggers: Schema.Array(InputInstancedObjectRef),
	modifiers: Schema.Array(InputInstancedObjectRef),
	/** Schema 2. `EPlayerMappableKeySettingBehaviors`, as saved. */
	settingBehavior: Schema.optionalKey(StringEvidence),
	/** Schema 2. The mapping's own settings, used when its behaviour overrides the action's. */
	playerMappableKeySettings: Schema.optionalKey(PlayerMappableKeySettingsEvidence)
});
export type InputMappingRecord = Schema.Schema.Type<typeof InputMappingRecord>;

export const InputMappingsProperty = Schema.Literals(["Mappings", "DefaultKeyMappings"]);
export type InputMappingsProperty = Schema.Schema.Type<typeof InputMappingsProperty>;

/** One `MappingProfileOverrides` entry: the mappings a key profile uses instead of the defaults. */
export const InputMappingProfileOverride = Schema.Struct({
	profileId: Schema.String,
	mappings: Schema.Array(InputMappingRecord)
});
export type InputMappingProfileOverride = Schema.Schema.Type<typeof InputMappingProfileOverride>;

/** A saved `FGameplayTagQuery`: the tags it names and its descriptions. Never evaluated. */
export const InputModeQuery = Schema.Struct({
	tags: Schema.Array(Schema.String),
	userDescription: Schema.optionalKey(Schema.String),
	autoDescription: Schema.optionalKey(Schema.String)
});
export type InputModeQuery = Schema.Schema.Type<typeof InputModeQuery>;

export const InputMappingContextRecord = Schema.Struct({
	objectPath: InputObjectPath,
	classPath: Schema.String,
	packageFile: Schema.String,
	contextDescription: StringEvidence,
	mappingsProperty: Schema.NullOr(InputMappingsProperty),
	mappings: Schema.Array(InputMappingRecord),
	exports: Schema.Array(
		Schema.Struct({
			objectPath: Schema.String,
			classPath: Schema.String
		})
	),
	// Schema 2 fields. Optional so schema 1 reports still decode.
	profileOverrides: Schema.optionalKey(Schema.Array(InputMappingProfileOverride)),
	inputModeFilterOptions: Schema.optionalKey(StringEvidence),
	inputModeQueryOverride: Schema.optionalKey(Evidence(InputModeQuery)),
	registrationTrackingMode: Schema.optionalKey(StringEvidence)
});
export type InputMappingContextRecord = Schema.Schema.Type<typeof InputMappingContextRecord>;

/** One `Contexts` entry of a config asset: a mapping context and the priority it is added with. */
export const PlayerMappableConfigContext = Schema.Struct({
	context: Schema.NullOr(Schema.String),
	priority: Schema.Int
});
export type PlayerMappableConfigContext = Schema.Schema.Type<typeof PlayerMappableConfigContext>;

/**
 * A `PlayerMappableInputConfig` asset (deprecated by Unreal in 5.3, still loadable). Its contexts
 * and priorities are one source of co-activation evidence.
 */
export const PlayerMappableConfigRecord = Schema.Struct({
	objectPath: InputObjectPath,
	classPath: Schema.String,
	packageFile: Schema.String,
	configName: StringEvidence,
	displayName: StringEvidence,
	deprecated: BooleanEvidence,
	contexts: Evidence(Schema.Array(PlayerMappableConfigContext))
});
export type PlayerMappableConfigRecord = Schema.Schema.Type<typeof PlayerMappableConfigRecord>;

export const EnhancedInputDiagnostic = Schema.Struct({
	code: Schema.Literals([
		"package_inspection_failed",
		"package_partially_decoded",
		"unsupported_asset"
	]),
	message: Schema.String,
	packageFile: Schema.String,
	objectPath: Schema.optional(Schema.String)
});
export type EnhancedInputDiagnostic = Schema.Schema.Type<typeof EnhancedInputDiagnostic>;

/** The schema version a current scan writes. Schema 1 reports remain readable. */
export const ENHANCED_INPUT_REPORT_SCHEMA_VERSION = 2;

export const EnhancedInputReport = Schema.Struct({
	schemaVersion: Schema.Literals([1, 2]),
	status: Schema.Literals(["complete", "partial"]),
	coverage: Schema.Struct({
		discoveredPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		inspectedPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		partialPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		failedPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		inputActions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		mappingContexts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		playerMappableConfigs: Schema.optionalKey(
			Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		)
	}),
	actions: Schema.Array(InputActionRecord),
	mappingContexts: Schema.Array(InputMappingContextRecord),
	/** Schema 2. Absent in schema 1 reports, which never decoded config assets. */
	playerMappableConfigs: Schema.optionalKey(Schema.Array(PlayerMappableConfigRecord)),
	diagnostics: Schema.Array(EnhancedInputDiagnostic)
});
export type EnhancedInputReport = Schema.Schema.Type<typeof EnhancedInputReport>;

export const EnhancedInputPublicError = Schema.Struct({
	code: Schema.Literals([
		"invalid_project",
		"invalid_options",
		"scan_limit_exceeded",
		"invalid_path",
		"reader_failed"
	]),
	...ErrorGuidanceFields
});
export type EnhancedInputPublicError = Schema.Schema.Type<typeof EnhancedInputPublicError>;

/**
 * Evidence a host resolved beside the scan: co-activation sets with the status of each source,
 * and per-platform views. The route derives conflict classes and platform atlases from it.
 */
export const EnhancedInputHostAnalysis = Schema.Struct({
	coActivation: Schema.Struct({
		sets: Schema.Array(CoActivationSet),
		sources: Schema.Array(CoActivationSourceStatus)
	}),
	platforms: Schema.Array(InputPlatformView)
});
export type EnhancedInputHostAnalysis = Schema.Schema.Type<typeof EnhancedInputHostAnalysis>;

/** One host-initiated scan, including the outcomes a host must render rather than throw. */
export const EnhancedInputRunResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("completed"),
		report: EnhancedInputReport,
		// The absolute root the scan ran against, so a host can confirm which project is on screen —
		// the report itself is coverage counts, not "what did we just scan".
		projectRoot: Schema.String,
		/** Optional. A host that resolves no analysis sources omits it. */
		analysis: Schema.optionalKey(EnhancedInputHostAnalysis)
	}),
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: EnhancedInputPublicError })
]);
export type EnhancedInputRunResult = Schema.Schema.Type<typeof EnhancedInputRunResult>;

export const decodeEnhancedInputRunResult = contractParser(
	EnhancedInputRunResult,
	"EnhancedInputRunResult"
);
