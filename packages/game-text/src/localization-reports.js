import { ErrorNextStep } from "@ue-shed/protocol/errors";
import { TextCorpusDiagnosticSummary, TextPackageCoverageSummary, textCorpusReportHeader } from "./corpus-summary.js";
import { Effect, Result, Schema } from "effect";
import { CultureCode, FileProvenance, LocalizationIdentity, LocalizationTargetName } from "@ue-shed/localization/browser";
import { TextCorpus } from "./schema.js";
import { LocalizationState, LocalizationUnknownReason, localizationManifestFailure } from "./localization-schema.js";
import { LocalizationFileStatus, localizationEvidenceFileStatuses } from "./localization-status.js";
import { localizationTextMatches } from "./localization.js";
import { localizationWordCount } from "./localization-words.js";
import { canonicalLocalizationJson, localizationFingerprint } from "./localization-fingerprint.js";
import { manifestPlace } from "./localization-key-changes.js";
import { readEvidenceValue } from "./evidence-reads.js";
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Words = Schema.NullOr(Count);
const Fingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Counts = Schema.Struct({ lines: Count, sourceWords: Words });
/**
 * Localization identity with canonical source fingerprint, source-word count and optional
 * manifest place. These facts support source changes and conservative key-change pairing.
 */
export const LocalizationBaselineEntry = Schema.Struct({
    ...LocalizationIdentity.fields,
    sourceFingerprint: Fingerprint,
    sourceWords: Count,
    /** Unreal's first manifest path for the line; lets a later diff pair keys that changed. */
    path: Schema.optionalKey(Schema.String)
});
/** The most manifest entries a baseline records. */
const MAX_BASELINE_ENTRIES = 100_000;
/**
 * Versioned target baseline with algorithm identities and corpus/evidence/file provenance.
 * Entries are bounded and identities must be unique before comparison.
 */
export const LocalizationBaseline = Schema.Struct({
    schemaVersion: Schema.Literal(1),
    target: LocalizationTargetName,
    provenance: Schema.Struct({
        createdAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u)),
        fingerprintAlgorithm: Schema.Literal("sha256-canonical-json-utf8-v1"),
        wordCountAlgorithm: Schema.Literal("unicode-line-break-v1"),
        corpusGeneration: Fingerprint,
        evidenceGeneration: Fingerprint,
        files: Schema.Array(FileProvenance)
    }),
    entries: Schema.Array(LocalizationBaselineEntry).check(Schema.isMaxLength(MAX_BASELINE_ENTRIES))
});
const decodeCreatedAt = Schema.decodeResult(LocalizationBaseline.fields.provenance.fields.createdAt);
const LocalizationBaselineJson = Schema.fromJsonString(LocalizationBaseline);
const decodeLocalizationBaselineJsonResult = Schema.decodeResult(LocalizationBaselineJson);
const JsonText = Schema.fromJsonString(Schema.Json);
const decodeJsonText = Schema.decodeSync(JsonText);
const TextCorpusJson = Schema.fromJsonString(TextCorpus);
const encodeTextCorpusJson = Schema.encodeSync(TextCorpusJson);
/**
 * Typed invalid baseline, unavailable/ambiguous evidence or reporting-context failure. Code and
 * recovery explain required correction; cause retains original schema/manifest evidence when
 * available.
 */
export class LocalizationReportError extends Schema.TaggedError()("LocalizationReportError", {
    retrySafe: Schema.Boolean,
    nextStep: ErrorNextStep,
    cause: Schema.optionalKey(Schema.Defect()),
    code: Schema.Literals([
        "invalid_baseline",
        "baseline_target_mismatch",
        "missing_manifest",
        "unreadable_manifest",
        "ambiguous_manifest",
        "word_count_unavailable",
        "invalid_report_context"
    ]),
    message: Schema.String,
    recovery: Schema.String
}) {
}
const isLocalizationReportError = Schema.is(LocalizationReportError);
function reportError(code, cause) {
    const recovery = {
        invalid_baseline: "Save a new version-1 localization baseline to a new JSON destination.",
        baseline_target_mismatch: "Choose a baseline recorded for the selected localization target.",
        missing_manifest: "Run the target's Unreal gather configuration and refresh its manifest evidence.",
        unreadable_manifest: "Repair the manifest evidence and retry.",
        ambiguous_manifest: "Resolve conflicting sources for duplicate identities in Unreal, then gather again.",
        word_count_unavailable: "Keep the line report; portable billing baselines require ICU dictionary support for these source scripts, which is not available yet.",
        invalid_report_context: "Load current corpus and localization evidence for the same target and cultures."
    };
    return new LocalizationReportError({
        ...(cause === undefined ? undefined : { cause }),
        retrySafe: false,
        nextStep: "fix_input",
        code,
        message: "The localization report evidence could not be validated.",
        recovery: recovery[code]
    });
}
function identityKey(identity) {
    return JSON.stringify([identity.namespace, identity.key]);
}
function baselineValid(document) {
    return new Set(document.entries.map(identityKey)).size === document.entries.length;
}
/**
 * Parses baseline JSON into a Result with domain report errors. Invalid JSON/schema evidence is
 * retained; duplicate identities also reject the baseline.
 */
export function decodeLocalizationBaselineJson(input) {
    const result = decodeLocalizationBaselineJsonResult(input);
    if (Result.isFailure(result))
        return Result.fail(reportError("invalid_baseline", result.failure));
    if (!baselineValid(result.success))
        return Result.fail(reportError("invalid_baseline"));
    return Result.succeed(result.success);
}
/** Deduplicate locations, exclude optional contexts, and reject conflicting sources per identity. */
function manifestEntries(evidence, manifest) {
    if (evidence.manifest.status === "failed") {
        const error = localizationManifestFailure(evidence.manifest.error, evidence.manifest.relativePath);
        throw new LocalizationReportError({
            retrySafe: false,
            nextStep: "fix_input",
            code: error.code === "missing_manifest" ? "missing_manifest" : "unreadable_manifest",
            cause: error,
            message: error.message,
            recovery: error.recovery
        });
    }
    const entries = new Map();
    for (const entry of (manifest ?? evidence.manifest.value).entries) {
        if (entry.optional)
            continue;
        const key = identityKey(entry);
        const previous = entries.get(key);
        if (previous && !localizationTextMatches(previous.source, entry.source))
            throw reportError("ambiguous_manifest");
        entries.set(key, entry);
    }
    return [...entries.values()].sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key));
}
/** The corpus fingerprint a baseline records, computed from the corpus itself. */
function corpusGeneration(corpus) {
    // Encode optional undefined values as JSON omissions before canonicalizing the corpus.
    const corpusJson = decodeJsonText(encodeTextCorpusJson(corpus));
    return localizationFingerprint(canonicalLocalizationJson(corpusJson));
}
/** The baseline entries of the target's manifest: every required key, its source and words. */
function baselineEntries(evidence) {
    return manifestEntries(evidence).map((entry) => {
        const count = localizationWordCount(entry.source.Text);
        if (count.status === "unknown")
            throw reportError("word_count_unavailable");
        return {
            namespace: entry.namespace,
            key: entry.key,
            sourceFingerprint: localizationFingerprint(canonicalLocalizationJson(entry.source)),
            sourceWords: count.words,
            path: entry.path
        };
    });
}
/**
 * Validates everything a baseline holds except the corpus generation, then returns the step that
 * adds it: a target over the entry limit fails before the corpus is fingerprinted.
 */
function baselineWith(evidence, createdAt) {
    if (Result.isFailure(decodeCreatedAt(createdAt)))
        throw reportError("invalid_baseline");
    const files = localizationEvidenceFileStatuses(evidence).flatMap((file) => file.provenance ? [file.provenance] : []);
    const entries = baselineEntries(evidence);
    if (entries.length > MAX_BASELINE_ENTRIES)
        throw reportError("invalid_baseline");
    return (generation) => LocalizationBaseline.make({
        schemaVersion: 1,
        target: evidence.target.name,
        provenance: {
            createdAt,
            fingerprintAlgorithm: "sha256-canonical-json-utf8-v1",
            wordCountAlgorithm: "unicode-line-break-v1",
            corpusGeneration: generation,
            evidenceGeneration: localizationFingerprint(canonicalLocalizationJson(files
                .map(({ relativePath, contentHash }) => ({ relativePath, contentHash }))
                .sort((a, b) => a.relativePath.localeCompare(b.relativePath)))),
            files
        },
        entries
    });
}
/**
 * Creates a target baseline from current corpus and manifest evidence with canonical
 * fingerprints. Missing/ambiguous manifests or unavailable portable word counts fail with
 * LocalizationReportError. An index model gives the same baseline through
 * `indexedLocalizationBaseline`, which fingerprints the corpus in Rust.
 */
export function createLocalizationBaseline(corpus, evidence, createdAt) {
    return baselineWith(evidence, createdAt)(corpusGeneration(corpus));
}
/**
 * The baseline `createLocalizationBaseline` makes from the model's corpus, without reading the
 * corpus: Rust fingerprints it (the same `sha256-canonical-json-utf8-v1` value).
 */
export const indexedLocalizationBaseline = Effect.fn("GameText.localizationBaseline")(function* (model, createdAt) {
    const complete = yield* Effect.try({
        try: () => baselineWith(model.evidence, createdAt),
        catch: reportFailure("invalid_baseline")
    });
    const generation = yield* model.query.corpusFingerprint;
    return yield* Effect.try({
        try: () => complete(generation),
        catch: reportFailure("invalid_baseline")
    });
});
const reportFailure = (code) => (cause) => isLocalizationReportError(cause) ? cause : reportError(code, cause);
/** A key that left the manifest, paired one to one with the key that took its place. */
export const LocalizationBaselineKeyChange = Schema.Struct({
    from: LocalizationBaselineEntry,
    to: LocalizationBaselineEntry,
    match: Schema.Literals(["same_place", "same_text"])
});
/**
 * Added, changed, removed and conservatively paired key-change entries with separate line/word
 * totals. Paired old/new keys are not double-counted as removal/addition.
 */
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
function entryCounts(entries) {
    return {
        lines: entries.length,
        sourceWords: entries.reduce((total, entry) => total + entry.sourceWords, 0)
    };
}
/**
 * Compares unique-identity baselines for the same target, preserving conservative key-change
 * pairing. Invalid baselines or target mismatch raise LocalizationReportError directly.
 */
export function diffLocalizationBaselines(previous, current) {
    if (!baselineValid(previous) || !baselineValid(current))
        throw reportError("invalid_baseline");
    if (previous.target !== current.target)
        throw reportError("baseline_target_mismatch");
    const before = new Map(previous.entries.map((entry) => [identityKey(entry), entry]));
    const after = new Map(current.entries.map((entry) => [identityKey(entry), entry]));
    const sorted = (entries) => [...entries].sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key));
    const keyChanged = pairBaselineKeys(previous.entries.filter((entry) => !after.has(identityKey(entry))), current.entries.filter((entry) => !before.has(identityKey(entry))), previous.entries, current.entries);
    const pairedFrom = new Set(keyChanged.map((item) => identityKey(item.from)));
    const pairedTo = new Set(keyChanged.map((item) => identityKey(item.to)));
    const added = sorted(current.entries.filter((entry) => !before.has(identityKey(entry)) && !pairedTo.has(identityKey(entry))));
    const changed = sorted(current.entries.filter((entry) => {
        const old = before.get(identityKey(entry));
        return old !== undefined && old.sourceFingerprint !== entry.sourceFingerprint;
    }));
    const removed = sorted(previous.entries.filter((entry) => !after.has(identityKey(entry)) && !pairedFrom.has(identityKey(entry))));
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
 * manifest path names, then by a source fingerprint that names one entry in each whole baseline,
 * so text an unchanged entry also has never pairs.
 */
function pairBaselineKeys(removed, added, previous, current) {
    const texts = (entries) => {
        const counts = new Map();
        for (const entry of entries)
            counts.set(entry.sourceFingerprint, (counts.get(entry.sourceFingerprint) ?? 0) + 1);
        return counts;
    };
    const previousTexts = texts(previous);
    const currentTexts = texts(current);
    const tiers = [
        [
            "same_place",
            (entry) => (entry.path === undefined ? undefined : manifestPlace(entry.path))
        ],
        [
            "same_text",
            (entry, counts) => counts.get(entry.sourceFingerprint) === 1 ? entry.sourceFingerprint : undefined
        ]
    ];
    const pairs = [];
    let olds = [...removed];
    let news = [...added];
    for (const [match, keyOf] of tiers) {
        const group = (entries, counts) => {
            const byKey = new Map();
            for (const entry of entries) {
                const key = keyOf(entry, counts);
                if (key !== undefined)
                    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
            }
            return byKey;
        };
        const oldByKey = group(olds, previousTexts);
        const newByKey = group(news, currentTexts);
        const paired = new Set();
        for (const [key, fresh] of newByKey) {
            const earlier = oldByKey.get(key);
            const [from] = earlier ?? [];
            const [to] = fresh;
            if (earlier?.length !== 1 || fresh.length !== 1 || !from || !to)
                continue;
            pairs.push({ from, to, match });
            paired.add(from).add(to);
        }
        olds = olds.filter((entry) => !paired.has(entry));
        news = news.filter((entry) => !paired.has(entry));
    }
    return pairs.sort((a, b) => a.to.namespace.localeCompare(b.to.namespace) || a.to.key.localeCompare(b.to.key));
}
/** "not_tracked" until the project has a review file for the target. */
const ReviewProgress = Schema.Union([
    Schema.Literal("not_tracked"),
    Schema.Struct({ lines: Count, percent: Schema.NullOr(Schema.Finite) })
]);
/**
 * Per-culture state, translation and review progress with explicit unknown totals. Null
 * percentages/counts and not_tracked review preserve unavailable evidence instead of inventing
 * zero progress.
 */
export const LocalizationProgressCulture = Schema.Struct({
    culture: CultureCode,
    states: Schema.Record(LocalizationState, Counts),
    notSynced: Counts,
    reducedSourceChecking: Count,
    unknownReasons: Schema.Record(LocalizationUnknownReason, Count),
    total: Counts,
    upToDateArchive: Schema.Struct({ lines: Schema.NullOr(Count), sourceWords: Words }),
    translatedPercent: Schema.Struct({
        lines: Schema.NullOr(Schema.Finite),
        words: Schema.NullOr(Schema.Finite)
    }),
    reviewed: ReviewProgress,
    proofread: ReviewProgress,
    baselineDelta: Schema.optionalKey(LocalizationBaselineDelta)
});
const decodeStates = Schema.decodeSync(LocalizationProgressCulture.fields.states);
const decodeUnknownReasons = Schema.decodeSync(LocalizationProgressCulture.fields.unknownReasons);
/**
 * Versioned target progress report with culture totals, word-count diagnostics and
 * package/gather coverage. Pending PO edits remain separate from archive/shipping progress.
 */
export const LocalizationProgressReport = Schema.Struct({
    schemaVersion: Schema.Literal(1),
    target: LocalizationTargetName,
    wordCountAlgorithm: Schema.Literal("unicode-line-break-v1"),
    wordCountDiagnostics: Schema.Array(Schema.Struct({
        ...LocalizationIdentity.fields,
        code: Schema.Literal("dictionary_line_breaking_unavailable")
    })),
    cultures: Schema.Array(LocalizationProgressCulture),
    coverage: TextCorpus.fields.coverage,
    packageCoverage: Schema.optionalKey(TextPackageCoverageSummary),
    ...TextCorpusDiagnosticSummary.fields,
    gatherEvidence: Schema.Array(LocalizationFileStatus)
});
const addWords = (total, words) => total === null || words === null ? null : total + words;
const noWords = () => 0;
const isLocalizationState = Schema.is(LocalizationState);
const isLocalizationUnknownReason = Schema.is(LocalizationUnknownReason);
const emptyTally = () => ({
    // SAFETY: one entry per LocalizationState literal, each an empty tally.
    // Verified by: index-reads.test.ts — indexed reports equal localizationProgressReport.
    states: Object.fromEntries(LocalizationState.literals.map((state) => [state, { lines: 0, sourceWords: noWords() }])),
    // SAFETY: one entry per LocalizationUnknownReason literal, each zero.
    // Verified by: index-reads.test.ts — indexed reports equal localizationProgressReport.
    unknownReasons: Object.fromEntries(LocalizationUnknownReason.literals.map((reason) => [reason, 0])),
    reducedSourceChecking: 0,
    notSynced: { lines: 0, sourceWords: noWords() },
    reviewed: 0,
    proofread: 0
});
/** Tallies the joined lines in JavaScript: the reference for the index's grouped counts. */
function joinTallies(join, entries) {
    const wordCounts = new Map(entries.map((entry) => [identityKey(entry), localizationWordCount(entry.source.Text)]));
    const cultures = new Map(join.cultures.map((culture) => [culture, emptyTally()]));
    for (const line of join.lines) {
        const count = wordCounts.get(line.identity ? identityKey(line.identity) : "") ??
            localizationWordCount(line.source);
        const words = count.status === "counted" ? count.words : null;
        for (const mark of line.cultures) {
            const tally = cultures.get(mark.culture);
            if (!tally)
                continue;
            if (line.manifest.length > 0 && mark.review?.status === "current") {
                if (mark.review.flags.includes("reviewed"))
                    tally.reviewed++;
                if (mark.review.flags.includes("proofread"))
                    tally.proofread++;
            }
            if (mark.state === "outside_target" || !line.source.trim())
                continue;
            if (mark.reducedSourceChecking)
                tally.reducedSourceChecking++;
            if (mark.state === "not_synced" || mark.facts.includes("not_synced")) {
                tally.notSynced.lines++;
                tally.notSynced.sourceWords = addWords(tally.notSynced.sourceWords, words);
            }
            const bucket = tally.states[mark.state];
            bucket.lines++;
            bucket.sourceWords = addWords(bucket.sourceWords, words);
            for (const reason of mark.unknownReasons)
                tally.unknownReasons[reason]++;
        }
    }
    return {
        tracked: join.lines.some((line) => line.cultures.some((mark) => mark.review)),
        cultures
    };
}
/**
 * Tallies the same totals with grouped counts in Rust: states with Unreal word counts, unknown
 * reasons, not-synced lines and review flags, over the lines the target's join holds.
 */
const indexTallies = Effect.fn("GameText.localizationReportTallies")(function* (model) {
    const lines = {
        query: "",
        capability: "all",
        localization: { target: model.localization.target }
    };
    const [states, reasons, facts, statuses, flags, page] = yield* Effect.all([
        model.query.aggregate({ ...lines, by: ["culture", "state"], measures: ["lineBreakWords"] }),
        model.query.aggregate({ ...lines, by: ["culture", "state", "unknown_reason"] }),
        model.query.aggregate({
            ...lines,
            by: ["culture", "state", "fact"],
            measures: ["lineBreakWords"]
        }),
        model.query.aggregate({ ...lines, by: ["culture", "review_status"] }),
        model.query.aggregate({ ...lines, by: ["culture", "gathered", "review_flag"] }),
        model.query.search({ ...lines, pageSize: 1 })
    ]);
    const cultures = new Map(model.localization.cultures.map((culture) => [culture, emptyTally()]));
    const words = (group) => (group.unknownWords ?? 0) > 0 ? null : (group.lineBreakWords ?? 0);
    for (const group of states.groups) {
        const [culture = "", state] = group.key;
        const tally = cultures.get(culture);
        if (!tally || !isLocalizationState(state) || state === "outside_target")
            continue;
        tally.states[state] = { lines: group.lines, sourceWords: words(group) };
    }
    for (const group of reasons.groups) {
        const [culture = "", state, reason] = group.key;
        const tally = cultures.get(culture);
        if (tally && state !== "outside_target" && isLocalizationUnknownReason(reason))
            tally.unknownReasons[reason] += group.lines;
    }
    for (const group of facts.groups) {
        const [culture = "", state, fact] = group.key;
        const tally = cultures.get(culture);
        if (!tally || state === "outside_target" || fact !== "not_synced")
            continue;
        tally.notSynced.lines += group.lines;
        tally.notSynced.sourceWords = addWords(tally.notSynced.sourceWords, words(group));
    }
    for (const group of flags.groups) {
        const [culture = "", gathered, flag] = group.key;
        const tally = cultures.get(culture);
        if (!tally || gathered !== "true")
            continue;
        if (flag === "reviewed")
            tally.reviewed += group.lines;
        if (flag === "proofread")
            tally.proofread += group.lines;
    }
    // Reduced source checking holds for a whole culture: its PO file has no source text.
    for (const counts of page.localization?.counts ?? []) {
        const tally = cultures.get(counts.culture);
        if (!tally || counts.reducedSourceChecking === 0)
            continue;
        tally.reducedSourceChecking = LocalizationState.literals
            .filter((state) => state !== "outside_target")
            .reduce((total, state) => total + tally.states[state].lines, 0);
    }
    return { tracked: statuses.groups.length > 0, cultures };
});
const noArchive = { translatedLines: 0, translatedWords: 0, coverage: false };
const reportFacts = new WeakMap();
/** Word counts of the entries' sources; a source repeated by several entries is counted once. */
function manifestWords(entries) {
    const counted = new Map();
    return entries.map((entry) => {
        let count = counted.get(entry.source.Text);
        if (count === undefined) {
            count = localizationWordCount(entry.source.Text);
            counted.set(entry.source.Text, count);
        }
        return count;
    });
}
/**
 * Lines and words of the manifest an archive translates: its only entry for the identity has the
 * manifest's source and a translation. GenerateTextLocalizationReport constructs its helper with
 * an empty native culture. Its CSV checks raw manifest source for every culture, without runtime
 * native fallback.
 */
function archiveProgress(manifest, archive, read) {
    if (archive.status !== "read")
        return noArchive;
    // One read: on an index model each read of `value` decodes the whole archive.
    const value = read ?? archive.value;
    // Identities with more than one archive entry match nothing.
    const only = new Map();
    for (const entry of value.entries) {
        const key = identityKey(entry);
        only.set(key, only.has(key) ? null : entry);
    }
    let translatedLines = 0, translatedWords = 0;
    for (let index = 0; index < manifest.entries.length; index++) {
        const archived = only.get(manifest.keys[index]);
        if (!archived ||
            !localizationTextMatches(archived.source, manifest.entries[index].source) ||
            archived.translation.Text === "")
            continue;
        translatedLines++;
        const count = manifest.words[index];
        if (count.status !== "counted")
            translatedWords = null;
        else if (translatedWords !== null)
            translatedWords += count.words;
    }
    return { translatedLines, translatedWords, coverage: value.diagnostics.length === 0 };
}
/** The evidence facts, from the manifest's facts and each culture's archive progress. */
function reportEvidenceFacts(manifest, archives) {
    let totalWords = 0;
    for (const count of manifest.words)
        if (count.status !== "counted")
            totalWords = null;
        else if (totalWords !== null)
            totalWords += count.words;
    return {
        lines: manifest.entries.length,
        totalWords,
        wordCountDiagnostics: manifest.entries.flatMap((entry, index) => manifest.words[index].status === "unknown"
            ? [
                {
                    namespace: entry.namespace,
                    key: entry.key,
                    code: "dictionary_line_breaking_unavailable"
                }
            ]
            : []),
        archives,
        deltas: new WeakMap()
    };
}
/**
 * The evidence facts of a report over these manifest entries. Read afresh each time: the
 * whole-input report is the reference the cached index report is compared with.
 */
function evidenceFacts(evidence, entries) {
    const manifest = { entries, keys: entries.map(identityKey), words: manifestWords(entries) };
    const archives = new Map();
    for (const culture of evidence.cultures)
        archives.set(culture.culture, archiveProgress(manifest, culture.archive));
    return reportEvidenceFacts(manifest, archives);
}
/** Assembles the report from per-culture tallies and the manifest and archive evidence. */
function progressReport(header, join, evidence, facts, tallies, baseline) {
    // Only the entries take part in a comparison, so the current corpus is not fingerprinted.
    let delta = baseline && facts.deltas.get(baseline);
    if (baseline && !delta) {
        delta = diffLocalizationBaselines(baseline, {
            ...baseline,
            target: evidence.target.name,
            entries: baselineEntries(evidence)
        });
        facts.deltas.set(baseline, delta);
    }
    const lines = facts.lines, totalWords = facts.totalWords;
    const cultures = join.cultures.map((culture) => {
        const tally = tallies.cultures.get(culture) ?? emptyTally();
        const { translatedLines, translatedWords, coverage } = facts.archives.get(culture) ?? noArchive;
        // Review applies to gathered lines; the share is over the same total as translation progress.
        const review = (reviewed) => tallies.tracked
            ? { lines: reviewed, percent: lines ? (reviewed / lines) * 100 : null }
            : "not_tracked";
        const result = {
            culture,
            states: decodeStates(tally.states),
            unknownReasons: decodeUnknownReasons(tally.unknownReasons),
            notSynced: tally.notSynced,
            reducedSourceChecking: tally.reducedSourceChecking,
            total: { lines, sourceWords: totalWords },
            upToDateArchive: {
                lines: coverage ? translatedLines : null,
                sourceWords: coverage ? translatedWords : null
            },
            translatedPercent: {
                lines: coverage && lines ? (translatedLines / lines) * 100 : null,
                words: coverage && totalWords && translatedWords !== null
                    ? (translatedWords / totalWords) * 100
                    : null
            },
            reviewed: review(tally.reviewed),
            proofread: review(tally.proofread)
        };
        if (delta)
            Object.assign(result, { baselineDelta: delta });
        return result;
    });
    const report = {
        schemaVersion: 1,
        target: join.target,
        wordCountAlgorithm: "unicode-line-break-v1",
        cultures,
        wordCountDiagnostics: facts.wordCountDiagnostics,
        ...header,
        gatherEvidence: localizationEvidenceFileStatuses(evidence)
    };
    return report;
}
/**
 * Archive totals mirror GetWordCountReport; PO pending edits remain visible in state counts.
 * This reads a whole corpus and join; an index model answers the same report with
 * `indexedLocalizationProgressReport`.
 */
export function localizationProgressReport(corpus, join, evidence, baseline) {
    if (join.target !== evidence.target.name)
        throw reportError("invalid_report_context");
    const entries = manifestEntries(evidence);
    return progressReport(textCorpusReportHeader(corpus), join, evidence, evidenceFacts(evidence, entries), joinTallies(join, entries), baseline);
}
/**
 * The rest of an index model's evidence facts after its manifest entries: word counts, then each
 * archive, yielding between steps so native reads and other requests keep going.
 */
const indexedEvidenceFacts = Effect.fn("GameText.localizationReport.evidence")(function* (evidence, entries, failure) {
    const keys = entries.map(identityKey);
    yield* Effect.yieldNow;
    const words = yield* Effect.try({
        try: () => manifestWords(entries),
        catch: reportFailure(failure)
    }).pipe(Effect.withSpan("GameText.localizationReport.words", {
        attributes: { "game_text.report.lines": entries.length }
    }));
    const manifest = { entries, keys, words };
    const archives = new Map();
    for (const culture of evidence.cultures) {
        yield* Effect.yieldNow;
        const archive = culture.archive;
        // An index model decodes the archive page by page, yielding to other work between pages.
        const read = archive.status === "read"
            ? yield* readEvidenceValue(archive).pipe(Effect.catchDefect((cause) => Effect.fail(reportFailure(failure)(cause))))
            : undefined;
        yield* Effect.yieldNow;
        archives.set(culture.culture, yield* Effect.try({
            try: () => archiveProgress(manifest, archive, read),
            catch: reportFailure(failure)
        }).pipe(Effect.withSpan("GameText.localizationReport.archive", {
            attributes: { "game_text.report.culture": culture.culture }
        })));
    }
    const facts = reportEvidenceFacts(manifest, archives);
    reportFacts.set(evidence, facts);
    return facts;
});
/**
 * The progress report of an index model, built from grouped counts and the corpus header in Rust
 * instead of the corpus and the join: the same report `localizationProgressReport` makes. The
 * first report of an evidence object reads its manifest and archives while the native reads run;
 * later reports, such as further pages, the CSV and baseline comparisons, reuse what it found.
 */
export const indexedLocalizationProgressReport = Effect.fn("GameText.localizationReport")(function* (model, baseline) {
    if (model.localization.target !== model.evidence.target.name)
        return yield* reportError("invalid_report_context");
    const cached = reportFacts.get(model.evidence);
    yield* Effect.annotateCurrentSpan("game_text.report.evidence_cached", cached !== undefined);
    // A manifest that cannot be read fails the report before any native read.
    const entries = cached
        ? undefined
        : yield* Effect.gen(function* () {
            const manifest = model.evidence.manifest;
            const read = manifest.status === "read"
                ? yield* readEvidenceValue(manifest).pipe(Effect.catchDefect((cause) => Effect.fail(reportFailure("invalid_report_context")(cause))))
                : undefined;
            yield* Effect.yieldNow;
            return yield* Effect.try({
                try: () => manifestEntries(model.evidence, read),
                catch: reportFailure("invalid_report_context")
            });
        }).pipe(Effect.withSpan("GameText.localizationReport.manifest"));
    const failure = baseline ? "invalid_baseline" : "invalid_report_context";
    const [[header, tallies], facts] = yield* Effect.all([
        Effect.all([model.query.readCorpusReportHeader, indexTallies(model)]),
        entries
            ? indexedEvidenceFacts(model.evidence, entries, failure)
            : Effect.succeed(cached)
    ], { concurrency: 2 });
    return yield* Effect.try({
        try: () => progressReport(header, model.localization, model.evidence, facts, tallies, baseline),
        catch: reportFailure(failure)
    }).pipe(Effect.withSpan("GameText.localizationReport.assemble"));
});
