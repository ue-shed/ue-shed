import { Schema } from "effect";

const version = Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) });
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const AutomationObjectPath = Schema.NonEmptyString.check(
	Schema.isMaxLength(2048),
	// eslint-disable-next-line no-control-regex -- Object paths cannot contain control characters.
	Schema.isPattern(/^\/[^\u0000-\u001f]*$/)
);

export const AutomationError = Schema.Struct({
	code: Schema.NonEmptyString,
	message: Schema.String
});

export const AutomationPlayersContract = Schema.Struct({
	name: Schema.Literal("unreal-automation-players"),
	version
});
export const AutomationPlayersRequest = Schema.Struct({
	contract: AutomationPlayersContract,
	worldObjectPath: AutomationObjectPath
}).annotate({ identifier: "AutomationPlayersRequest" });
export type AutomationPlayersRequest = typeof AutomationPlayersRequest.Type;

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

export const AutomationInputContract = Schema.Struct({
	name: Schema.Literal("unreal-automation-input"),
	version
});
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
export const AutomationInputRequest = Schema.Struct({
	contract: AutomationInputContract,
	worldObjectPath: AutomationObjectPath,
	playerControllerObjectPath: AutomationObjectPath,
	actionObjectPath: AutomationObjectPath,
	value: AutomationInputValue
}).annotate({ identifier: "AutomationInputRequest" });
export type AutomationInputRequest = typeof AutomationInputRequest.Type;

export const AutomationInputResult = Schema.Struct({
	contract: AutomationInputContract,
	status: Schema.Literals(["injected", "rejected"]),
	worldObjectPath: Schema.String,
	playerControllerObjectPath: Schema.String,
	actionObjectPath: Schema.String,
	errors: Schema.Array(AutomationError)
}).annotate({ identifier: "AutomationInputResult" });
export type AutomationInputResult = typeof AutomationInputResult.Type;

export const AutomationCsvContract = Schema.Struct({
	name: Schema.Literal("unreal-automation-csv"),
	version
});
export const AutomationCsvRequest = Schema.Struct({
	contract: AutomationCsvContract,
	command: Schema.Literals(["status", "start", "stop"])
}).annotate({ identifier: "AutomationCsvRequest" });
export type AutomationCsvRequest = typeof AutomationCsvRequest.Type;

export const AutomationCsvResult = Schema.Struct({
	contract: AutomationCsvContract,
	status: Schema.Literals(["ok", "rejected"]),
	state: Schema.Literals(["idle", "starting", "capturing", "stopping", "unavailable"]),
	outputDirectory: Schema.String,
	outputFile: Schema.NullOr(Schema.String),
	errors: Schema.Array(AutomationError)
}).annotate({ identifier: "AutomationCsvResult" });
export type AutomationCsvResult = typeof AutomationCsvResult.Type;

export const decodeAutomationPlayersRequest = Schema.decodeUnknownEffect(AutomationPlayersRequest);
export const decodeAutomationPlayersResult = Schema.decodeUnknownEffect(AutomationPlayersResult);
export const decodeAutomationInputRequest = Schema.decodeUnknownEffect(AutomationInputRequest);
export const decodeAutomationInputResult = Schema.decodeUnknownEffect(AutomationInputResult);
export const decodeAutomationCsvRequest = Schema.decodeUnknownEffect(AutomationCsvRequest);
export const decodeAutomationCsvResult = Schema.decodeUnknownEffect(AutomationCsvResult);
