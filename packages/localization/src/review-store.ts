import { Effect, Metric, Result } from "effect";
import { decodeText, limitsFor } from "./decode.js";
import { LocalizationFileAccess } from "./file-access.js";
import {
	decodeLocalizationReviewFile,
	defaultLocalizationReviewPath,
	emptyLocalizationReviewFile,
	encodeLocalizationReviewFile,
	updateLocalizationReviewFile,
	type LocalizationReviewFile,
	type LocalizationReviewUpdate
} from "./review-file.js";
import type { LocalizationLimits, LocalizationTargetName } from "./schema.js";

export interface LocalizationReviewLocation {
	readonly projectRoot: string;
	readonly target: LocalizationTargetName;
	/** Project-relative; defaults to `defaultLocalizationReviewPath(target)`. */
	readonly path?: string | undefined;
	readonly limits?: LocalizationLimits | undefined;
}

export interface LocalizationReviewSnapshot {
	readonly file: LocalizationReviewFile;
	readonly relativePath: string;
	/** Null when the file does not exist yet; a write then creates it. */
	readonly contentHash: string | null;
}

const reviewUpdates = Metric.counter("localization.review.updates");

/** Reads the target's review file; a missing file is an empty review, not a failure. */
export const readLocalizationReview = Effect.fn("Localization.readReview")(function* (
	location: LocalizationReviewLocation
) {
	const files = yield* LocalizationFileAccess;
	const limits = limitsFor(location.limits);
	const relativePath = location.path ?? defaultLocalizationReviewPath(location.target);
	const read = yield* files.read(location.projectRoot, relativePath, limits).pipe(Effect.result);
	if (Result.isFailure(read)) {
		if (read.failure.code === "file_missing")
			return {
				file: emptyLocalizationReviewFile(location.target),
				relativePath,
				contentHash: null
			} satisfies LocalizationReviewSnapshot;
		return yield* Effect.fail(read.failure);
	}
	const text = decodeText(read.success.bytes, limits);
	const file = decodeLocalizationReviewFile(text, location.target);
	if (Result.isFailure(file)) return yield* Effect.fail(file.failure);
	return {
		file: file.success,
		relativePath,
		contentHash: read.success.provenance.contentHash
	} satisfies LocalizationReviewSnapshot;
});

/**
 * Applies updates to the file as last read and writes it back, refusing to overwrite a file that
 * changed in between (for example a merge from source control).
 */
export const updateLocalizationReview = Effect.fn("Localization.updateReview")(function* (
	location: LocalizationReviewLocation,
	updates: readonly LocalizationReviewUpdate[],
	stamp: { readonly by: string; readonly at: string },
	expected?: LocalizationReviewSnapshot
) {
	const files = yield* LocalizationFileAccess;
	const limits = limitsFor(location.limits);
	const snapshot = expected ?? (yield* readLocalizationReview(location));
	const file = updateLocalizationReviewFile(snapshot.file, updates, stamp);
	const bytes = new TextEncoder().encode(encodeLocalizationReviewFile(file));
	const written =
		snapshot.contentHash === null
			? yield* files.create(location.projectRoot, snapshot.relativePath, bytes, limits)
			: yield* files.replace(
					location.projectRoot,
					snapshot.relativePath,
					bytes,
					snapshot.contentHash,
					limits
				);
	yield* Metric.update(reviewUpdates, updates.length);
	return {
		file,
		relativePath: snapshot.relativePath,
		contentHash: written.contentHash
	} satisfies LocalizationReviewSnapshot;
});
