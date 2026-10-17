import {
	GAME_TEXT_ACTIONS_CONTRACT,
	GAME_TEXT_ACTIONS_VERSION,
	GameTextActionsRequest,
	GameTextActionsResult,
	decodeCompanionCapabilityManifest,
	type GameTextAction,
	type GameTextActionEdit,
	type GameTextActionOutcomeIdentity
} from "@ue-shed/protocol";
import type { SavedAssetPackageTextRecord, SavedAssetTextOccurrence } from "@ue-shed/unreal-assets";
import { stripPackageNamespace } from "@ue-shed/localization";
import { RemoteControlClient, type RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Effect, Schema } from "effect";

/** The capability a running editor advertises when `UEShedGameText` is loaded. */
export const GAME_TEXT_ACTIONS_CAPABILITY = "game-text.actions.v1";
const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";

/**
 * Why a Game Text actions call produced no result. A request the plugin rejected or that failed in
 * Unreal is not this error: it is a result with `status` and typed `errors`.
 */
export class GameTextActionsError extends Schema.TaggedError<GameTextActionsError>()(
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
 * Explicit editor endpoint and guarded action request. The caller owns project/editor selection and expected saved identity; merely constructing these options neither loads nor writes a package.
 */
export interface GameTextActionsOptions {
	/** Remote Control HTTP endpoint of the running editor, for example `http://127.0.0.1:30010`. */
	readonly endpoint: string;
	readonly request: GameTextActionsRequest;
}

/** A request with the contract header and explicit defaults (compile, no save) filled in. */
export function gameTextActionsRequest(options: {
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

/**
 * One action for a text the saved-package reader found, expecting the id and source it read. The
 * reader reports the namespace as saved, with the package namespace marker (`[...]`); actions use
 * the namespace Gather reports, without it. Only
 * localized asset-property text is editable here: DataTable cells go through authoring, and
 * culture-invariant or String Table text has no key of its own. Keep the owning reader record's
 * packageFile with the occurrence; serialized object paths alone cannot identify copied assets.
 */
export function gameTextActionForOccurrence(
	id: string,
	occurrence: SavedAssetTextOccurrence,
	edit: GameTextActionEdit,
	packageFile: string
): GameTextAction | undefined {
	if (occurrence.location.kind !== "asset_property") return undefined;
	if (occurrence.identity.status !== "resolved") return undefined;
	return {
		id,
		place: {
			packageFile,
			objectPath: occurrence.location.object_path,
			propertyPath: occurrence.location.property_path
		},
		expected: {
			namespace: stripPackageNamespace(occurrence.identity.namespace),
			key: occurrence.identity.key,
			source: occurrence.source
		},
		edit
	};
}

const decodeRequest = Schema.decodeUnknownEffect(GameTextActionsRequest);
const decodeResult = Schema.decodeUnknownEffect(GameTextActionsResult);

function connectionFailed(endpoint: string, error: RemoteControlClientError, mutation = false) {
	const retrySafe = !mutation && error.retrySafe;
	return new GameTextActionsError({
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
export const runGameTextActions = Effect.fn("game_text.actions.run")(function* (
	options: GameTextActionsOptions
) {
	const endpoint = options.endpoint.replace(/\/+$/u, "");
	const request = yield* decodeRequest(options.request).pipe(
		Effect.mapError(
			(cause) =>
				new GameTextActionsError({
					code: "invalid_request",
					message: "The Game Text actions request does not match the 1.0 contract.",
					recovery: "Build the request with gameTextActionsRequest and valid actions.",
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
				new GameTextActionsError({
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
	if (!objectPath || !manifest.capabilities.includes(GAME_TEXT_ACTIONS_CAPABILITY)) {
		return yield* new GameTextActionsError({
			code: "capability_missing",
			message: "The running editor does not advertise Game Text actions.",
			recovery: "Enable the UEShedGameText plugin in the editor, then retry.",
			retrySafe: false,
			nextStep: "fix_input",
			endpoint
		});
	}
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
				new GameTextActionsError({
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

/** One applied action whose re-read text is not what the editor reported. */
export interface GameTextActionMismatch {
	readonly actionId: string;
	readonly expected: GameTextActionOutcomeIdentity;
	/** The text the reader found at the place, or absent when it found none. */
	readonly found?: { readonly namespace: string; readonly key: string; readonly source: string };
}

/**
 * Saved-file verification after an editor apply. verified counts matching results, mismatches retain provenance, and complete is false when a re-read package supplied only partial evidence.
 */
export interface GameTextActionsVerification {
	readonly verified: number;
	readonly mismatches: readonly GameTextActionMismatch[];
	/** False when a re-read package was read only in part. */
	readonly complete: boolean;
}

/** Object paths inside the same physical file can retain an older serialized package name. */
function packageObjectPath(objectPath: string): string {
	if (!objectPath.startsWith("/")) return objectPath;
	const dot = objectPath.indexOf(".");
	return dot < 0 ? objectPath : objectPath.slice(dot + 1);
}

function samePackageFile(left: string, right: string): boolean {
	return left.replaceAll("\\", "/") === right.replaceAll("\\", "/");
}

/**
 * Compares the packages re-read after an apply with what the editor reported for each applied
 * action, place by place. Pure; reading the packages stays with the caller.
 */
export function verifyGameTextActions(
	request: GameTextActionsRequest,
	result: GameTextActionsResult,
	records: readonly SavedAssetPackageTextRecord[]
): GameTextActionsVerification {
	const occurrences = records.flatMap((record) =>
		record.occurrences.map((occurrence) => ({ file: record.path, occurrence }))
	);
	const mismatches: GameTextActionMismatch[] = [];
	let verified = 0;
	for (const outcome of result.actions) {
		if (outcome.status !== "applied") continue;
		const action = request.actions.find((candidate) => candidate.id === outcome.id);
		if (!action) continue;
		const occurrence = occurrences.find(
			({ file, occurrence: candidate }) =>
				candidate.location.kind === "asset_property" &&
				candidate.location.property_path === action.place.propertyPath &&
				samePackageFile(file, action.place.packageFile) &&
				packageObjectPath(candidate.location.object_path) ===
					packageObjectPath(action.place.objectPath)
		)?.occurrence;
		const found =
			occurrence?.identity.status === "resolved"
				? {
						namespace: stripPackageNamespace(occurrence.identity.namespace),
						key: occurrence.identity.key,
						source: occurrence.source
					}
				: undefined;
		const matches =
			found !== undefined &&
			found.namespace === outcome.after.namespace &&
			found.source === outcome.after.source &&
			(outcome.after.key === undefined || found.key === outcome.after.key);
		if (matches) verified += 1;
		else
			mismatches.push(
				found === undefined
					? { actionId: outcome.id, expected: outcome.after }
					: { actionId: outcome.id, expected: outcome.after, found }
			);
	}
	return {
		verified,
		mismatches,
		complete: records.every((record) => record.status === "complete")
	};
}
