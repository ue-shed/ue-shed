import { Schema } from "effect";
import { LocalizationGateChange, LocalizationGateCheck } from "./localization-gate.js";
import { MAX_TEXT_SCOPE_FILES } from "./schema.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Changelist = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** The most changes or findings one comparison page lists: the engine's largest page. */
export const MAX_CHANGE_PAGE = 1000;

/**
 * The change a comparison reads:
 * - `submitted`: a submitted changelist, against the changelist before it;
 * - `shelved`: a pending changelist's shelved files, against the depot's head;
 * - `range`: the changelists after `from` up to `to`, against `from`;
 * - `local`: listed working-copy files as they are on disk, against the revisions the workspace
 *   has. Paths are relative to the project folder, with `/`.
 */
export const GameTextChange = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("submitted"), change: Changelist }),
	Schema.Struct({ kind: Schema.Literal("shelved"), change: Changelist }),
	Schema.Struct({ kind: Schema.Literal("range"), from: Changelist, to: Changelist }),
	Schema.Struct({
		kind: Schema.Literal("local"),
		files: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_TEXT_SCOPE_FILES))
	})
]);
export type GameTextChange = typeof GameTextChange.Type;

/**
 * The ids of a change's two points: `depot@<CL>`, `shelved:<CL>`, `range:<from>..<to>` or `local`,
 * and `before.` and that for its base. The engine keeps one point per id, so two reads of the
 * same id must not run at once.
 */
export function gameTextChangePoints(change: GameTextChange) {
	const point =
		change.kind === "submitted"
			? `depot@${change.change}`
			: change.kind === "shelved"
				? `shelved:${change.change}`
				: change.kind === "range"
					? `range:${change.from}..${change.to}`
					: "local";
	return { point, base: `before.${point}` };
}

/** A change in words: `changelist 1200`, `shelved changelist 1200`, `changelists 1100 to 1200`. */
export function gameTextChangeLabel(change: GameTextChange): string {
	switch (change.kind) {
		case "submitted":
			return `changelist ${change.change}`;
		case "shelved":
			return `shelved changelist ${change.change}`;
		case "range":
			return `changelists ${change.from} to ${change.to}`;
		case "local":
			return `${change.files.length} working-copy ${change.files.length === 1 ? "file" : "files"}`;
	}
}

const Page = Schema.Struct({
	offset: Count,
	limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CHANGE_PAGE }))
});

/** `compareChange`: the change, one target or every target, and a page of changes and findings. */
export const ChangeComparisonRequest = Schema.Struct({
	change: GameTextChange,
	/** One localization target; every target the project has when absent. */
	target: Schema.optionalKey(Schema.String),
	changes: Page,
	findings: Page,
	/** Policy: checks that fail beside the defaults, and checks that only warn. */
	failOn: Schema.optionalKey(Schema.Array(LocalizationGateCheck)),
	warnOn: Schema.optionalKey(Schema.Array(LocalizationGateCheck))
});
export type ChangeComparisonRequest = typeof ChangeComparisonRequest.Type;

/** Where a changed text is: an asset property, a DataTable cell, a String Table entry or code. */
export const ChangePlace = Schema.Struct({
	kind: Schema.Literals(["asset_property", "data_table_cell", "string_table_entry", "code"]),
	object: Schema.String,
	/** DataTable row or String Table entry key; empty otherwise. */
	entry: Schema.String,
	/** Property chain, or the macro in code. */
	property: Schema.String,
	/** In code, the line. */
	line: Schema.optionalKey(Count)
});
export type ChangePlace = typeof ChangePlace.Type;

/** A text at one side of a change, with how its key resolved. */
export const ChangeText = Schema.Struct({
	status: Schema.Literals(["resolved", "string_table", "culture_invariant", "missing_key"]),
	namespace: Schema.String,
	key: Schema.String,
	source: Schema.String,
	notes: Schema.String
});
export type ChangeText = typeof ChangeText.Type;

/** One changed text: added, removed, given a new key, or edited, with both sides it has. */
export const ChangeRow = Schema.Struct({
	kind: Schema.Literals(["added", "removed", "rekeyed", "edited"]),
	/** Relative to the project folder, with `/`. */
	path: Schema.String,
	place: ChangePlace,
	before: Schema.optionalKey(ChangeText),
	after: Schema.optionalKey(ChangeText),
	sourceChanged: Schema.Boolean,
	notesChanged: Schema.Boolean
});
export type ChangeRow = typeof ChangeRow.Type;

/** A check a change failed or warned on, with the cultures it affects. */
export const ChangeFinding = Schema.Struct({
	check: LocalizationGateCheck,
	path: Schema.String,
	/** The key the finding is about; none for a file's finding or text with no key. */
	namespace: Schema.optionalKey(Schema.String),
	key: Schema.optionalKey(Schema.String),
	source: Schema.String,
	/** The cultures whose translations the change makes stale or leaves behind. */
	cultures: Schema.Array(Schema.String),
	/** For a key change, the earlier key. */
	earlier: Schema.optionalKey(Schema.Struct({ namespace: Schema.String, key: Schema.String })),
	/** Whether the check fails or warns under the request's policy. */
	severity: Schema.Literals(["fail", "warn"]),
	/** The way forward, naming the step in Unreal. */
	guidance: Schema.String
});
export type ChangeFinding = typeof ChangeFinding.Type;

const FindingCounts = Schema.Struct({
	keyChanged: Count,
	conflictingSource: Count,
	translatedTextChanged: Count,
	textChanged: Count,
	notGathered: Count,
	unresolvedKey: Count,
	removed: Count,
	gatheredSource: Count,
	partialRead: Count
});

/** One target's comparison: whole counts, and the requested page of changes and findings. */
export const ChangeComparisonTarget = Schema.Struct({
	/** Absent when the project has no target: changes only, judged against nothing. */
	target: Schema.optionalKey(Schema.String),
	/** Whether the base had the target's manifest; without it there are no findings. */
	localized: Schema.Boolean,
	/** The verdict under the request's policy, when the change was judged. */
	status: Schema.optionalKey(Schema.Literals(["passed", "failed"])),
	counts: Schema.Struct({
		added: Count,
		removed: Count,
		rekeyed: Count,
		edited: Count,
		unchanged: Count
	}),
	/** Whether every changed file was read in full. */
	complete: Schema.Boolean,
	/** Changes in all, of which `changes` is the requested page. */
	total: Count,
	changes: Schema.Array(ChangeRow).check(Schema.isMaxLength(MAX_CHANGE_PAGE)),
	findings: Schema.optionalKey(
		Schema.Struct({
			counts: FindingCounts,
			total: Count,
			/** The requested page: failing checks first, in the gate's order. */
			rows: Schema.Array(ChangeFinding).check(Schema.isMaxLength(MAX_CHANGE_PAGE))
		})
	)
});
export type ChangeComparisonTarget = typeof ChangeComparisonTarget.Type;

/**
 * `compareChange`: what the change touches and each target's comparison; `not_ready` before a
 * project is selected; `failed` when the change could not be read, with the reason.
 */
export const ChangeComparisonResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_ready") }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		code: Schema.String,
		message: Schema.String,
		recovery: Schema.String
	}),
	Schema.Struct({
		status: Schema.Literal("ready"),
		change: LocalizationGateChange,
		targets: Schema.Array(ChangeComparisonTarget)
	})
]);
export type ChangeComparisonResult = typeof ChangeComparisonResult.Type;
