import {
	GAME_TEXT_ACTIONS_CONTRACT,
	GAME_TEXT_ACTIONS_VERSION,
	GameTextActionsRequest,
	GameTextActionsResult,
	StringTableRedirectRequest,
	StringTableRedirectResult,
	decodeCompanionCapabilityManifest,
	type GameTextAction
} from "@ue-shed/protocol";
import {
	RemoteControlClient,
	inspectUnrealProducer,
	type RemoteControlClientError
} from "@ue-shed/unreal-connection";
import { Effect, Schema } from "effect";

/** The capability a running editor advertises when `UEShedGameText` is loaded. */
export const LOCALIZATION_TEXT_ACTIONS_CAPABILITY = "game-text.actions.v1";
/** Capability for graph pins, table entries/cells, reference migration and explicit conversion. */
export const LOCALIZATION_TEXT_AUTHORING_CAPABILITY = "game-text.actions.authoring.v1";
/** Key identity changes on object properties, DataTable cells and Blueprint pins only. */
export const LOCALIZATION_TEXT_KEY_REPAIRS_CAPABILITY = "game-text.actions.key-repairs.v1";
const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";

/**
 * Why a Game Text actions call produced no result. A request the plugin rejected or that failed in
 * Unreal is not this error: it is a result with `status` and typed `errors`.
 */
export class LocalizationTextActionsError extends Schema.TaggedError<LocalizationTextActionsError>()(
	// Retain the established tag for consumers of the Game Text compatibility export.
	"GameTextActionsError",
	{
		code: Schema.Literals([
			"invalid_request",
			"capability_missing",
			"connection_failed",
			"invalid_result"
		]),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
		endpoint: Schema.optionalKey(Schema.String),
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

/**
 * Explicit editor endpoint and guarded action request. The caller owns project/editor selection
 * and expected saved identity; merely constructing these options neither loads nor writes a
 * package.
 */
export interface LocalizationTextActionsOptions {
	/** Remote Control HTTP endpoint of the running editor, for example `http://127.0.0.1:30010`. */
	readonly endpoint: string;
	readonly request: GameTextActionsRequest;
}

/** A request with the contract header and explicit defaults (compile, no save) filled in. */
export function localizationTextActionsRequest(options: {
	readonly mode: GameTextActionsRequest["mode"];
	readonly actions: readonly GameTextAction[];
	readonly compile?: boolean;
	readonly save?: boolean;
}): GameTextActionsRequest {
	return {
		contract: GAME_TEXT_ACTIONS_CONTRACT,
		version: GAME_TEXT_ACTIONS_VERSION,
		mode: options.mode,
		compile: options.compile ?? true,
		save: options.save ?? false,
		actions: options.actions
	};
}

const decodeRequest = Schema.decodeUnknownEffect(GameTextActionsRequest);
const decodeResult = Schema.decodeUnknownEffect(GameTextActionsResult);

function connectionFailed(endpoint: string, error: RemoteControlClientError, mutation = false) {
	const retrySafe = !mutation && error.retrySafe;
	return new LocalizationTextActionsError({
		code: "connection_failed",
		message: `Remote Control call ${error.functionName} to ${endpoint} failed.`,
		recovery: retrySafe
			? "Check that the editor is running with Remote Control enabled, then retry."
			: "Reconcile the editor state and saved files before issuing another mutation; the reply may have been lost.",
		retrySafe,
		nextStep: retrySafe ? "retry" : "reconcile",
		endpoint,
		cause: error
	});
}

/**
 * Sends a Game Text actions request to a running editor with `UEShedGameText` loaded. An apply
 * changes the editor's objects, so it is not retried here: on `connection_failed`, read the text
 * again before sending another request.
 */
export const runLocalizationTextActions = Effect.fn("game_text.actions.run")(function* (
	options: LocalizationTextActionsOptions
) {
	const endpoint = options.endpoint.replace(/\/+$/u, "");
	const request = yield* decodeRequest(options.request).pipe(
		Effect.mapError(
			(cause) =>
				new LocalizationTextActionsError({
					code: "invalid_request",
					message: "The Game Text actions request does not match the 1.0 contract.",
					recovery:
						"Build the request with localizationTextActionsRequest and valid actions.",
					retrySafe: false,
					nextStep: "fix_input",
					cause
				})
		)
	);
	const client = yield* RemoteControlClient;
	const manifestValue = yield* client
		.request({
			endpoint,
			objectPath: coreObjectPath,
			functionName: "GetCapabilityManifest",
			idempotent: true,
			operation: "game_text.actions.manifest",
			parameters: {}
		})
		.pipe(Effect.mapError((error) => connectionFailed(endpoint, error)));
	const manifest = yield* decodeCompanionCapabilityManifest(manifestValue).pipe(
		Effect.mapError(
			(cause) =>
				new LocalizationTextActionsError({
					code: "invalid_result",
					message: "The editor's capability manifest could not be read.",
					recovery: "Use matching UE Shed plugin and package versions.",
					retrySafe: false,
					nextStep: "escalate",
					endpoint,
					cause
				})
		)
	);
	const objectPath = manifest.gameTextObjectPath;
	if (!objectPath || !manifest.capabilities.includes(LOCALIZATION_TEXT_ACTIONS_CAPABILITY)) {
		return yield* new LocalizationTextActionsError({
			code: "capability_missing",
			message: "The running editor does not advertise Game Text actions.",
			recovery: "Enable the UEShedGameText plugin in the editor, then retry.",
			retrySafe: false,
			nextStep: "fix_input",
			endpoint
		});
	}
	const keyRepairs = manifest.capabilities.includes(LOCALIZATION_TEXT_KEY_REPAIRS_CAPABILITY);
	const extended = request.actions.some((action) => {
		const keyRepair =
			keyRepairs &&
			["change_key", "regenerate_key", "adopt_key"].includes(action.edit.kind) &&
			!("tableId" in action.expected) &&
			!("unresolved" in action.expected) &&
			(action.place.selector === undefined ||
				["data_table_cell", "graph_pin"].includes(action.place.selector.kind));
		return (
			!keyRepair &&
			(action.place.selector !== undefined ||
				"tableId" in action.expected ||
				"unresolved" in action.expected ||
				!["change_key", "regenerate_key", "adopt_key", "change_source"].includes(
					action.edit.kind
				))
		);
	});
	if (extended && !manifest.capabilities.includes(LOCALIZATION_TEXT_AUTHORING_CAPABILITY))
		return yield* new LocalizationTextActionsError({
			code: "capability_missing",
			message:
				"The editor does not advertise the requested localization authoring operations.",
			recovery:
				"Enable a matching UEShedGameText plugin with game-text.actions.authoring.v1.",
			retrySafe: false,
			nextStep: "fix_input",
			endpoint
		});
	const value = yield* client
		.request({
			endpoint,
			objectPath,
			functionName: "ApplyTextActions",
			operation: `game_text.actions.${request.mode}`,
			parameters: { RequestJson: JSON.stringify(request) }
		})
		.pipe(Effect.mapError((error) => connectionFailed(endpoint, error, true)));
	return yield* decodeResult(value).pipe(
		Effect.mapError(
			(cause) =>
				new LocalizationTextActionsError({
					code: "invalid_result",
					message:
						"The editor returned a Game Text actions result that does not match 1.0.",
					recovery:
						"Use matching UE Shed plugin and package versions, then read the text again before retrying.",
					retrySafe: false,
					nextStep: "reconcile",
					endpoint,
					cause
				})
		)
	);
});

/** Checks a runtime redirect or activates the exact mapping already persisted in project config. */
export const verifyLocalizationStringTableRedirect = Effect.fn(
	"Localization.stringTable.verifyRedirect"
)(function* (options: { readonly endpoint: string; readonly request: StringTableRedirectRequest }) {
	const request = yield* Schema.decodeUnknownEffect(StringTableRedirectRequest)(
		options.request
	).pipe(
		Effect.mapError(
			(cause) =>
				new LocalizationTextActionsError({
					code: "invalid_request",
					cause,
					message: "The String Table redirect request is invalid.",
					recovery: "Review the table, key mapping and persisted config path.",
					retrySafe: false,
					nextStep: "fix_input"
				})
		)
	);
	const manifest = yield* inspectUnrealProducer(options.endpoint).pipe(
		Effect.mapError(
			(cause) =>
				new LocalizationTextActionsError({
					code: "connection_failed",
					cause,
					message: "Cannot inspect the editor's redirect capability.",
					recovery: "Use a matching editor with the localization authoring capability.",
					retrySafe: false,
					nextStep: "reconcile"
				})
		)
	);
	if (
		!manifest.gameTextObjectPath ||
		!manifest.capabilities.includes(LOCALIZATION_TEXT_AUTHORING_CAPABILITY)
	)
		return yield* new LocalizationTextActionsError({
			code: "capability_missing",
			message: "String Table redirect verification is unavailable.",
			recovery: "Enable a matching UEShedGameText plugin.",
			retrySafe: false,
			nextStep: "fix_input"
		});
	const client = yield* RemoteControlClient;
	const value = yield* client
		.request({
			endpoint: options.endpoint,
			objectPath: manifest.gameTextObjectPath,
			functionName: "VerifyStringTableRedirect",
			operation: "localization.string_table.redirect",
			idempotent: !request.activate,
			parameters: { RequestJson: JSON.stringify(request) }
		})
		.pipe(
			Effect.mapError((error) => connectionFailed(options.endpoint, error, request.activate))
		);
	return yield* Schema.decodeUnknownEffect(StringTableRedirectResult)(value).pipe(
		Effect.mapError(
			(cause) =>
				new LocalizationTextActionsError({
					code: "invalid_result",
					cause,
					message: "Cannot read the redirect verification result.",
					recovery: "Inspect the saved migration receipt and current editor state.",
					retrySafe: false,
					nextStep: "reconcile"
				})
		)
	);
});
