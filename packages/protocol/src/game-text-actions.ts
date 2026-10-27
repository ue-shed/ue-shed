import { ErrorNextStep } from "./errors.js";
import { Schema } from "effect";

/**
 * `ue-shed-game-text-actions` 1.0 (ADR 0011): text identity edits the `UEShedGameText` editor
 * plugin applies through Unreal's own id rules, over Remote Control or its commandlet.
 */
export const GAME_TEXT_ACTIONS_CONTRACT = "ue-shed-game-text-actions";
/** Exact wire version accepted by the editor plugin; callers must send this value. */
export const GAME_TEXT_ACTIONS_VERSION = "1.0";
/** The most places one request may edit. */
export const GAME_TEXT_ACTIONS_MAX_ACTIONS = 256;

// UTF-16 code units, as Unreal's FString::Len counts them.
const Field = Schema.String.check(Schema.isMaxLength(4096));
const NonEmptyField = Schema.NonEmptyString.check(Schema.isMaxLength(4096));

/**
 * A text's id and source as Gather and the saved-package reader report it: the namespace leaves
 * out the package namespace Unreal adds to text inside packages.
 */
const LocalizedActionIdentity = Schema.Struct({
	namespace: Field,
	key: NonEmptyField,
	source: Field,
	tableId: Schema.optionalKey(NonEmptyField)
});
/** Expected authored identity; unkeyed conversion and table references require authoring capability. */
export const GameTextActionIdentity = Schema.Union([
	LocalizedActionIdentity,
	Schema.Struct({
		namespace: Schema.Literal(""),
		key: Schema.Literal(""),
		source: Field,
		unresolved: Schema.Literals(["culture_invariant", "missing_key", "generated"])
	})
]).annotate({ identifier: "GameTextActionIdentity" });
export type GameTextActionIdentity = typeof GameTextActionIdentity.Type;

/** The scanned package file, serialized object path and reader property chain. */
export const GameTextActionPlace = Schema.Struct({
	/** Absolute or relative to the connected editor project; retain the reader record path. */
	packageFile: NonEmptyField,
	objectPath: NonEmptyField,
	propertyPath: NonEmptyField,
	/** Authored locations require authoring.v1; data_table_cell and graph_pin key edits also accept key-repairs.v1. */
	selector: Schema.optionalKey(
		Schema.Union([
			Schema.Struct({ kind: Schema.Literal("data_table_cell"), row: NonEmptyField }),
			Schema.Struct({ kind: Schema.Literal("string_table_entry"), entryKey: NonEmptyField }),
			Schema.Struct({ kind: Schema.Literal("graph_pin"), pinId: NonEmptyField }),
			Schema.Struct({
				kind: Schema.Literal("graph_pin"),
				index: Schema.Int.check(
					Schema.isGreaterThanOrEqualTo(0),
					Schema.isLessThanOrEqualTo(2147483647)
				)
			})
		])
	)
}).annotate({ identifier: "GameTextActionPlace" });
export type GameTextActionPlace = typeof GameTextActionPlace.Type;

/** Identity or source edit; adopt_key also requires the source belonging to the adopted key. */
export const GameTextActionEdit = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("change_key"), namespace: Field, key: NonEmptyField }),
	Schema.Struct({ kind: Schema.Literal("regenerate_key") }),
	Schema.Struct({
		kind: Schema.Literal("adopt_key"),
		namespace: Field,
		key: NonEmptyField,
		source: NonEmptyField
	}),
	Schema.Struct({ kind: Schema.Literal("change_source"), source: NonEmptyField }),
	Schema.Struct({
		kind: Schema.Literal("make_localizable"),
		namespace: Field,
		key: NonEmptyField,
		source: Field
	}),
	Schema.Struct({
		kind: Schema.Literal("copy_string_table_entry"),
		namespace: Field,
		key: NonEmptyField,
		source: Field
	}),
	Schema.Struct({ kind: Schema.Literal("remove_string_table_entry") }),
	Schema.Struct({ kind: Schema.Literal("change_string_table_namespace"), namespace: Field }),
	Schema.Struct({
		kind: Schema.Literal("retarget_string_table"),
		tableId: NonEmptyField,
		key: NonEmptyField,
		source: Field
	})
]).annotate({ identifier: "GameTextActionEdit" });
export type GameTextActionEdit = typeof GameTextActionEdit.Type;

/** One edit guarded by the scanned identity and source; stale expectations reject the request. */
export const GameTextAction = Schema.Struct({
	id: NonEmptyField,
	place: GameTextActionPlace,
	expected: GameTextActionIdentity,
	edit: GameTextActionEdit
}).annotate({ identifier: "GameTextAction" });
export type GameTextAction = typeof GameTextAction.Type;

/** A bounded dry run or apply request; saving requires compilation and explicit opt-in. */
export const GameTextActionsRequest = Schema.Struct({
	contract: Schema.Literal(GAME_TEXT_ACTIONS_CONTRACT),
	version: Schema.Literal(GAME_TEXT_ACTIONS_VERSION),
	mode: Schema.Literals(["dry_run", "apply"]),
	/** Compile each Blueprint that owns an edited place (default true). */
	compile: Schema.optionalKey(Schema.Boolean),
	/** Save the edited packages after a successful compile (default false; needs compile). */
	save: Schema.optionalKey(Schema.Boolean),
	actions: Schema.Array(GameTextAction).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(GAME_TEXT_ACTIONS_MAX_ACTIONS)
	)
}).annotate({ identifier: "GameTextActionsRequest" });
export type GameTextActionsRequest = typeof GameTextActionsRequest.Type;

/** Stable rejection and apply-failure categories; recovery fields determine safe follow-up. */
export const GameTextActionErrorCode = Schema.Literals([
	"invalid_request",
	"package_mismatch",
	"place_not_found",
	"not_text",
	"read_only_text",
	"unsupported_place",
	"stale_expected",
	"key_conflict",
	"compile_failed",
	"not_persisted",
	"save_failed",
	"rollback_failed"
]);
export type GameTextActionErrorCode = typeof GameTextActionErrorCode.Type;

/** Required recovery action; reconcile requires inspecting editor state before resubmitting. */
export const GameTextActionNextStep = ErrorNextStep;
export type GameTextActionNextStep = typeof GameTextActionNextStep.Type;

/** Action failure with replay guidance; retrySafe alone does not authorize automatic retries. */
export const GameTextActionError = Schema.Struct({
	code: GameTextActionErrorCode,
	actionId: Schema.optionalKey(Schema.String),
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean,
	nextStep: GameTextActionNextStep
}).annotate({ identifier: "GameTextActionError" });
export type GameTextActionError = typeof GameTextActionError.Type;

/** The text after an action; a key a dry run would mint is `minted` with no value. */
export const GameTextActionOutcomeIdentity = Schema.Struct({
	namespace: Schema.String,
	key: Schema.optionalKey(Schema.String),
	minted: Schema.optionalKey(Schema.Literal(true)),
	source: Schema.String,
	tableId: Schema.optionalKey(Schema.String),
	unresolved: Schema.optionalKey(
		Schema.Literals(["culture_invariant", "missing_key", "generated"])
	),
	removed: Schema.optionalKey(Schema.Literal(true))
}).annotate({ identifier: "GameTextActionOutcomeIdentity" });
export type GameTextActionOutcomeIdentity = typeof GameTextActionOutcomeIdentity.Type;

/** Per-action editor state; unknown outcomes require reconciliation even if the request failed. */
export const GameTextActionOutcome = Schema.Struct({
	id: Schema.String,
	place: GameTextActionPlace,
	status: Schema.Literals(["applied", "planned", "unchanged", "rolled_back", "unknown"]),
	before: GameTextActionIdentity,
	after: GameTextActionOutcomeIdentity
}).annotate({ identifier: "GameTextActionOutcome" });
export type GameTextActionOutcome = typeof GameTextActionOutcome.Type;

/**
 * `ok`: every action applied (or, in a dry run, would apply). `rejected`: nothing changed.
 * `failed`: an apply failed after editing; `rolledBack` says whether the edits were undone (a save
 * failure leaves them in the editor).
 */
export const GameTextActionsResult = Schema.Struct({
	contract: Schema.Literal(GAME_TEXT_ACTIONS_CONTRACT),
	version: Schema.Literal(GAME_TEXT_ACTIONS_VERSION),
	mode: Schema.Literals(["dry_run", "apply"]),
	status: Schema.Literals(["ok", "rejected", "failed"]),
	rolledBack: Schema.Boolean,
	actions: Schema.Array(GameTextActionOutcome),
	blueprints: Schema.Array(
		Schema.Struct({ objectPath: Schema.String, compiled: Schema.Boolean })
	),
	/** Packages the request saved, or for a dry run or unsaved apply, the packages it would write. */
	packages: Schema.Array(
		Schema.Struct({
			packageName: Schema.String,
			packageFile: Schema.String,
			saved: Schema.Boolean,
			persistence: Schema.Literals(["saved", "unsaved", "unknown"])
		})
	),
	errors: Schema.Array(GameTextActionError)
}).annotate({ identifier: "GameTextActionsResult" });
export type GameTextActionsResult = typeof GameTextActionsResult.Type;

/** Checks a runtime key redirect, optionally activating an exact redirect already persisted by a host. */
export const StringTableRedirectRequest = Schema.Struct({
	contract: Schema.Literal("ue-shed-string-table-redirect"),
	version: Schema.Literal("1.0"),
	tableId: NonEmptyField,
	oldKey: NonEmptyField,
	newKey: NonEmptyField,
	source: Field,
	activate: Schema.Boolean,
	configFile: Schema.optionalKey(NonEmptyField)
});
export type StringTableRedirectRequest = typeof StringTableRedirectRequest.Type;

/** Active requires the exact table, destination key and source; inactive never authorizes deletion. */
export const StringTableRedirectResult = Schema.Struct({
	contract: Schema.Literal("ue-shed-string-table-redirect"),
	version: Schema.Literal("1.0"),
	status: Schema.Literals(["active", "inactive", "invalid_request"]),
	tableId: Schema.String,
	key: Schema.String,
	source: Schema.String,
	message: Schema.String
});
export type StringTableRedirectResult = typeof StringTableRedirectResult.Type;
