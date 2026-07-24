import { Schema } from "effect";

export const InputObjectPath = Schema.String.pipe(Schema.brand("InputObjectPath"));
export type InputObjectPath = Schema.Schema.Type<typeof InputObjectPath>;
export const makeInputObjectPath = InputObjectPath.make;

export const EvidenceUnavailableReason = Schema.Literals([
	"not_serialized",
	"wrong_value_kind",
	"not_an_input_action",
	"not_a_mapping_context"
]);

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

export const InputInstancedObjectRef = Schema.Struct({
	objectPath: Schema.String,
	classPath: Schema.optional(Schema.String)
});
export type InputInstancedObjectRef = Schema.Schema.Type<typeof InputInstancedObjectRef>;

export const InputActionRecord = Schema.Struct({
	objectPath: InputObjectPath,
	classPath: Schema.Literal("/Script/EnhancedInput.InputAction"),
	packageFile: Schema.String,
	actionDescription: StringEvidence,
	valueType: StringEvidence,
	consumeInput: BooleanEvidence
});
export type InputActionRecord = Schema.Schema.Type<typeof InputActionRecord>;

export const InputMappingRecord = Schema.Struct({
	action: Schema.NullOr(Schema.String),
	keyName: StringEvidence,
	triggers: Schema.Array(InputInstancedObjectRef),
	modifiers: Schema.Array(InputInstancedObjectRef)
});
export type InputMappingRecord = Schema.Schema.Type<typeof InputMappingRecord>;

export const InputMappingsProperty = Schema.Literals(["Mappings", "DefaultKeyMappings"]);
export type InputMappingsProperty = Schema.Schema.Type<typeof InputMappingsProperty>;

export const InputMappingContextRecord = Schema.Struct({
	objectPath: InputObjectPath,
	classPath: Schema.Literal("/Script/EnhancedInput.InputMappingContext"),
	packageFile: Schema.String,
	contextDescription: StringEvidence,
	mappingsProperty: Schema.NullOr(InputMappingsProperty),
	mappings: Schema.Array(InputMappingRecord),
	exports: Schema.Array(
		Schema.Struct({
			objectPath: Schema.String,
			classPath: Schema.String
		})
	)
});
export type InputMappingContextRecord = Schema.Schema.Type<typeof InputMappingContextRecord>;

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

export const EnhancedInputReport = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	status: Schema.Literals(["complete", "partial"]),
	coverage: Schema.Struct({
		discoveredPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		inspectedPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		partialPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		failedPackages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		inputActions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		mappingContexts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	}),
	actions: Schema.Array(InputActionRecord),
	mappingContexts: Schema.Array(InputMappingContextRecord),
	diagnostics: Schema.Array(EnhancedInputDiagnostic)
});
export type EnhancedInputReport = Schema.Schema.Type<typeof EnhancedInputReport>;

export const EnhancedInputPublicError = Schema.Struct({
	code: Schema.Literals(["invalid_project", "scan_limit_exceeded", "invalid_path"]),
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean
});
export type EnhancedInputPublicError = Schema.Schema.Type<typeof EnhancedInputPublicError>;
