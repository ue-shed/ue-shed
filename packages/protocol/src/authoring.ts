import { Schema } from "effect";

export const AUTHORING_SNAPSHOT_CONTRACT_VERSION = { major: 2, minor: 1 } as const;
export const AUTHORING_MUTATION_CONTRACT_VERSION = { major: 1, minor: 1 } as const;
export const AUTHORING_TABLE_LIST_CONTRACT_VERSION = { major: 1, minor: 0 } as const;

/**
 * Recursive authoring values/descriptors need a manual type parameter for Schema.suspend.
 * Keep the declaration bidirectional with the inferred suspend body via AssertExact below.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertExact<A, B> = Exact<A, B> extends true ? true : never;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
	identifier: "NonNegativeInt"
});
const FloatValue = Schema.Union([Schema.Finite, Schema.Literals(["nan", "infinity", "-infinity"])]);

export type AuthoringValue =
	| { readonly kind: "bool"; readonly value: boolean }
	| { readonly kind: "int"; readonly value: string }
	| { readonly kind: "uint"; readonly value: string }
	| { readonly kind: "float"; readonly value: number | "nan" | "infinity" | "-infinity" }
	| { readonly kind: "double"; readonly value: number | "nan" | "infinity" | "-infinity" }
	| { readonly kind: "name"; readonly value: string }
	| { readonly kind: "enum"; readonly value: string }
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "text"; readonly value: string }
	| { readonly kind: "guid"; readonly value: string }
	| { readonly kind: "soft_object_path"; readonly value: string }
	| { readonly kind: "object_ref"; readonly value: string | null }
	| {
			readonly kind: "row_reference";
			readonly tableObjectPath: string | null;
			readonly rowName: string;
	  }
	| { readonly kind: "vector"; readonly x: number; readonly y: number; readonly z: number }
	| { readonly kind: "array"; readonly values: readonly AuthoringValue[] }
	| { readonly kind: "set"; readonly values: readonly AuthoringValue[] }
	| {
			readonly kind: "map";
			readonly entries: readonly {
				readonly key: AuthoringValue;
				readonly value: AuthoringValue;
			}[];
	  }
	| { readonly kind: "struct"; readonly fields: readonly AuthoringFieldValue[] }
	| { readonly kind: "unsupported"; readonly reason: string; readonly byteSize: number };

export interface AuthoringFieldValue {
	readonly name: string;
	readonly typeName: string;
	readonly value: AuthoringValue;
}

export const AuthoringValue: Schema.Codec<AuthoringValue> = Schema.suspend(
	() => AuthoringValueUnion
).annotate({ identifier: "AuthoringValue" });

export const AuthoringFieldValue: Schema.Codec<AuthoringFieldValue> = Schema.Struct({
	name: Schema.String,
	typeName: Schema.String,
	value: AuthoringValue
}).annotate({ identifier: "AuthoringFieldValue" });

const textValueSchemas = [
	Schema.Struct({ kind: Schema.Literal("name"), value: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("enum"), value: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("string"), value: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("text"), value: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("guid"), value: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("soft_object_path"), value: Schema.String })
] as const;
const AuthoringValueUnion = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("bool"), value: Schema.Boolean }),
	Schema.Struct({ kind: Schema.Literal("int"), value: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("uint"), value: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("float"), value: FloatValue }),
	Schema.Struct({ kind: Schema.Literal("double"), value: FloatValue }),
	...textValueSchemas,
	Schema.Struct({ kind: Schema.Literal("object_ref"), value: Schema.NullOr(Schema.String) }),
	Schema.Struct({
		kind: Schema.Literal("row_reference"),
		rowName: Schema.String,
		tableObjectPath: Schema.NullOr(Schema.String)
	}),
	Schema.Struct({
		kind: Schema.Literal("vector"),
		x: Schema.Finite,
		y: Schema.Finite,
		z: Schema.Finite
	}),
	Schema.Struct({ kind: Schema.Literal("array"), values: Schema.Array(AuthoringValue) }),
	Schema.Struct({ kind: Schema.Literal("set"), values: Schema.Array(AuthoringValue) }),
	Schema.Struct({
		kind: Schema.Literal("map"),
		entries: Schema.Array(Schema.Struct({ key: AuthoringValue, value: AuthoringValue }))
	}),
	Schema.Struct({ kind: Schema.Literal("struct"), fields: Schema.Array(AuthoringFieldValue) }),
	Schema.Struct({
		byteSize: NonNegativeInt,
		kind: Schema.Literal("unsupported"),
		reason: Schema.String
	})
]);
type _AuthoringValueConforms = AssertExact<
	AuthoringValue,
	Schema.Schema.Type<typeof AuthoringValueUnion>
>;
type _AuthoringFieldValueConforms = AssertExact<
	AuthoringFieldValue,
	Schema.Schema.Type<typeof AuthoringFieldValue>
>;
const _authoringValueConforms: _AuthoringValueConforms = true;
const _authoringFieldValueConforms: _AuthoringFieldValueConforms = true;
void _authoringValueConforms;
void _authoringFieldValueConforms;
export const AuthoringRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	fields: Schema.Array(AuthoringFieldValue)
});
export type AuthoringRow = Schema.Schema.Type<typeof AuthoringRow>;

export const AuthoringTableList = Schema.Struct({
	contract: Schema.Struct({
		name: Schema.Literal("unreal-authoring-table-list"),
		version: Schema.Struct({
			major: Schema.Literal(1),
			minor: NonNegativeInt
		})
	}),
	objectPaths: Schema.Array(Schema.String)
}).annotate({ identifier: "AuthoringTableList" });
export type AuthoringTableList = Schema.Schema.Type<typeof AuthoringTableList>;

const AuthoringAuthority = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("project_files"), packageName: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("live_editor"),
		producerId: Schema.String,
		sessionId: Schema.String
	})
]);

const AuthoringDiagnostic = Schema.Struct({
	code: Schema.String,
	message: Schema.String,
	path: Schema.optionalKey(Schema.String)
});

const AuthoringTable = Schema.Struct({
	kind: Schema.Literals(["data_table", "composite_data_table"]),
	objectPath: Schema.String,
	rowStruct: Schema.String,
	parentTables: Schema.Array(Schema.String),
	rows: Schema.Array(AuthoringRow)
});

export const AuthoringTableSnapshotV1 = Schema.Struct({
	contract: Schema.Struct({
		name: Schema.Literal("unreal-authoring"),
		version: Schema.Struct({
			major: Schema.Literal(1),
			minor: NonNegativeInt
		})
	}),
	authority: AuthoringAuthority,
	completeness: Schema.Literals(["complete", "partial"]),
	table: AuthoringTable,
	diagnostics: Schema.Array(AuthoringDiagnostic)
}).annotate({ identifier: "AuthoringTableSnapshotV1" });
export type AuthoringTableSnapshotV1 = Schema.Schema.Type<typeof AuthoringTableSnapshotV1>;

export type AuthoringEnumOption = {
	readonly name: string;
	readonly displayName?: string;
};

export type AuthoringTypeDescriptor =
	| {
			readonly kind: "scalar";
			readonly valueKind:
				| "bool"
				| "int"
				| "uint"
				| "float"
				| "double"
				| "name"
				| "string"
				| "text"
				| "guid";
	  }
	| {
			readonly kind: "enum";
			readonly enumPath?: string;
			readonly options: readonly AuthoringEnumOption[];
	  }
	| {
			readonly kind: "reference";
			readonly valueKind: "object_ref" | "soft_object_path";
			readonly target:
				| { readonly status: "known"; readonly classPath: string }
				| { readonly status: "unknown" };
	  }
	| { readonly kind: "row_reference" }
	| { readonly kind: "vector" }
	| { readonly kind: "array" | "set"; readonly element: AuthoringTypeDescriptor }
	| {
			readonly kind: "map";
			readonly key: AuthoringTypeDescriptor;
			readonly value: AuthoringTypeDescriptor;
	  }
	| {
			readonly kind: "struct";
			readonly structPath?: string;
			readonly fields: readonly AuthoringFieldDescriptor[];
	  }
	| { readonly kind: "unsupported"; readonly reason: string; readonly typeName: string };

export interface AuthoringFieldDescriptor {
	readonly id: string;
	readonly name: string;
	readonly typeName: string;
	readonly type: AuthoringTypeDescriptor;
	readonly editability:
		| { readonly kind: "editable" }
		| { readonly kind: "read_only"; readonly reason: string };
	readonly presence: "required" | "optional" | "unknown";
	readonly annotations: {
		readonly displayName?: string;
		readonly description?: string;
		readonly deprecated: boolean;
		readonly readOnly: boolean;
		readonly clampMin?: string;
		readonly clampMax?: string;
		readonly step?: string;
		readonly unit?: string;
		readonly rowReference?:
			| { readonly status: "known"; readonly tableObjectPath: string }
			| { readonly status: "unknown" };
	};
	readonly defaultValue:
		| { readonly status: "known"; readonly value: AuthoringValue }
		| { readonly status: "unknown" };
}

export const AuthoringTypeDescriptor: Schema.Codec<AuthoringTypeDescriptor> = Schema.suspend(
	() => AuthoringTypeDescriptorUnion
).annotate({ identifier: "AuthoringTypeDescriptor" });

export const AuthoringFieldDescriptor: Schema.Codec<AuthoringFieldDescriptor> = Schema.Struct({
	annotations: Schema.Struct({
		clampMax: Schema.optionalKey(Schema.String),
		clampMin: Schema.optionalKey(Schema.String),
		deprecated: Schema.Boolean,
		description: Schema.optionalKey(Schema.String),
		displayName: Schema.optionalKey(Schema.String),
		readOnly: Schema.Boolean,
		rowReference: Schema.optionalKey(
			Schema.Union([
				Schema.Struct({ status: Schema.Literal("known"), tableObjectPath: Schema.String }),
				Schema.Struct({ status: Schema.Literal("unknown") })
			])
		),
		step: Schema.optionalKey(Schema.String),
		unit: Schema.optionalKey(Schema.String)
	}),
	defaultValue: Schema.Union([
		Schema.Struct({ status: Schema.Literal("known"), value: AuthoringValue }),
		Schema.Struct({ status: Schema.Literal("unknown") })
	]),
	editability: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("editable") }),
		Schema.Struct({ kind: Schema.Literal("read_only"), reason: Schema.String })
	]),
	id: Schema.String,
	name: Schema.String,
	presence: Schema.Literals(["required", "optional", "unknown"]),
	type: AuthoringTypeDescriptor,
	typeName: Schema.String
}).annotate({ identifier: "AuthoringFieldDescriptor" });

const AuthoringTypeDescriptorUnion = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("scalar"),
		valueKind: Schema.Literals([
			"bool",
			"int",
			"uint",
			"float",
			"double",
			"name",
			"string",
			"text",
			"guid"
		])
	}),
	Schema.Struct({
		enumPath: Schema.optionalKey(Schema.String),
		kind: Schema.Literal("enum"),
		options: Schema.Array(
			Schema.Struct({ displayName: Schema.optionalKey(Schema.String), name: Schema.String })
		)
	}),
	Schema.Struct({
		kind: Schema.Literal("reference"),
		target: Schema.Union([
			Schema.Struct({ classPath: Schema.String, status: Schema.Literal("known") }),
			Schema.Struct({ status: Schema.Literal("unknown") })
		]),
		valueKind: Schema.Literals(["object_ref", "soft_object_path"])
	}),
	Schema.Struct({ kind: Schema.Literal("row_reference") }),
	Schema.Struct({ kind: Schema.Literal("vector") }),
	Schema.Struct({
		element: AuthoringTypeDescriptor,
		kind: Schema.Literals(["array", "set"])
	}),
	Schema.Struct({
		key: AuthoringTypeDescriptor,
		kind: Schema.Literal("map"),
		value: AuthoringTypeDescriptor
	}),
	Schema.Struct({
		fields: Schema.Array(AuthoringFieldDescriptor),
		kind: Schema.Literal("struct"),
		structPath: Schema.optionalKey(Schema.String)
	}),
	Schema.Struct({
		kind: Schema.Literal("unsupported"),
		reason: Schema.String,
		typeName: Schema.String
	})
]);
type _AuthoringTypeDescriptorConforms = AssertExact<
	AuthoringTypeDescriptor,
	Schema.Schema.Type<typeof AuthoringTypeDescriptorUnion>
>;
type _AuthoringFieldDescriptorConforms = AssertExact<
	AuthoringFieldDescriptor,
	Schema.Schema.Type<typeof AuthoringFieldDescriptor>
>;
const _authoringTypeDescriptorConforms: _AuthoringTypeDescriptorConforms = true;
const _authoringFieldDescriptorConforms: _AuthoringFieldDescriptorConforms = true;
void _authoringTypeDescriptorConforms;
void _authoringFieldDescriptorConforms;
export const AuthoringTableSnapshotV2 = Schema.Struct({
	contract: Schema.Struct({
		name: Schema.Literal("unreal-authoring"),
		version: Schema.Struct({
			major: Schema.Literal(2),
			minor: NonNegativeInt
		})
	}),
	authority: AuthoringAuthority,
	completeness: Schema.Literals(["complete", "partial"]),
	diagnostics: Schema.Array(AuthoringDiagnostic),
	fingerprint: Schema.Union([
		Schema.Struct({
			algorithm: Schema.Literal("sha256"),
			status: Schema.Literal("available"),
			value: Schema.String,
			version: NonNegativeInt
		}),
		Schema.Struct({ reason: Schema.String, status: Schema.Literal("unavailable") })
	]),
	producer: Schema.Struct({ name: Schema.String, version: Schema.String }),
	table: Schema.Struct({
		...AuthoringTable.fields,
		packageName: Schema.String,
		schema: Schema.Union([
			Schema.Struct({
				fields: Schema.Array(AuthoringFieldDescriptor),
				source: Schema.Literals(["saved_package", "live_reflection"]),
				status: Schema.Literal("available")
			}),
			Schema.Struct({ reason: Schema.String, status: Schema.Literal("unavailable") })
		])
	})
}).annotate({ identifier: "AuthoringTableSnapshotV2" });
export type AuthoringTableSnapshotV2 = Schema.Schema.Type<typeof AuthoringTableSnapshotV2>;

export const AuthoringTableSnapshot = Schema.Union([
	AuthoringTableSnapshotV1,
	AuthoringTableSnapshotV2
]).annotate({ identifier: "AuthoringTableSnapshot" });
export type AuthoringTableSnapshot = Schema.Schema.Type<typeof AuthoringTableSnapshot>;

export type AuthoringSnapshotCompatibility =
	| { readonly status: "current"; readonly snapshot: AuthoringTableSnapshotV2 }
	| {
			readonly status: "legacy_read_only";
			readonly snapshot: AuthoringTableSnapshotV1;
			readonly recovery: string;
	  };

export function classifyAuthoringSnapshot(
	snapshot: AuthoringTableSnapshot
): AuthoringSnapshotCompatibility {
	if ("producer" in snapshot) return { snapshot, status: "current" };
	return {
		recovery: "Refresh this table from a producer that supports authoring snapshot v2.",
		snapshot,
		status: "legacy_read_only"
	};
}

export const decodeAuthoringTableSnapshot = Schema.decodeUnknownEffect(AuthoringTableSnapshot);
export const decodeAuthoringTableList = Schema.decodeUnknownEffect(AuthoringTableList);
export const decodeAuthoringValue = Schema.decodeUnknownEffect(AuthoringValue);

export const AuthoringCommand = Schema.Union([
	Schema.Struct({
		fieldName: Schema.String,
		kind: Schema.Literal("set_cell"),
		newValue: AuthoringValue,
		oldValue: AuthoringValue,
		rowId: Schema.String
	}),
	Schema.Struct({
		atIndex: NonNegativeInt,
		kind: Schema.Literal("add_row"),
		row: AuthoringRow
	}),
	Schema.Struct({
		atIndex: NonNegativeInt,
		kind: Schema.Literal("remove_row"),
		row: AuthoringRow
	}),
	Schema.Struct({
		kind: Schema.Literal("rename_row"),
		newName: Schema.String,
		oldName: Schema.String,
		rowId: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("reorder_rows"),
		newOrder: Schema.Array(Schema.String),
		oldOrder: Schema.Array(Schema.String)
	})
]).annotate({ identifier: "AuthoringCommand" });
export type AuthoringCommand = Schema.Schema.Type<typeof AuthoringCommand>;

const ApplyContract = Schema.Struct({
	name: Schema.Literal("unreal-authoring-apply"),
	version: Schema.Struct({
		major: Schema.Literal(1),
		minor: NonNegativeInt
	})
});

export const AuthoringApplyRequest = Schema.Struct({
	contract: ApplyContract,
	operationId: Schema.String,
	tables: Schema.Array(
		Schema.Struct({
			expectedFingerprint: Schema.String,
			objectPath: Schema.String
		})
	),
	commands: Schema.Array(
		Schema.Struct({
			body: AuthoringCommand,
			id: Schema.String,
			tableObjectPath: Schema.String
		})
	)
}).annotate({ identifier: "AuthoringApplyRequest" });
export type AuthoringApplyRequest = Schema.Schema.Type<typeof AuthoringApplyRequest>;

export const AuthoringOperationError = Schema.Struct({
	code: Schema.String,
	commandId: Schema.optionalKey(Schema.String),
	message: Schema.String,
	objectPath: Schema.optionalKey(Schema.String),
	retrySafe: Schema.Boolean
});
export type AuthoringOperationError = Schema.Schema.Type<typeof AuthoringOperationError>;

export const AuthoringApplyResult = Schema.Struct({
	contract: ApplyContract,
	errors: Schema.Array(AuthoringOperationError),
	operationId: Schema.String,
	snapshots: Schema.Array(AuthoringTableSnapshot),
	status: Schema.Literals(["committed", "rolled_back", "rejected"])
}).annotate({ identifier: "AuthoringApplyResult" });
export type AuthoringApplyResult = Schema.Schema.Type<typeof AuthoringApplyResult>;

const SaveContract = Schema.Struct({
	name: Schema.Literal("unreal-authoring-save"),
	version: Schema.Struct({
		major: Schema.Literal(1),
		minor: NonNegativeInt
	})
});

export const AuthoringSaveRequest = Schema.Struct({
	contract: SaveContract,
	objectPaths: Schema.Array(Schema.String),
	requestId: Schema.String
}).annotate({ identifier: "AuthoringSaveRequest" });
export type AuthoringSaveRequest = Schema.Schema.Type<typeof AuthoringSaveRequest>;

export const AuthoringSaveResult = Schema.Struct({
	contract: SaveContract,
	packages: Schema.Array(
		Schema.Struct({
			message: Schema.optionalKey(Schema.String),
			objectPath: Schema.String,
			packageName: Schema.String,
			retrySafe: Schema.Boolean,
			status: Schema.Literals(["saved", "failed"])
		})
	),
	requestId: Schema.String,
	status: Schema.Literals(["complete", "partial", "failed"])
}).annotate({ identifier: "AuthoringSaveResult" });
export type AuthoringSaveResult = Schema.Schema.Type<typeof AuthoringSaveResult>;

export const decodeAuthoringApplyRequest = Schema.decodeUnknownEffect(AuthoringApplyRequest);
export const decodeAuthoringApplyResult = Schema.decodeUnknownEffect(AuthoringApplyResult);
export const decodeAuthoringSaveRequest = Schema.decodeUnknownEffect(AuthoringSaveRequest);
export const decodeAuthoringSaveResult = Schema.decodeUnknownEffect(AuthoringSaveResult);

export function makeAuthoringJsonSchema(contract: Schema.Top): Readonly<Record<string, unknown>> {
	const document = Schema.toJsonSchemaDocument(contract);
	const definitions = { ...document.definitions };
	if ("NonNegativeInt" in definitions) {
		definitions.NonNegativeInt = {
			type: "integer",
			description: "an integer",
			title: "int",
			minimum: 0
		};
	}
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$defs: definitions,
		...document.schema
	};
}
