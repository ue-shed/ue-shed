import { Effect, Metric, Result, Schema } from "effect";
import { localizationError, limitsFor } from "./decode.js";
import {
	LocalizationChangeSet,
	LocalizationChangeSetError,
	type LocalizationChange
} from "./change-sets.js";
import {
	LocalizationChangeSetReview,
	localizationChangeSetIsCurrent,
	reviewLocalizationChangeSet
} from "./change-set-review.js";
import { LocalizationFileAccess } from "./file-access.js";
import { serializePO } from "./po.js";
import { replacePOTranslations, type POEditError } from "./po-writer.js";
import { CultureCode, LocalizationError, LocalizationLimits } from "./schema.js";
import { LocalizationEvidence } from "./service.js";

export const ApplyLocalizationChangeSetRequest = Schema.Struct({
	projectRoot: Schema.NonEmptyString,
	changeSet: LocalizationChangeSet,
	/** Write the changes that are still current and report the rest, instead of writing nothing. */
	skipStale: Schema.optionalKey(Schema.Boolean),
	limits: Schema.optionalKey(LocalizationLimits)
});
export type ApplyLocalizationChangeSetRequest = typeof ApplyLocalizationChangeSetRequest.Type;

export const LocalizationChangeSetReceipt = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	/**
	 * `rejected`: a change is no longer current and nothing was written. `partially_written`: a
	 * PO file could not be replaced after others were; the written files are listed.
	 */
	status: Schema.Literals(["written", "partially_written", "rejected", "nothing_to_write"]),
	review: LocalizationChangeSetReview,
	files: Schema.Array(
		Schema.Struct({
			culture: CultureCode,
			relativePath: Schema.String,
			changes: Schema.Int,
			beforeHash: Schema.String,
			afterHash: Schema.NullOr(Schema.String),
			error: Schema.NullOr(LocalizationError)
		})
	)
});
export type LocalizationChangeSetReceipt = typeof LocalizationChangeSetReceipt.Type;

const changesWritten = Metric.counter("localization.change_set.changes_written");
const changesRejected = Metric.counter("localization.change_set.changes_rejected");

function poEditFailure(error: POEditError): LocalizationChangeSetError {
	return new LocalizationChangeSetError({
		code: "unwritable_change",
		message: error.message,
		recovery: error.recovery
	});
}

/**
 * Revalidates a change set against freshly read evidence and writes the current changes into
 * each culture's PO file. Only `msgstr` values change; Unreal imports them on the next sync.
 */
export const applyLocalizationChangeSet = Effect.fn("Localization.applyChangeSet")(function* (
	input: ApplyLocalizationChangeSetRequest
) {
	const request = yield* Schema.decodeUnknownEffect(ApplyLocalizationChangeSetRequest)(
		input
	).pipe(
		Effect.mapError(
			() =>
				new LocalizationChangeSetError({
					code: "invalid_change_set",
					message: "The change-set request does not match version 1.",
					recovery: "Provide a project root and a valid version 1 change set."
				})
		)
	);
	const limits = limitsFor(request.limits);
	const evidenceService = yield* LocalizationEvidence;
	const files = yield* LocalizationFileAccess;
	const targetNames = [...new Set(request.changeSet.changes.map((change) => change.target))];
	if (targetNames.length > 1)
		return yield* Effect.fail(
			new LocalizationChangeSetError({
				code: "multiple_targets",
				message: "The change set edits more than one localization target.",
				recovery: "Split the change set so each one edits a single target."
			})
		);
	const targetName = targetNames[0];
	if (targetName === undefined)
		return yield* Effect.fail(
			new LocalizationChangeSetError({
				code: "invalid_change_set",
				message: "The change set contains no changes.",
				recovery: "Stage at least one translation change before writing."
			})
		);
	const discovery = yield* evidenceService.discover({ projectRoot: request.projectRoot, limits });
	const target = discovery.targets.find((candidate) => candidate.name === targetName);
	if (target === undefined) return yield* Effect.fail(localizationError("target_not_found"));
	const evidence = yield* evidenceService.read({
		projectRoot: request.projectRoot,
		target,
		limits
	});
	const review = reviewLocalizationChangeSet(evidence, request.changeSet);
	const blocked = review.changes.filter(
		(item) => item.outcome !== "ready" && item.outcome !== "unchanged"
	).length;
	yield* Metric.update(changesRejected, blocked);
	if (!localizationChangeSetIsCurrent(review) && request.skipStale !== true)
		return LocalizationChangeSetReceipt.make({
			schemaVersion: 1,
			status: "rejected",
			review,
			files: []
		});
	if (review.files.length === 0)
		return LocalizationChangeSetReceipt.make({
			schemaVersion: 1,
			status: "nothing_to_write",
			review,
			files: []
		});

	const written: LocalizationChangeSetReceipt["files"][number][] = [];
	for (const file of review.files) {
		const culture = evidence.cultures.find((item) => item.culture === file.culture);
		if (culture?.po.status !== "read")
			return yield* Effect.fail(localizationError("file_changed"));
		const edits = review.changes
			.filter((item) => item.outcome === "ready" && item.change.culture === file.culture)
			.map(({ change }) => ({
				identity: identityOf(change),
				translation: change.translation
			}));
		const rewritten = replacePOTranslations(culture.po.value, edits);
		if (Result.isFailure(rewritten)) {
			if (written.length > 0) {
				written.push(failedFile(file, localizationError("file_unwritable")));
				break;
			}
			return yield* Effect.fail(poEditFailure(rewritten.failure));
		}
		const result = yield* files
			.replace(
				request.projectRoot,
				file.relativePath,
				serializePO(rewritten.success),
				file.contentHash,
				limits
			)
			.pipe(Effect.result);
		if (Result.isFailure(result)) {
			if (written.length === 0) return yield* Effect.fail(result.failure);
			written.push(failedFile(file, result.failure));
			break;
		}
		written.push({
			culture: file.culture,
			relativePath: file.relativePath,
			changes: file.changes,
			beforeHash: file.contentHash,
			afterHash: result.success.contentHash,
			error: null
		});
		yield* Metric.update(changesWritten, file.changes);
	}
	return LocalizationChangeSetReceipt.make({
		schemaVersion: 1,
		status: written.some((file) => file.error !== null) ? "partially_written" : "written",
		review,
		files: written
	});
});

function identityOf(change: LocalizationChange) {
	return { namespace: change.namespace, key: change.key };
}

function failedFile(
	file: LocalizationChangeSetReview["files"][number],
	error: LocalizationError
): LocalizationChangeSetReceipt["files"][number] {
	return {
		culture: file.culture,
		relativePath: file.relativePath,
		changes: file.changes,
		beforeHash: file.contentHash,
		afterHash: null,
		error
	};
}
