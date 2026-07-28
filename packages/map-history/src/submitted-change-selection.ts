import { DateTime, Effect, Schema } from "effect";
import { MapHistoryError } from "./errors.js";
import { PerforceHistorySource, type PerforceSubmittedChange } from "./perforce.js";
import { UtcTimestamp, type MapHistoryRange } from "./schema.js";

const decodeUtcTimestamp = Schema.decodeUnknownEffect(UtcTimestamp);

export interface SelectedSubmittedChange extends Omit<PerforceSubmittedChange, "submittedAt"> {
	readonly submittedAt: UtcTimestamp;
}

export interface SubmittedChangeSelection {
	readonly baseline: SelectedSubmittedChange | undefined;
	readonly revisions: readonly SelectedSubmittedChange[];
}

export interface SelectSubmittedChangesOptions {
	readonly fileSpecs: readonly string[];
	readonly maxChangelists: number;
	readonly range: MapHistoryRange;
}

interface TimedSubmittedChange {
	readonly change: SelectedSubmittedChange;
	readonly submittedAtMillis: number;
}

function selectionError(message: string, recovery: string): MapHistoryError {
	return new MapHistoryError({
		kind: "perforce_command",
		message,
		recovery,
		retrySafe: false
	});
}

function resourceLimitError(maxChangelists: number): MapHistoryError {
	return new MapHistoryError({
		kind: "resource_limit",
		message: `The selected history contains more than ${maxChangelists} changelists.`,
		recovery: "Narrow the time range or raise maxChangelists explicitly.",
		retrySafe: false
	});
}

function normalizeSubmittedChange(
	change: PerforceSubmittedChange
): Effect.Effect<TimedSubmittedChange, MapHistoryError> {
	if (change.submittedAt === undefined) {
		return Effect.fail(
			selectionError(
				`Submitted changelist ${change.change} has no normalized submission timestamp.`,
				"Check the Perforce server response and retry."
			)
		);
	}
	return decodeUtcTimestamp(change.submittedAt).pipe(
		Effect.map((submittedAt) => ({
			change: { ...change, submittedAt },
			submittedAtMillis: DateTime.toEpochMillis(submittedAt)
		})),
		Effect.mapError(() =>
			selectionError(
				`Submitted changelist ${change.change} has an invalid submission timestamp.`,
				"Check the Perforce server response and retry."
			)
		)
	);
}

/**
 * Pages only a resolved map scope, retaining the closest submitted changelist before the range as
 * its baseline and ordering in-range changelists from oldest to newest.
 */
export function selectSubmittedChanges(
	options: SelectSubmittedChangesOptions
): Effect.Effect<SubmittedChangeSelection, MapHistoryError, PerforceHistorySource> {
	return Effect.fn("MapHistory.selectSubmittedChanges")(function* () {
		if (options.fileSpecs.length === 0) {
			return yield* Effect.fail(
				new MapHistoryError({
					kind: "invalid_target",
					message: "Map history needs at least one resolved Perforce file scope.",
					recovery:
						"Resolve the selected map to a Perforce depot path before listing history.",
					retrySafe: false
				})
			);
		}

		const source = yield* PerforceHistorySource;
		const selected = new Map<number, SelectedSubmittedChange>();
		const since = DateTime.toEpochMillis(options.range.since);
		const until = DateTime.toEpochMillis(options.range.until);
		const pageLimit = Math.min(50, options.maxChangelists + 1);
		let baseline: SelectedSubmittedChange | undefined;
		let beforeChange: number | undefined;

		while (true) {
			const fileSpec =
				options.fileSpecs.length === 1 ? options.fileSpecs[0] : [...options.fileSpecs];
			if (fileSpec === undefined) {
				return yield* Effect.die("Map history file scope disappeared after validation.");
			}
			const page = yield* source.listSubmittedChangelists({
				...(beforeChange === undefined ? {} : { beforeChange }),
				fileSpec,
				limit: pageLimit
			});
			if (page.items.length === 0) {
				if (page.hasMore) {
					return yield* Effect.fail(
						selectionError(
							"Perforce reported more submitted changelists without a result page.",
							"Check the Perforce server response and retry."
						)
					);
				}
				break;
			}

			const timed: TimedSubmittedChange[] = [];
			for (const change of page.items) {
				timed.push(yield* normalizeSubmittedChange(change));
			}
			timed.sort((left, right) => right.change.change - left.change.change);
			let encounteredBaseline = false;
			for (const candidate of timed) {
				if (candidate.submittedAtMillis < since) {
					baseline ??= candidate.change;
					encounteredBaseline = true;
					continue;
				}
				if (candidate.submittedAtMillis > until) continue;
				selected.set(candidate.change.change, candidate.change);
				if (selected.size > options.maxChangelists) {
					return yield* Effect.fail(resourceLimitError(options.maxChangelists));
				}
			}
			if (encounteredBaseline || !page.hasMore) break;
			if (
				page.nextBeforeChange === null ||
				(beforeChange !== undefined && page.nextBeforeChange >= beforeChange)
			) {
				return yield* Effect.fail(
					selectionError(
						"Perforce submitted-changelist pagination did not provide a descending cursor.",
						"Check the Perforce server response and retry."
					)
				);
			}
			beforeChange = page.nextBeforeChange;
		}

		return {
			baseline,
			revisions: [...selected.values()].sort((left, right) => left.change - right.change)
		};
	})();
}
