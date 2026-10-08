import { Result, Schema } from "effect";
import {
	CultureCode,
	FileProvenance,
	LocalizationIdentity,
	LocalizationTargetName,
	type ArchiveEntry,
	type ManifestEntry,
	type LocalizationTargetEvidence
} from "@ue-shed/localization/browser";
import { TextCorpus, TextCorpusDiagnostic } from "./schema.js";
import {
	LocalizationState,
	LocalizationUnknownReason,
	type LocalizationJoin
} from "./localization-schema.js";
import { LocalizationFileStatus, localizationEvidenceFileStatuses } from "./localization-status.js";
import { localizationTextMatches } from "./localization.js";
import { localizationWordCount } from "./localization-words.js";
import { canonicalLocalizationJson, localizationFingerprint } from "./localization-fingerprint.js";
import { manifestPlace } from "./localization-key-changes.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Words = Schema.NullOr(Count);
const Fingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Counts = Schema.Struct({ lines: Count, sourceWords: Words });
export const LocalizationBaselineEntry = Schema.Struct({
	...LocalizationIdentity.fields,
	sourceFingerprint: Fingerprint,
	sourceWords: Count,
	/** Unreal's first manifest path for the line; lets a later diff pair keys that changed. */
	path: Schema.optionalKey(Schema.String)
});
export type LocalizationBaselineEntry = typeof LocalizationBaselineEntry.Type;
export const LocalizationBaseline = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: LocalizationTargetName,
	provenance: Schema.Struct({
		createdAt: Schema.String.check(
			Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u)
		),
		fingerprintAlgorithm: Schema.Literal("sha256-canonical-json-utf8-v1"),
		wordCountAlgorithm: Schema.Literal("unicode-line-break-v1"),
		corpusGeneration: Fingerprint,
		evidenceGeneration: Fingerprint,
		files: Schema.Array(FileProvenance)
	}),
	entries: Schema.Array(LocalizationBaselineEntry).check(Schema.isMaxLength(100_000))
});
export type LocalizationBaseline = typeof LocalizationBaseline.Type;
export class LocalizationReportError extends Schema.TaggedErrorClass<LocalizationReportError>()(
	"LocalizationReportError",
	{
		code: Schema.Literals([
			"invalid_baseline",
			"baseline_target_mismatch",
			"missing_manifest",
			"ambiguous_manifest",
			"word_count_unavailable",
			"invalid_report_context"
		]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}
function reportError(code: LocalizationReportError["code"]): LocalizationReportError {
	const recovery = {
		invalid_baseline:
			"Regenerate a version-1 baseline with loc report --save-baseline using a new JSON destination.",
		baseline_target_mismatch:
			"Choose a baseline recorded for the selected localization target.",
		missing_manifest:
			"Run the target's Unreal gather configuration and refresh its manifest evidence.",
		ambiguous_manifest:
			"Resolve conflicting sources for duplicate identities in Unreal, then gather again.",
		word_count_unavailable:
			"Keep the line report; portable billing baselines require ICU dictionary support for these source scripts, which is not available yet.",
		invalid_report_context:
			"Load current corpus and localization evidence for the same target and cultures."
	} satisfies Record<LocalizationReportError["code"], string>;
	return new LocalizationReportError({
		code,
		message: "The localization report evidence could not be validated.",
		recovery: recovery[code]
	});
}
function identityKey(identity: LocalizationIdentity): string {
	return JSON.stringify([identity.namespace, identity.key]);
}
function baselineValid(document: LocalizationBaseline): boolean {
	return new Set(document.entries.map(identityKey)).size === document.entries.length;
}
export function decodeLocalizationBaselineJson(
	input: string
): Result.Result<LocalizationBaseline, LocalizationReportError> {
	const result = Schema.decodeUnknownResult(Schema.fromJsonString(LocalizationBaseline))(input);
	if (Result.isFailure(result) || !baselineValid(result.success))
		return Result.fail(reportError("invalid_baseline"));
	return Result.succeed(result.success);
}
/** Deduplicate locations, exclude optional contexts, and reject conflicting sources per identity. */
function manifestEntries(evidence: LocalizationTargetEvidence): readonly ManifestEntry[] {
	if (evidence.manifest.status !== "read") throw reportError("missing_manifest");
	const entries = new Map<string, ManifestEntry>();
	for (const entry of evidence.manifest.value.entries) {
		if (entry.optional) continue;
		const key = identityKey(entry);
		const previous = entries.get(key);
		if (previous && !localizationTextMatches(previous.source, entry.source))
			throw reportError("ambiguous_manifest");
		entries.set(key, entry);
	}
	return [...entries.values()].sort(
		(a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key)
	);
}
export function createLocalizationBaseline(
	corpus: TextCorpus,
	evidence: LocalizationTargetEvidence,
	createdAt: string
): LocalizationBaseline {
	if (
		Result.isFailure(
			Schema.decodeUnknownResult(LocalizationBaseline.fields.provenance.fields.createdAt)(
				createdAt
			)
		)
	)
		throw reportError("invalid_baseline");
	const files = localizationEvidenceFileStatuses(evidence).flatMap((file) =>
		file.provenance ? [file.provenance] : []
	);
	// Encode optional undefined values as JSON omissions before canonicalizing the corpus.
	const corpusJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
		Schema.encodeSync(Schema.fromJsonString(TextCorpus))(corpus)
	);
	return LocalizationBaseline.make({
		schemaVersion: 1,
		target: evidence.target.name,
		provenance: {
			createdAt,
			fingerprintAlgorithm: "sha256-canonical-json-utf8-v1",
			wordCountAlgorithm: "unicode-line-break-v1",
			corpusGeneration: localizationFingerprint(canonicalLocalizationJson(corpusJson)),
			evidenceGeneration: localizationFingerprint(
				canonicalLocalizationJson(
					files
						.map(({ relativePath, contentHash }) => ({ relativePath, contentHash }))
						.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
				)
			),
			files
		},
		entries: manifestEntries(evidence).map((entry) => {
			const count = localizationWordCount(entry.source.Text);
			if (count.status === "unknown") throw reportError("word_count_unavailable");
			return {
				namespace: entry.namespace,
				key: entry.key,
				sourceFingerprint: localizationFingerprint(canonicalLocalizationJson(entry.source)),
				sourceWords: count.words,
				path: entry.path
			};
		})
	});
}
/** A key that left the manifest, paired one to one with the key that took its place. */
export const LocalizationBaselineKeyChange = Schema.Struct({
	from: LocalizationBaselineEntry,
	to: LocalizationBaselineEntry,
	match: Schema.Literals(["same_place", "same_text"])
});
export type LocalizationBaselineKeyChange = typeof LocalizationBaselineKeyChange.Type;
export const LocalizationBaselineDelta = Schema.Struct({
	added: Schema.Array(LocalizationBaselineEntry),
	changed: Schema.Array(LocalizationBaselineEntry),
	removed: Schema.Array(LocalizationBaselineEntry),
	/** Paired keys; they are not counted again as added or removed. */
	keyChanged: Schema.Array(LocalizationBaselineKeyChange),
	addedCounts: Counts,
	changedCounts: Counts,
	removedCounts: Counts,
	keyChangedCounts: Counts
});
export type LocalizationBaselineDelta = typeof LocalizationBaselineDelta.Type;
function entryCounts(entries: readonly LocalizationBaselineEntry[]) {
	return {
		lines: entries.length,
		sourceWords: entries.reduce((total, entry) => total + entry.sourceWords, 0)
	};
}
export function diffLocalizationBaselines(
	previous: LocalizationBaseline,
	current: LocalizationBaseline
): LocalizationBaselineDelta {
	if (!baselineValid(previous) || !baselineValid(current)) throw reportError("invalid_baseline");
	if (previous.target !== current.target) throw reportError("baseline_target_mismatch");
	const before = new Map(previous.entries.map((entry) => [identityKey(entry), entry]));
	const after = new Map(current.entries.map((entry) => [identityKey(entry), entry]));
	const sorted = (entries: readonly LocalizationBaselineEntry[]) =>
		[...entries].sort(
			(a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key)
		);
	const keyChanged = pairBaselineKeys(
		previous.entries.filter((entry) => !after.has(identityKey(entry))),
		current.entries.filter((entry) => !before.has(identityKey(entry)))
	);
	const pairedFrom = new Set(keyChanged.map((item) => identityKey(item.from)));
	const pairedTo = new Set(keyChanged.map((item) => identityKey(item.to)));
	const added = sorted(
		current.entries.filter(
			(entry) => !before.has(identityKey(entry)) && !pairedTo.has(identityKey(entry))
		)
	);
	const changed = sorted(
		current.entries.filter((entry) => {
			const old = before.get(identityKey(entry));
			return old !== undefined && old.sourceFingerprint !== entry.sourceFingerprint;
		})
	);
	const removed = sorted(
		previous.entries.filter(
			(entry) => !after.has(identityKey(entry)) && !pairedFrom.has(identityKey(entry))
		)
	);
	return {
		added,
		changed,
		removed,
		keyChanged,
		addedCounts: entryCounts(added),
		changedCounts: entryCounts(changed),
		removedCounts: entryCounts(removed),
		keyChangedCounts: entryCounts(keyChanged.map((item) => item.to))
	};
}
/**
 * Pairs removed and added baseline entries strictly one to one: first by the place Unreal's
 * manifest path names, then by an identical source fingerprint unique on both sides.
 */
function pairBaselineKeys(
	removed: readonly LocalizationBaselineEntry[],
	added: readonly LocalizationBaselineEntry[]
): readonly LocalizationBaselineKeyChange[] {
	const tiers: readonly (readonly [
		LocalizationBaselineKeyChange["match"],
		(entry: LocalizationBaselineEntry) => string | undefined
	])[] = [
		[
			"same_place",
			(entry) => (entry.path === undefined ? undefined : manifestPlace(entry.path))
		],
		["same_text", (entry) => entry.sourceFingerprint]
	];
	const pairs: LocalizationBaselineKeyChange[] = [];
	let olds = [...removed];
	let news = [...added];
	for (const [match, keyOf] of tiers) {
		const group = (entries: readonly LocalizationBaselineEntry[]) => {
			const byKey = new Map<string, LocalizationBaselineEntry[]>();
			for (const entry of entries) {
				const key = keyOf(entry);
				if (key !== undefined) byKey.set(key, [...(byKey.get(key) ?? []), entry]);
			}
			return byKey;
		};
		const oldByKey = group(olds);
		const newByKey = group(news);
		const paired = new Set<LocalizationBaselineEntry>();
		for (const [key, fresh] of newByKey) {
			const earlier = oldByKey.get(key);
			const [from] = earlier ?? [];
			const [to] = fresh;
			if (earlier?.length !== 1 || fresh.length !== 1 || !from || !to) continue;
			pairs.push({ from, to, match });
			paired.add(from).add(to);
		}
		olds = olds.filter((entry) => !paired.has(entry));
		news = news.filter((entry) => !paired.has(entry));
	}
	return pairs.sort(
		(a, b) => a.to.namespace.localeCompare(b.to.namespace) || a.to.key.localeCompare(b.to.key)
	);
}
/** "not_tracked" until the project has a review file for the target. */
const ReviewProgress = Schema.Union([
	Schema.Literal("not_tracked"),
	Schema.Struct({ lines: Count, percent: Schema.NullOr(Schema.Number) })
]);
export const LocalizationProgressCulture = Schema.Struct({
	culture: CultureCode,
	states: Schema.Record(LocalizationState, Counts),
	notSynced: Counts,
	reducedSourceChecking: Count,
	unknownReasons: Schema.Record(LocalizationUnknownReason, Count),
	total: Counts,
	upToDateArchive: Schema.Struct({ lines: Schema.NullOr(Count), sourceWords: Words }),
	translatedPercent: Schema.Struct({
		lines: Schema.NullOr(Schema.Number),
		words: Schema.NullOr(Schema.Number)
	}),
	reviewed: ReviewProgress,
	proofread: ReviewProgress,
	baselineDelta: Schema.optionalKey(LocalizationBaselineDelta)
});
export type LocalizationProgressCulture = typeof LocalizationProgressCulture.Type;
export const LocalizationProgressReport = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: LocalizationTargetName,
	wordCountAlgorithm: Schema.Literal("unicode-line-break-v1"),
	wordCountDiagnostics: Schema.Array(
		Schema.Struct({
			...LocalizationIdentity.fields,
			code: Schema.Literal("dictionary_line_breaking_unavailable")
		})
	),
	cultures: Schema.Array(LocalizationProgressCulture),
	coverage: TextCorpus.fields.coverage,
	packageCoverage: TextCorpus.fields.packageCoverage,
	diagnostics: Schema.Array(TextCorpusDiagnostic),
	gatherEvidence: Schema.Array(LocalizationFileStatus)
});
export type LocalizationProgressReport = typeof LocalizationProgressReport.Type;

/** Archive totals mirror GetWordCountReport; PO pending edits remain visible in state counts. */
export function localizationProgressReport(
	corpus: TextCorpus,
	join: LocalizationJoin,
	evidence: LocalizationTargetEvidence,
	baseline?: LocalizationBaseline
): LocalizationProgressReport {
	if (join.target !== evidence.target.name) throw reportError("invalid_report_context");
	const entries = manifestEntries(evidence);
	// Review applies to gathered lines; the share is over the same total as translation progress.
	const tracked = join.lines.some((line) => line.cultures.some((mark) => mark.review));
	const reviewProgress = (
		culture: string,
		flag: "reviewed" | "proofread",
		total: number
	): LocalizationProgressCulture["reviewed"] => {
		if (!tracked) return "not_tracked";
		const lines = join.lines.filter(
			(line) =>
				line.manifest.length > 0 &&
				line.cultures.some(
					(mark) =>
						mark.culture === culture &&
						mark.review?.status === "current" &&
						mark.review.flags.includes(flag)
				)
		).length;
		return { lines, percent: total ? (lines / total) * 100 : null };
	};
	const archives = new Map(
		evidence.cultures.map((culture) => [culture.culture, culture.archive])
	);
	const archiveEntries = new Map(
		evidence.cultures.map((culture) => {
			const grouped = new Map<string, ArchiveEntry[]>();
			if (culture.archive.status === "read")
				for (const entry of culture.archive.value.entries) {
					const key = identityKey(entry),
						group = grouped.get(key) ?? [];
					group.push(entry);
					grouped.set(key, group);
				}
			return [culture.culture, grouped] satisfies readonly [
				CultureCode,
				Map<string, ArchiveEntry[]>
			];
		})
	);
	const archiveFor = (culture: CultureCode, entry: ManifestEntry) => {
		const matches = archiveEntries.get(culture)?.get(identityKey(entry)) ?? [];
		return matches.length === 1 ? matches[0] : undefined;
	};
	const current = baseline
		? createLocalizationBaseline(corpus, evidence, baseline.provenance.createdAt)
		: undefined;
	const delta = baseline && current ? diffLocalizationBaselines(baseline, current) : undefined;
	const wordCounts = new Map(
		entries.map((entry) => [identityKey(entry), localizationWordCount(entry.source.Text)])
	);
	const cultures = join.cultures.map((culture): LocalizationProgressCulture => {
		const states = Schema.decodeUnknownSync(LocalizationProgressCulture.fields.states)(
			Object.fromEntries(
				LocalizationState.literals.map((state) => [state, { lines: 0, sourceWords: 0 }])
			)
		);
		const unknownReasons = Schema.decodeUnknownSync(
			LocalizationProgressCulture.fields.unknownReasons
		)(Object.fromEntries(LocalizationUnknownReason.literals.map((reason) => [reason, 0])));
		let totalWords: number | null = 0,
			translatedWords: number | null = 0,
			translatedLines = 0;
		let pendingLines = 0,
			pendingWords: number | null = 0,
			reducedSourceChecking = 0;
		for (const line of join.lines) {
			const mark = line.cultures.find((item) => item.culture === culture);
			if (!mark || mark.state === "outside_target" || !line.source.trim()) continue;
			const count =
				wordCounts.get(line.identity ? identityKey(line.identity) : "") ??
				localizationWordCount(line.source);
			if (mark.reducedSourceChecking) reducedSourceChecking++;
			if (mark.state === "not_synced" || mark.facts.includes("not_synced")) {
				pendingLines++;
				if (count.status === "unknown") pendingWords = null;
				else if (pendingWords !== null) pendingWords += count.words;
			}
			const bucket = states[mark.state];
			if (bucket) {
				Object.assign(states, {
					[mark.state]: {
						lines: bucket.lines + 1,
						sourceWords:
							count.status === "unknown" || bucket.sourceWords === null
								? null
								: bucket.sourceWords + count.words
					}
				});
			}
			for (const reason of mark.unknownReasons)
				Object.assign(unknownReasons, { [reason]: (unknownReasons[reason] ?? 0) + 1 });
		}
		for (const entry of entries) {
			const count = wordCounts.get(identityKey(entry));
			if (count?.status !== "counted") totalWords = null;
			else if (totalWords !== null) totalWords += count.words;
			const archived = archiveFor(culture, entry);
			// GenerateTextLocalizationReport constructs its helper with an empty native culture.
			// Its CSV checks raw manifest source for every culture, without runtime native fallback.
			const matches =
				archived !== undefined &&
				localizationTextMatches(archived.source, entry.source) &&
				archived.translation.Text !== "";
			if (matches) {
				translatedLines++;
				if (count?.status !== "counted") translatedWords = null;
				else if (translatedWords !== null) translatedWords += count.words;
			}
		}
		const archive = archives.get(culture);
		const translationCoverage =
			archive?.status === "read" && archive.value.diagnostics.length === 0;
		const result: LocalizationProgressCulture = {
			culture,
			states,
			unknownReasons,
			notSynced: { lines: pendingLines, sourceWords: pendingWords },
			reducedSourceChecking,
			total: { lines: entries.length, sourceWords: totalWords },
			upToDateArchive: {
				lines: translationCoverage ? translatedLines : null,
				sourceWords: translationCoverage ? translatedWords : null
			},
			translatedPercent: {
				lines:
					translationCoverage && entries.length
						? (translatedLines / entries.length) * 100
						: null,
				words:
					translationCoverage && totalWords && translatedWords !== null
						? (translatedWords / totalWords) * 100
						: null
			},
			reviewed: reviewProgress(culture, "reviewed", entries.length),
			proofread: reviewProgress(culture, "proofread", entries.length)
		};
		if (delta) Object.assign(result, { baselineDelta: delta });
		return result;
	});
	const report: LocalizationProgressReport = {
		schemaVersion: 1,
		target: join.target,
		wordCountAlgorithm: "unicode-line-break-v1",
		cultures,
		wordCountDiagnostics: entries.flatMap((entry) =>
			wordCounts.get(identityKey(entry))?.status === "unknown"
				? [
						{
							namespace: entry.namespace,
							key: entry.key,
							code: "dictionary_line_breaking_unavailable"
						} satisfies LocalizationProgressReport["wordCountDiagnostics"][number]
					]
				: []
		),
		coverage: corpus.coverage,
		diagnostics: corpus.diagnostics,
		gatherEvidence: localizationEvidenceFileStatuses(evidence)
	};
	if (corpus.packageCoverage !== undefined)
		Object.assign(report, { packageCoverage: corpus.packageCoverage });
	return report;
}
