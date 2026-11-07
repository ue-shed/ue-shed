import { contractParser } from "./contract-parser.js";
import { makeWireJsonSchemaDocument } from "./json-schema.js";
import { Schema } from "effect";
/**
 * Newest `unreal-authoring` table snapshot version this package knows. Minor 1 added
 * `row_reference` values, minor 3 added text identity and minor 4 added field property names.
 */
export const AUTHORING_SNAPSHOT_CONTRACT_VERSION = { major: 2, minor: 4 };
/**
 * Newest `unreal-authoring-apply` version this package sends. Minor 1 added `row_reference` values
 * and minor 2 added text identity.
 */
export const AUTHORING_MUTATION_CONTRACT_VERSION = { major: 1, minor: 2 };
/** Newest `unreal-authoring-save` version this package knows. */
export const AUTHORING_SAVE_CONTRACT_VERSION = { major: 1, minor: 1 };
/** Newest `unreal-authoring-table-list` version this package knows. */
export const AUTHORING_TABLE_LIST_CONTRACT_VERSION = { major: 1, minor: 0 };
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    identifier: "NonNegativeInt"
});
const FloatValue = Schema.Union([Schema.Finite, Schema.Literals(["nan", "infinity", "-infinity"])]);
/**
 * Where a text value's content comes from. Snapshots always report it. A localized write stores
 * `sourceString` under the namespace and key; omitting `key` asks the producer to mint a new one in
 * the table package. String-table writes reference an existing entry. Generated text (formatted,
 * numeric, and other derived histories) is read-only.
 */
export const AuthoringTextIdentity = Schema.Union([
    Schema.Struct({
        key: Schema.optionalKey(Schema.String),
        kind: Schema.Literal("localized"),
        namespace: Schema.String,
        sourceString: Schema.String
    }),
    Schema.Struct({
        key: Schema.String,
        kind: Schema.Literal("string_table"),
        tableId: Schema.String
    }),
    Schema.Struct({ kind: Schema.Literal("culture_invariant") }),
    Schema.Struct({ kind: Schema.Literal("none") }),
    Schema.Struct({ kind: Schema.Literal("generated") })
]).annotate({ identifier: "AuthoringTextIdentity" });
/**
 * A typed Unreal property value, recursive through containers and structs. `int` and `uint` carry
 * decimal strings, floats spell non-finite values as `"nan"`, `"infinity"` or `"-infinity"`, and
 * `unsupported` stands in for a property the producer cannot represent instead of dropping it.
 */
export const AuthoringValue = Schema.suspend(() => AuthoringValueUnion).annotate({ identifier: "AuthoringValue" });
/** One named property of a row or struct with its Unreal type name and value. */
export const AuthoringFieldValue = Schema.Struct({
    name: Schema.String,
    typeName: Schema.String,
    value: AuthoringValue
}).annotate({ identifier: "AuthoringFieldValue" });
const textValueSchemas = [
    Schema.Struct({ kind: Schema.Literal("name"), value: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("enum"), value: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("string"), value: Schema.String }),
    Schema.Struct({
        identity: Schema.optionalKey(AuthoringTextIdentity),
        kind: Schema.Literal("text"),
        value: Schema.String
    }),
    Schema.Struct({ kind: Schema.Literal("guid"), value: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("soft_object_path"), value: Schema.String })
];
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
const _authoringValueConforms = true;
const _authoringFieldValueConforms = true;
void _authoringValueConforms;
void _authoringFieldValueConforms;
/**
 * One DataTable row. `id` is the row's stable identity that commands target; `name` is its Unreal
 * row name, which a rename changes.
 */
export const AuthoringRow = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    fields: Schema.Array(AuthoringFieldValue)
});
/**
 * Live discovery of authorable tables as canonical object paths only; fetch a snapshot per table
 * for its contents and schema. Decoding accepts any 1.x minor version.
 */
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
/**
 * Legacy 1.x table snapshot without field schema, producer, or fingerprint evidence. Hosts can show
 * it but not edit it; see {@link classifyAuthoringSnapshot}.
 */
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
/**
 * The shape of a field's Unreal property type, recursive through containers and structs, used to
 * pick an editor and validate values. `unsupported` keeps the Unreal type name and a reason.
 */
export const AuthoringTypeDescriptor = Schema.suspend(() => AuthoringTypeDescriptorUnion).annotate({ identifier: "AuthoringTypeDescriptor" });
/**
 * One row-struct field: type, editability, presence, metadata annotations (clamp, step, unit as
 * strings) and default, `unknown` when the producer cannot know it (never assume zero). `name` is
 * what row values use; `propertyName` is the FName saved packages use, which differs for User
 * Defined Struct members. Sent live from snapshot 2.4; if absent, only native names match FNames.
 */
export const AuthoringFieldDescriptor = Schema.Struct({
    annotations: Schema.Struct({
        clampMax: Schema.optionalKey(Schema.String),
        clampMin: Schema.optionalKey(Schema.String),
        deprecated: Schema.Boolean,
        description: Schema.optionalKey(Schema.String),
        displayName: Schema.optionalKey(Schema.String),
        readOnly: Schema.Boolean,
        rowReference: Schema.optionalKey(Schema.Union([
            Schema.Struct({ status: Schema.Literal("known"), tableObjectPath: Schema.String }),
            Schema.Struct({ status: Schema.Literal("unknown") })
        ])),
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
    propertyName: Schema.optionalKey(Schema.String),
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
        options: Schema.Array(Schema.Struct({ displayName: Schema.optionalKey(Schema.String), name: Schema.String }))
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
const _authoringTypeDescriptorConforms = true;
const _authoringFieldDescriptorConforms = true;
void _authoringTypeDescriptorConforms;
void _authoringFieldDescriptorConforms;
/**
 * Current 2.x table snapshot with producer, package, field schema, and a versioned SHA-256 content
 * fingerprint that Apply uses to detect drift. Schema and fingerprint report `unavailable` with a
 * reason rather than being omitted. Decoding accepts any 2.x minor version.
 */
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
/** A table snapshot of either major version, as Apply results may return during migration. */
export const AuthoringTableSnapshot = Schema.Union([
    AuthoringTableSnapshotV1,
    AuthoringTableSnapshotV2
]).annotate({ identifier: "AuthoringTableSnapshot" });
/**
 * Marks a v2 snapshot `current` and a v1 snapshot `legacy_read_only`, with recovery text asking
 * the user to refresh from a producer that supports v2.
 */
export function classifyAuthoringSnapshot(snapshot) {
    if ("producer" in snapshot)
        return { snapshot, status: "current" };
    return {
        recovery: "Refresh this table from a producer that supports authoring snapshot v2.",
        snapshot,
        status: "legacy_read_only"
    };
}
/**
 * Edit a text value's content while keeping its identity: a localized text keeps its namespace and
 * key with a new source string. String-table and generated text cannot be edited in place.
 */
export function editAuthoringText(current, content) {
    const identity = current.identity;
    if (identity?.kind === "string_table" || identity?.kind === "generated")
        return undefined;
    if (identity?.kind === "localized") {
        return { identity: { ...identity, sourceString: content }, kind: "text", value: content };
    }
    return identity ? { identity, kind: "text", value: content } : { kind: "text", value: content };
}
/** Decodes a v1 or v2 snapshot; fails with a `ContractParseError` on any other version or shape. */
export const decodeAuthoringTableSnapshot = contractParser(AuthoringTableSnapshot, "AuthoringTableSnapshot");
/** Decodes a 1.x table list; fails with a `ContractParseError` on any other version or shape. */
export const decodeAuthoringTableList = contractParser(AuthoringTableList, "AuthoringTableList");
/** Decodes one typed value; fails with a `ContractParseError` when the input is not a valid value. */
export const decodeAuthoringValue = contractParser(AuthoringValue, "AuthoringValue");
/**
 * One table edit. Each command records the prior state it expects (old value, removed row and
 * index, old name or order) so it can be inverted for undo and checked against the table it
 * applies to.
 * Rows are addressed by `id`; reorder orders list row ids.
 */
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
const ApplyContract = Schema.Struct({
    name: Schema.Literal("unreal-authoring-apply"),
    version: Schema.Struct({
        major: Schema.Literal(1),
        minor: NonNegativeInt
    })
});
/**
 * One bounded Apply batch over one or more tables. Each table names the fingerprint its edits were
 * based on so the producer can refuse drifted state; `operationId` stays stable so a lost reply can
 * be looked up instead of replayed.
 */
export const AuthoringApplyRequest = Schema.Struct({
    contract: ApplyContract,
    operationId: Schema.String,
    tables: Schema.Array(Schema.Struct({
        expectedFingerprint: Schema.String,
        objectPath: Schema.String
    })),
    commands: Schema.Array(Schema.Struct({
        body: AuthoringCommand,
        id: Schema.String,
        tableObjectPath: Schema.String
    }))
}).annotate({ identifier: "AuthoringApplyRequest" });
/**
 * A problem reported by Apply, optionally tied to a command or table. `retrySafe` says whether the
 * same request can be sent again.
 */
export const AuthoringOperationError = Schema.Struct({
    /**
     * Apply 1.3: the specific cause behind `command_failed`, for example `stale_cell`,
     * `unknown_row` or `expected_enum`. Lower snake case.
     */
    cause: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[a-z][a-z0-9_]*$/u))),
    code: Schema.String,
    commandId: Schema.optionalKey(Schema.String),
    message: Schema.String,
    objectPath: Schema.optionalKey(Schema.String),
    retrySafe: Schema.Boolean
});
/**
 * A producer refusal returned instead of a result, for example `invalid_request`,
 * `request_too_large`, `unsupported_contract`, `table_not_found`, or `operation_not_found`.
 */
export const AuthoringEndpointError = Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    status: Schema.Literal("error")
}).annotate({ identifier: "AuthoringEndpointError" });
/**
 * Outcome of an Apply batch, all or nothing: `committed` returns fresh snapshots, `rolled_back`
 * means the producer undid every change, and `rejected` means it refused the batch and returns no
 * snapshots.
 */
export const AuthoringApplyResult = Schema.Struct({
    contract: ApplyContract,
    errors: Schema.Array(AuthoringOperationError),
    operationId: Schema.String,
    snapshots: Schema.Array(AuthoringTableSnapshot),
    status: Schema.Literals(["committed", "rolled_back", "rejected"])
}).annotate({ identifier: "AuthoringApplyResult" });
const SaveContract = Schema.Struct({
    name: Schema.Literal("unreal-authoring-save"),
    version: Schema.Struct({
        major: Schema.Literal(1),
        minor: NonNegativeInt
    })
});
/** Asks the editor to write the named tables' packages to disk; separate from Apply. */
export const AuthoringSaveRequest = Schema.Struct({
    contract: SaveContract,
    objectPaths: Schema.Array(Schema.String),
    requestId: Schema.String
}).annotate({ identifier: "AuthoringSaveRequest" });
/**
 * Per-package Save outcome. `partial` means some packages saved and others failed; each failure
 * says whether retrying it is safe.
 */
export const AuthoringSaveResult = Schema.Struct({
    contract: SaveContract,
    packages: Schema.Array(Schema.Struct({
        /** Save 1.2: why a package failed (`table_not_found` or `save_failed`). */
        code: Schema.optionalKey(Schema.Literals(["table_not_found", "save_failed"])),
        message: Schema.optionalKey(Schema.String),
        objectPath: Schema.String,
        packageName: Schema.String,
        retrySafe: Schema.Boolean,
        status: Schema.Literals(["saved", "failed"])
    })),
    requestId: Schema.String,
    status: Schema.Literals(["complete", "partial", "failed"])
}).annotate({ identifier: "AuthoringSaveResult" });
/** Decodes a 1.x Apply request; fails with a `ContractParseError` on any other version or shape. */
export const decodeAuthoringApplyRequest = contractParser(AuthoringApplyRequest, "AuthoringApplyRequest");
/** Decodes a 1.x Apply result; fails with a `ContractParseError` on any other version or shape. */
export const decodeAuthoringApplyResult = contractParser(AuthoringApplyResult, "AuthoringApplyResult");
/** Decodes a 1.x Save request; fails with a `ContractParseError` on any other version or shape. */
export const decodeAuthoringSaveRequest = contractParser(AuthoringSaveRequest, "AuthoringSaveRequest");
/** Decodes a 1.x Save result; fails with a `ContractParseError` on any other version or shape. */
export const decodeAuthoringSaveResult = contractParser(AuthoringSaveResult, "AuthoringSaveResult");
/**
 * Derives a JSON Schema (draft 2020-12) document from an authoring Effect schema, used to check it
 * against the checked-in schemas. The checked-in JSON Schemas stay authoritative; this output is
 * for comparison only.
 */
export function makeAuthoringJsonSchema(contract) {
    const document = makeWireJsonSchemaDocument(contract);
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
