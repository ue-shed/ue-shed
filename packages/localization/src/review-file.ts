import { Result, Schema } from "effect";
import { currentLocalizationTranslation } from "./change-set-review.js";
import {
	CultureCode,
	LocalizationIdentity,
	LocalizationTargetName,
	type LocalizationTargetEvidence
} from "./schema.js";
import { sha256Hex } from "./sha256.js";

/**
 * Fingerprint of a line and culture straight from target evidence: the manifest source and the
 * translation that ships next. Undefined when the line is not gathered or the culture is missing.
 */
export function localizationEvidenceFingerprint(
	evidence: LocalizationTargetEvidence,
	culture: CultureCode,
	identity: LocalizationIdentity
): string | undefined {
	const same = (item: LocalizationIdentity) =>
		item.namespace === identity.namespace && item.key === identity.key;
	const source =
		evidence.manifest.status === "read"
			? evidence.manifest.value.entries.find(same)?.source.Text
			: undefined;
	const files = evidence.cultures.find((item) => item.culture === culture);
	if (source === undefined || files === undefined) return undefined;
	const archive =
		files.archive.status === "read"
			? (files.archive.value.entries.find(same)?.translation.Text ?? null)
			: null;
	const po =
		files.po.status === "read"
			? files.po.value.entries.find(
					(entry) => entry.identity !== null && same(entry.identity)
				)
			: undefined;
	return localizationReviewFingerprint(source, currentLocalizationTranslation(archive, po));
}

/** Review progress Unreal does not store. `machine_translated` records how the text was made. */
export const LocalizationReviewFlag = Schema.Literals([
	"reviewed",
	"proofread",
	"approved",
	"machine_translated"
]);
export type LocalizationReviewFlag = typeof LocalizationReviewFlag.Type;

const Fingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Stamp = {
	by: Schema.NonEmptyString,
	at: Schema.NonEmptyString
};

export const LocalizationReviewRecord = Schema.Struct({
	culture: CultureCode,
	...LocalizationIdentity.fields,
	flags: Schema.Array(LocalizationReviewFlag).check(Schema.isMinLength(1)),
	/** Source and translation the flags were set against; see `localizationReviewFingerprint`. */
	fingerprint: Fingerprint,
	...Stamp
});
export type LocalizationReviewRecord = typeof LocalizationReviewRecord.Type;

/** A finding someone accepted (for example the same text under two keys), so it stops reporting. */
export const LocalizationAcceptedFinding = Schema.Struct({
	check: Schema.NonEmptyString,
	/** Null for findings about the line rather than one culture's translation. */
	culture: Schema.NullOr(CultureCode),
	...LocalizationIdentity.fields,
	fingerprint: Fingerprint,
	...Stamp
});
export type LocalizationAcceptedFinding = typeof LocalizationAcceptedFinding.Type;

export const LocalizationReviewFile = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: LocalizationTargetName,
	records: Schema.Array(LocalizationReviewRecord),
	acceptedFindings: Schema.Array(LocalizationAcceptedFinding)
});
export type LocalizationReviewFile = typeof LocalizationReviewFile.Type;

export class LocalizationReviewFileError extends Schema.TaggedErrorClass<LocalizationReviewFileError>()(
	"LocalizationReviewFileError",
	{
		code: Schema.Literals(["invalid_review_file", "duplicate_review_record", "wrong_target"]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

/** The project-relative default location, kept beside Unreal's own localization configs. */
export function defaultLocalizationReviewPath(target: LocalizationTargetName): string {
	return `Config/UEShed/Localization/${target}.review.json`;
}

export function emptyLocalizationReviewFile(
	target: LocalizationTargetName
): LocalizationReviewFile {
	return LocalizationReviewFile.make({
		schemaVersion: 1,
		target,
		records: [],
		acceptedFindings: []
	});
}

/**
 * Fingerprint of what a review was about. Changing either text invalidates the review; the
 * NUL separator keeps "a" + "bc" distinct from "ab" + "c".
 */
export function localizationReviewFingerprint(source: string, translation: string | null): string {
	return sha256Hex(`${source}\u0000${translation ?? "\u0000absent"}`);
}

const recordKey = (record: { culture: string | null; namespace: string; key: string }) =>
	JSON.stringify([record.culture ?? "", record.namespace, record.key]);
const findingKey = (finding: LocalizationAcceptedFinding) =>
	JSON.stringify([finding.check, finding.culture ?? "", finding.namespace, finding.key]);
const byKey =
	<A>(key: (value: A) => string) =>
	(left: A, right: A) =>
		key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;

export function decodeLocalizationReviewFile(
	text: string,
	target: LocalizationTargetName
): Result.Result<LocalizationReviewFile, LocalizationReviewFileError> {
	const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(LocalizationReviewFile))(text);
	if (Result.isFailure(decoded))
		return Result.fail(
			new LocalizationReviewFileError({
				code: "invalid_review_file",
				message: "The localization review file does not match version 1.",
				recovery:
					"Restore the file from source control, or delete it to start reviewing afresh."
			})
		);
	const file = decoded.success;
	if (file.target !== target)
		return Result.fail(
			new LocalizationReviewFileError({
				code: "wrong_target",
				message: "The review file belongs to another localization target.",
				recovery: "Use the review file named after the selected target."
			})
		);
	const keys = file.records.map(recordKey);
	const findings = file.acceptedFindings.map(findingKey);
	if (new Set(keys).size !== keys.length || new Set(findings).size !== findings.length)
		return Result.fail(
			new LocalizationReviewFileError({
				code: "duplicate_review_record",
				message: "The review file records the same line twice.",
				recovery: "Resolve the merge so each culture and key appears once."
			})
		);
	return Result.succeed(file);
}

/**
 * Stable, merge-friendly text: records sorted by culture, namespace and key, one field per line,
 * tab indentation and a final newline. Equal files always serialize to equal bytes.
 */
export function encodeLocalizationReviewFile(file: LocalizationReviewFile): string {
	const normalized = {
		schemaVersion: 1,
		target: file.target,
		records: [...file.records].sort(byKey(recordKey)).map((record) => ({
			culture: record.culture,
			namespace: record.namespace,
			key: record.key,
			flags: LocalizationReviewFlag.literals.filter((flag) => record.flags.includes(flag)),
			fingerprint: record.fingerprint,
			by: record.by,
			at: record.at
		})),
		acceptedFindings: [...file.acceptedFindings].sort(byKey(findingKey)).map((finding) => ({
			check: finding.check,
			culture: finding.culture,
			namespace: finding.namespace,
			key: finding.key,
			fingerprint: finding.fingerprint,
			by: finding.by,
			at: finding.at
		}))
	};
	return `${JSON.stringify(normalized, null, "\t")}\n`;
}

export const LocalizationReviewUpdate = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("set"),
		culture: CultureCode,
		...LocalizationIdentity.fields,
		flags: Schema.Array(LocalizationReviewFlag).check(Schema.isMinLength(1)),
		fingerprint: Fingerprint
	}),
	Schema.Struct({
		kind: Schema.Literal("clear"),
		culture: CultureCode,
		...LocalizationIdentity.fields,
		/** Empty clears every flag for the line and culture. */
		flags: Schema.Array(LocalizationReviewFlag)
	}),
	Schema.Struct({
		kind: Schema.Literal("accept"),
		check: Schema.NonEmptyString,
		culture: Schema.NullOr(CultureCode),
		...LocalizationIdentity.fields,
		fingerprint: Fingerprint
	}),
	Schema.Struct({
		kind: Schema.Literal("unaccept"),
		check: Schema.NonEmptyString,
		culture: Schema.NullOr(CultureCode),
		...LocalizationIdentity.fields
	})
]);
export type LocalizationReviewUpdate = typeof LocalizationReviewUpdate.Type;

/**
 * Applies updates in order. Setting flags against a new fingerprint replaces stale flags rather
 * than merging into them: a review of changed text starts over.
 */
export function updateLocalizationReviewFile(
	file: LocalizationReviewFile,
	updates: readonly LocalizationReviewUpdate[],
	stamp: { readonly by: string; readonly at: string }
): LocalizationReviewFile {
	const records = new Map(file.records.map((record) => [recordKey(record), record]));
	const findings = new Map(
		file.acceptedFindings.map((finding) => [findingKey(finding), finding])
	);
	for (const update of updates) {
		if (update.kind === "set" || update.kind === "clear") {
			const key = recordKey(update);
			const existing = records.get(key);
			if (update.kind === "set") {
				const kept =
					existing?.fingerprint === update.fingerprint ? existing.flags : ([] as const);
				records.set(
					key,
					LocalizationReviewRecord.make({
						culture: update.culture,
						namespace: update.namespace,
						key: update.key,
						flags: [...new Set([...kept, ...update.flags])],
						fingerprint: update.fingerprint,
						...stamp
					})
				);
				continue;
			}
			if (existing === undefined) continue;
			const flags =
				update.flags.length === 0
					? []
					: existing.flags.filter((flag) => !update.flags.includes(flag));
			if (flags.length === 0) records.delete(key);
			else records.set(key, { ...existing, flags, ...stamp });
			continue;
		}
		const finding = LocalizationAcceptedFinding.make({
			check: update.check,
			culture: update.culture,
			namespace: update.namespace,
			key: update.key,
			fingerprint: update.kind === "accept" ? update.fingerprint : "0".repeat(64),
			...stamp
		});
		if (update.kind === "accept") findings.set(findingKey(finding), finding);
		else findings.delete(findingKey(finding));
	}
	return LocalizationReviewFile.make({
		schemaVersion: 1,
		target: file.target,
		records: [...records.values()].sort(byKey(recordKey)),
		acceptedFindings: [...findings.values()].sort(byKey(findingKey))
	});
}
