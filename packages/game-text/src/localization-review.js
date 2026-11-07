import { CultureCode, LocalizationReviewFlag, LocalizationTargetName, TextKey, TextNamespace, localizationReviewFingerprint, shippedEvidenceTranslation } from "@ue-shed/localization/browser";
import { Schema } from "effect";
export { LocalizationReviewFlag } from "@ue-shed/localization/browser";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
/**
 * `review_lines` answered from parsed evidence files rather than an index: what hosts without one
 * read, and the reference native answers are compared with. Each file is read once per call; the
 * translation is `shippedEvidenceTranslation`'s, so the fingerprint is
 * `localizationEvidenceFingerprint`'s, whose doc names where it differs from the engine's.
 */
export function evidenceReviewLines(evidence, request) {
    const files = evidence.cultures.find((item) => item.culture === request.culture);
    const notGathered = { status: "not_gathered" };
    if (evidence.target.name !== request.target || files === undefined)
        return request.identities.map(() => notGathered);
    const id = (namespace, key) => JSON.stringify([namespace, key]);
    const grouped = (entries, identity) => {
        const groups = new Map();
        for (const entry of entries) {
            const key = identity(entry);
            if (key === undefined)
                continue;
            const group = groups.get(key);
            if (group === undefined)
                groups.set(key, [entry]);
            else
                group.push(entry);
        }
        return groups;
    };
    const manifest = grouped(evidence.manifest.status === "read" ? evidence.manifest.value.entries : [], (entry) => id(entry.namespace, entry.key));
    const archive = files.archive.status === "read"
        ? grouped(files.archive.value.entries, (entry) => id(entry.namespace, entry.key))
        : undefined;
    // A missing archive translates nothing; an unreadable one leaves its translations unknown.
    const archiveMissing = files.archive.status === "failed" && files.archive.error.code === "file_missing";
    const po = grouped(files.po.status === "read" ? files.po.value.entries : [], (entry) => entry.identity === null ? undefined : id(entry.identity.namespace, entry.identity.key));
    return request.identities.map((identity) => {
        const key = id(identity.namespace, identity.key);
        const source = manifest.get(key)?.[0]?.source.Text;
        if (source === undefined)
            return notGathered;
        const entries = po.get(key) ?? [];
        const translation = shippedEvidenceTranslation(archive === undefined ? (archiveMissing ? [] : undefined) : (archive.get(key) ?? []), entries);
        const [entry] = entries;
        return {
            status: "found",
            source,
            translation,
            fingerprint: localizationReviewFingerprint(source, translation),
            po: entry === undefined ? null : { msgid: entry.msgid }
        };
    });
}
/** The source a review is about: the gathered source, which is what translators worked from. */
function reviewSource(line) {
    return line.manifest[0]?.source.Text ?? line.source;
}
/** Fingerprint of the line's source and the translation that ships next for a culture. */
export function localizationLineFingerprint(line, culture) {
    return localizationReviewFingerprint(reviewSource(line), localizationShippedTranslation(culture).value);
}
const key = (culture, namespace, name) => JSON.stringify([culture, namespace, name]);
/** Adds each culture's review state; lines without an Unreal identity cannot be reviewed. */
export function applyLocalizationReview(join, file) {
    if (file === undefined || file.target !== join.target)
        return join;
    const records = new Map(file.records.map((record) => [key(record.culture, record.namespace, record.key), record]));
    return {
        ...join,
        lines: join.lines.map((line) => {
            const identity = line.identity;
            if (identity === null)
                return line;
            return {
                ...line,
                cultures: line.cultures.map((culture) => {
                    const record = records.get(key(culture.culture, identity.namespace, identity.key));
                    const review = record === undefined
                        ? { status: "not_reviewed" }
                        : {
                            status: record.fingerprint ===
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
/**
 * Tests a culture mark against review-file scope. Missing review/proofread work includes only
 * reviewable translation states; changed fingerprints invalidate previous current flags.
 */
export function matchesLocalizationReview(mark, lens) {
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
 * Filters only findings accepted for the exact retained source/translation fingerprint. Changed
 * evidence makes a finding reappear; returns the number removed alongside retained findings.
 */
export function withoutAcceptedFindings(join, findings, file) {
    const keep = acceptedFindingFilter(file);
    if (keep === undefined)
        return { findings, accepted: 0 };
    const lines = new Map(join.lines.map((line) => [line.id, line]));
    const kept = findings.filter((finding) => keep(lines.get(finding.lineId), finding));
    return { findings: kept, accepted: findings.length - kept.length };
}
/** The per-line form, for scans that never hold the whole join. Undefined when nothing is accepted. */
export function acceptedFindingFilter(file) {
    const keep = lazyAcceptedFindingFilter(file);
    return (keep &&
        ((line, finding) => keep(() => line, finding)));
}
/**
 * As `acceptedFindingFilter`, for scans that read lines on demand: it reads a finding's line only
 * when that finding was accepted.
 */
export function lazyAcceptedFindingFilter(file) {
    if (file === undefined || file.acceptedFindings.length === 0)
        return undefined;
    const accepted = new Map(file.acceptedFindings.map((finding) => [
        JSON.stringify([finding.check, finding.culture ?? "", finding.namespace, finding.key]),
        finding.fingerprint
    ]));
    return (lineOf, finding) => {
        if (finding.identity === null)
            return true;
        const fingerprint = accepted.get(JSON.stringify([
            finding.ruleId,
            finding.culture,
            finding.identity.namespace,
            finding.identity.key
        ]));
        if (fingerprint === undefined)
            return true;
        const line = lineOf();
        const culture = line?.cultures.find((item) => item.culture === finding.culture);
        return (line === undefined ||
            culture === undefined ||
            localizationLineFingerprint(line, culture) !== fingerprint);
    };
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
/**
 * Bounded target-scoped review flag or finding-acceptance changes. The host supplies current
 * evidence fingerprints rather than trusting fingerprints from the caller.
 */
export const LocalizationReviewRequest = Schema.Struct({
    target: LocalizationTargetName,
    changes: Schema.Array(LocalizationReviewChange).check(Schema.isMinLength(1), Schema.isMaxLength(500))
});
/**
 * Review-file write outcome with project-relative destination or explicit unavailable/failure
 * state. A failed write must not be displayed as persisted review progress.
 */
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
