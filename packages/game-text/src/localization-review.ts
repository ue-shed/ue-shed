import {
	CultureCode,
	LocalizationReviewFlag,
	LocalizationTargetName,
	TextKey,
	TextNamespace,
	localizationReviewFingerprint,
	type LocalizationReviewFile
} from "@ue-shed/localization/browser";
import { Schema } from "effect";

export { LocalizationReviewFlag } from "@ue-shed/localization/browser";
import type {
	LocalizationCultureMark,
	LocalizationCultureState,
	LocalizationJoin,
	LocalizationLine,
	LocalizationReviewLens,
	LocalizationReviewState
} from "./localization-schema.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";

/** The source a review is about: the gathered source, which is what translators worked from. */
function reviewSource(line: LocalizationLine): string {
	return line.manifest[0]?.source.Text ?? line.source;
}

/** Fingerprint of the line's source and the translation that ships next for a culture. */
export function localizationLineFingerprint(
	line: LocalizationLine,
	culture: LocalizationCultureState
): string {
	return localizationReviewFingerprint(
		reviewSource(line),
		localizationShippedTranslation(culture).value
	);
}

const key = (culture: string, namespace: string, name: string) =>
	JSON.stringify([culture, namespace, name]);

/** Adds each culture's review state; lines without an Unreal identity cannot be reviewed. */
export function applyLocalizationReview(
	join: LocalizationJoin,
	file: LocalizationReviewFile | undefined
): LocalizationJoin {
	if (file === undefined || file.target !== join.target) return join;
	const records = new Map(
		file.records.map((record) => [key(record.culture, record.namespace, record.key), record])
	);
	return {
		...join,
		lines: join.lines.map((line) => {
			const identity = line.identity;
			if (identity === null) return line;
			return {
				...line,
				cultures: line.cultures.map((culture) => {
					const record = records.get(
						key(culture.culture, identity.namespace, identity.key)
					);
					const review: LocalizationReviewState =
						record === undefined
							? { status: "not_reviewed" }
							: {
									status:
										record.fingerprint ===
										localizationLineFingerprint(line, culture)
											? "current"
											: "changed",
									flags: record.flags,
									by: record.by,
									at: record.at
								};
					return { ...culture, review };
				})
			};
		})
	};
}

/** Cultures with a translation to review. Missing or out-of-scope lines are not review work. */
const reviewable = new Set(["translated", "not_synced", "needs_update"]);

export function matchesLocalizationReview(
	mark: LocalizationCultureMark,
	lens: LocalizationReviewLens
): boolean {
	const review = mark.review;
	const current = review?.status === "current" ? review.flags : [];
	switch (lens) {
		case "reviewed":
			return current.includes("reviewed");
		case "not_reviewed":
			return reviewable.has(mark.state) && !current.includes("reviewed");
		case "not_proofread":
			return reviewable.has(mark.state) && !current.includes("proofread");
		case "changed_since_review":
			return review?.status === "changed";
		case "machine_translated":
			return current.includes("machine_translated");
	}
}

/**
 * Removes findings someone accepted for the exact text they saw. A finding returns as soon as the
 * source or the shipped translation changes.
 */
interface AcceptableFinding {
	readonly lineId: LocalizationLine["id"];
	readonly ruleId: string;
	readonly culture: string;
	readonly identity: { readonly namespace: string; readonly key: string };
}

export function withoutAcceptedFindings<F extends AcceptableFinding>(
	join: LocalizationJoin,
	findings: readonly F[],
	file: LocalizationReviewFile | undefined
) {
	if (file === undefined || file.acceptedFindings.length === 0) return { findings, accepted: 0 };
	const accepted = new Map(
		file.acceptedFindings.map((finding) => [
			JSON.stringify([finding.check, finding.culture ?? "", finding.namespace, finding.key]),
			finding.fingerprint
		])
	);
	const lines = new Map(join.lines.map((line) => [line.id, line]));
	const kept = findings.filter((finding) => {
		const fingerprint = accepted.get(
			JSON.stringify([
				finding.ruleId,
				finding.culture,
				finding.identity.namespace,
				finding.identity.key
			])
		);
		if (fingerprint === undefined) return true;
		const line = lines.get(finding.lineId);
		const culture = line?.cultures.find((item) => item.culture === finding.culture);
		return (
			line === undefined ||
			culture === undefined ||
			localizationLineFingerprint(line, culture) !== fingerprint
		);
	});
	return { findings: kept, accepted: findings.length - kept.length };
}

/** A host's review change; main supplies fingerprints from the evidence it holds. */
export const LocalizationReviewChange = Schema.Union([
	Schema.Struct({
		kind: Schema.Literals(["set", "clear"]),
		culture: CultureCode,
		namespace: TextNamespace,
		key: TextKey,
		flags: Schema.Array(LocalizationReviewFlag).check(Schema.isMaxLength(4))
	}),
	Schema.Struct({
		kind: Schema.Literals(["accept", "unaccept"]),
		check: Schema.NonEmptyString,
		culture: CultureCode,
		namespace: TextNamespace,
		key: TextKey
	})
]);
export type LocalizationReviewChange = typeof LocalizationReviewChange.Type;
export const LocalizationReviewRequest = Schema.Struct({
	target: LocalizationTargetName,
	changes: Schema.Array(LocalizationReviewChange).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(500)
	)
});
export type LocalizationReviewRequest = typeof LocalizationReviewRequest.Type;
export const LocalizationReviewResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_ready") }),
	Schema.Struct({ status: Schema.Literal("written"), relativePath: Schema.String }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		code: Schema.String,
		message: Schema.String,
		recovery: Schema.String
	})
]);
export type LocalizationReviewResult = typeof LocalizationReviewResult.Type;
