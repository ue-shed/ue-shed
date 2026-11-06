import { LocalizationTargetName } from "@ue-shed/localization/browser";
import type { GameTextContract } from "@ue-shed/protocol";
import { Schema } from "effect";
import { TextCorpusPublicError } from "./schema.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The most changes one `changedSince` page lists: the engine's `MAX_CHANGES_PAGE`. */
export const MAX_CHANGES_PAGE = 1000;

/**
 * What changed in a target since an earlier `generation` of it. Without `target`, the
 * workspace's scanned model; with one, that selected localization target. `kind` names what to
 * list: the target's `lines`, by line ID, or its project's `packages`, by path. Page with
 * `after`, the `nextCursor` of the previous page.
 */
export const ChangedSinceRequest = Schema.Struct({
	target: Schema.optionalKey(LocalizationTargetName),
	since: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
	kind: Schema.Literals(["lines", "packages"]),
	after: Schema.optionalKey(Schema.NonEmptyString),
	limit: Schema.Int.check(
		Schema.isGreaterThanOrEqualTo(1),
		Schema.isLessThanOrEqualTo(MAX_CHANGES_PAGE)
	)
});
export type ChangedSinceRequest = typeof ChangedSinceRequest.Type;

/** One changed line or package; a line with a gathered identity has its namespace and key. */
export const ChangedItem = Schema.Struct({
	change: Schema.Literals(["added", "changed", "removed"]),
	id: Schema.String,
	namespace: Schema.optionalKey(Schema.String),
	key: Schema.optionalKey(Schema.String)
});
export type ChangedItem = typeof ChangedItem.Type;

/**
 * The engine's answer, as the workspace serves it:
 * - `same`: `since` is the current generation;
 * - `too_old`: the store no longer holds that generation or one of its inputs (`compacted`),
 *   wrote it in another format (`format`), or never produced it for this target (`unknown`). The
 *   host decides what to do instead, such as reading everything again;
 * - `changes`: every change's counts, and a page of them in ID order.
 */
export const ChangedSinceAnswer = Schema.Union([
	Schema.Struct({ status: Schema.Literal("same") }),
	Schema.Struct({
		status: Schema.Literal("too_old"),
		reason: Schema.Literals(["compacted", "format", "unknown"])
	}),
	Schema.Struct({
		status: Schema.Literal("changes"),
		counts: Schema.Struct({ added: Count, changed: Count, removed: Count }),
		items: Schema.Array(ChangedItem).check(Schema.isMaxLength(MAX_CHANGES_PAGE)),
		nextCursor: Schema.optionalKey(Schema.String)
	})
]);
export type ChangedSinceAnswer = typeof ChangedSinceAnswer.Type;

/** `workspace.changedSince`'s answer: the engine's, or why there is none yet. */
export const ChangedSinceResult = Schema.Union([
	...ChangedSinceAnswer.members,
	Schema.Struct({ status: Schema.Literal("not_ready") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: TextCorpusPublicError })
]);
export type ChangedSinceResult = typeof ChangedSinceResult.Type;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;
// The workspace serves the engine's own request and answer: these fail to compile if they drift.
export type ChangedSinceAnswerMatchesEngine = Holds<
	Same<ChangedSinceAnswer, GameTextContract.ChangedSinceAnswer>
>;
export type ChangedSinceRequestMatchesEngine = Holds<
	Same<Omit<ChangedSinceRequest, "target">, GameTextContract.ChangedSinceRequest>
>;
