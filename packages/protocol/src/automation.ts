import { Schema } from "effect";

const version = Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) });
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * An absolute Unreal object path as sent to the UEShedAutomation plugin: starts with `/`, at most
 * 2048 characters, no control characters. The plugin rejects other paths with `invalid_request`.
 */
export const AutomationObjectPath = Schema.NonEmptyString.check(
	Schema.isMaxLength(2048),
	// eslint-disable-next-line no-control-regex -- Object paths cannot contain control characters.
	Schema.isPattern(/^\/[^\u0000-\u001f]*$/u)
);

/**
 * Why the plugin rejected a request. `code` is machine-readable (for example `world_not_found` or
 * `unsupported_contract`) and `message` gives recovery guidance. The plugin reports at most one.
 */
export const AutomationError = Schema.Struct({
	code: Schema.NonEmptyString,
	message: Schema.String
});

/**
 * Version 1.0 of the `unreal-automation-players` contract. The plugin rejects any other name or
 * version with `unsupported_contract`.
 */
export const AutomationPlayersContract = Schema.Struct({
	name: Schema.Literal("unreal-automation-players"),
	version
});
/**
 * Asks the plugin to list local players in an already-loaded game, PIE or game-preview world. The
 * plugin limits request JSON to 16384 UTF-8 bytes and must be called on the game thread.
 */
export const AutomationPlayersRequest = Schema.Struct({
	contract: AutomationPlayersContract,
	worldObjectPath: AutomationObjectPath
}).annotate({ identifier: "AutomationPlayersRequest" });
export type AutomationPlayersRequest = typeof AutomationPlayersRequest.Type;

/**
 * Local player controllers in the requested world, in local-player order. On `rejected`, `errors`
 * holds the reason and `players` is empty. `worldObjectPath` echoes the request, or is empty if it
 * was unreadable. `playerInputObjectPath` is null when the controller has no PlayerInput.
 */
export const AutomationPlayersResult = Schema.Struct({
	contract: AutomationPlayersContract,
	status: Schema.Literals(["ok", "rejected"]),
	worldObjectPath: Schema.String,
	players: Schema.Array(
		Schema.Struct({
			controllerObjectPath: Schema.NonEmptyString,
			playerInputObjectPath: Schema.NullOr(Schema.NonEmptyString),
			localPlayerIndex: nonNegativeInt
		})
	),
	errors: Schema.Array(AutomationError)
}).annotate({ identifier: "AutomationPlayersResult" });
export type AutomationPlayersResult = typeof AutomationPlayersResult.Type;

/**
 * Version 1.0 of the `unreal-automation-input` contract. The plugin rejects any other name or
 * version with `unsupported_contract`.
 */
export const AutomationInputContract = Schema.Struct({
	name: Schema.Literal("unreal-automation-input"),
	version
});
/**
 * A typed Enhanced Input action value. Its kind must match the Input Action's value type exactly;
 * the plugin also rejects coordinates whose magnitude exceeds the float range.
 */
export const AutomationInputValue = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("boolean"), value: Schema.Boolean }),
	Schema.Struct({ kind: Schema.Literal("axis1d"), x: Schema.Finite }),
	Schema.Struct({ kind: Schema.Literal("axis2d"), x: Schema.Finite, y: Schema.Finite }),
	Schema.Struct({
		kind: Schema.Literal("axis3d"),
		x: Schema.Finite,
		y: Schema.Finite,
		z: Schema.Finite
	})
]);
export type AutomationInputValue = typeof AutomationInputValue.Type;
/**
 * Injects one value into the next Enhanced Input evaluation of a local player's controller in the
 * selected game or PIE world. The world, controller and Input Action must already be loaded.
 */
export const AutomationInputRequest = Schema.Struct({
	contract: AutomationInputContract,
	worldObjectPath: AutomationObjectPath,
	playerControllerObjectPath: AutomationObjectPath,
	actionObjectPath: AutomationObjectPath,
	value: AutomationInputValue
}).annotate({ identifier: "AutomationInputRequest" });
export type AutomationInputRequest = typeof AutomationInputRequest.Type;

/**
 * Outcome of one injection: `injected`, or `rejected` with an error such as `controller_not_local`,
 * `action_not_found` or `value_type_mismatch`. Each path echoes the request's value even on
 * rejection, and is empty when the request omitted it.
 */
export const AutomationInputResult = Schema.Struct({
	contract: AutomationInputContract,
	status: Schema.Literals(["injected", "rejected"]),
	worldObjectPath: Schema.String,
	playerControllerObjectPath: Schema.String,
	actionObjectPath: Schema.String,
	errors: Schema.Array(AutomationError)
}).annotate({ identifier: "AutomationInputResult" });
export type AutomationInputResult = typeof AutomationInputResult.Type;

/**
 * Version 1.0 of the `unreal-automation-csv` contract. The plugin rejects any other name or version
 * with `unsupported_contract`.
 */
export const AutomationCsvContract = Schema.Struct({
	name: Schema.Literal("unreal-automation-csv"),
	version
});
/**
 * A command for Unreal's CSV profiler: `status` reports state, `start` begins a capture owned by UE
 * Shed, and `stop` ends only a capture UE Shed started.
 */
export const AutomationCsvRequest = Schema.Struct({
	contract: AutomationCsvContract,
	command: Schema.Literals(["status", "start", "stop"])
}).annotate({ identifier: "AutomationCsvRequest" });
export type AutomationCsvRequest = typeof AutomationCsvRequest.Type;

/**
 * CSV profiler state after a command. `outputDirectory` is the absolute capture directory under the
 * project's profiling directory; `outputFile` stays null until an owned capture has started.
 * `state` is `unavailable` when the request is rejected early or the build lacks CSV_PROFILER.
 */
export const AutomationCsvResult = Schema.Struct({
	contract: AutomationCsvContract,
	status: Schema.Literals(["ok", "rejected"]),
	state: Schema.Literals(["idle", "starting", "capturing", "stopping", "unavailable"]),
	outputDirectory: Schema.String,
	outputFile: Schema.NullOr(Schema.String),
	errors: Schema.Array(AutomationError)
}).annotate({ identifier: "AutomationCsvResult" });
export type AutomationCsvResult = typeof AutomationCsvResult.Type;

/** Validates unknown input against the players request contract; fails with a SchemaError. */
export const decodeAutomationPlayersRequest = Schema.decodeUnknownEffect(AutomationPlayersRequest);
/** Validates a plugin response against the players result contract; fails with a SchemaError. */
export const decodeAutomationPlayersResult = Schema.decodeUnknownEffect(AutomationPlayersResult);
/** Validates unknown input against the input request contract; fails with a SchemaError. */
export const decodeAutomationInputRequest = Schema.decodeUnknownEffect(AutomationInputRequest);
/** Validates a plugin response against the input result contract; fails with a SchemaError. */
export const decodeAutomationInputResult = Schema.decodeUnknownEffect(AutomationInputResult);
/** Validates unknown input against the CSV request contract; fails with a SchemaError. */
export const decodeAutomationCsvRequest = Schema.decodeUnknownEffect(AutomationCsvRequest);
/** Validates a plugin response against the CSV result contract; fails with a SchemaError. */
export const decodeAutomationCsvResult = Schema.decodeUnknownEffect(AutomationCsvResult);
