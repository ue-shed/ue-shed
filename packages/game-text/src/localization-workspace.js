import { textLocationPath } from "./text-origin.js";
import { Effect, Schema } from "effect";
import { materializeQualityRead } from "./quality-hydration.js";
import { CultureCode, LocalizationTargetName, LocalizationChange, LocalizationChangeSet } from "@ue-shed/localization/browser";
import { TextCorpus, TextLocation, TextUnitId } from "./schema.js";
import { TextQualityFindingId, TextQualityFocus, textQualityFindingFocus, textQualityFindingId, textQualityQuery } from "./quality-query.js";
import { TextQualityAffectedOccurrence, TextQualityRuleSummary } from "./quality-schema.js";
import { LocalizationCheckDiagnostic } from "./localization-quality-schema.js";
import { LocalizationFocus, localizationFocusPage, localizationScopeSummary } from "./localization-view.js";
import { LocalizationUnknownReason } from "./localization-schema.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import { LocalizationProgressCulture } from "./localization-reports.js";
import { LocalizationFileProblem, localizationEvidenceFolder, localizationFileProblems } from "./localization-status.js";
import { textCountLabel } from "./csv.js";
import { textAssetName, spreadsheetCsv } from "./csv.js";
import { CheckSeverity } from "./localization-check-ids.js";
import { localizationCheckCatalogue, projectRuleKinds } from "./localization-check-catalogue.js";
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Offset = Schema.optionalKey(Count);
const Excerpt = Schema.String.check(Schema.isMaxLength(4096));
/** The built-in filters: every finding, the project rule kinds and each built-in check. */
export const BuiltInQualityFilter = Schema.Literals([
    "all",
    "character_budget",
    "terminology",
    "format_arguments",
    "argument_modifiers",
    "rich_text",
    "po_escape_safety",
    "whitespace",
    "empty_translation",
    "missing_translator_notes",
    "duplicate_source",
    "format_argument_renamed",
    "rich_text_tags",
    "rich_text_tag_case",
    "line_breaks",
    "segment_separator",
    "length_outlier",
    "outdated_translation",
    "inconsistent_translation",
    "culture_invariant_text",
    "placeholder_text",
    "source_whitespace",
    "source_markup",
    "number_only_text",
    "string_table_key_collision",
    "rich_text_tags_added",
    "source_line_endings_changed",
    "placeholder_translation",
    "shared",
    "long"
]);
/** A custom check's filter: `custom.` and the check's rule ID. */
export const CustomQualityFilter = Schema.TemplateLiteral(["custom.", Schema.String]);
/** A built-in filter, or a custom check's: the filter list is the rule file's, not fixed. */
export const WorkspaceQualityFilter = Schema.Union([BuiltInQualityFilter, CustomQualityFilter]);
const isBuiltInFilter = Schema.is(BuiltInQualityFilter);
/** The filter of a custom check's findings. */
export function customQualityFilter(ruleId) {
    return `custom.${ruleId}`;
}
/**
 * A filter's name in lists: the check's catalogue label, the project rule kind's, or a custom
 * check's label from `customLabels` (by filter), falling back to its rule ID.
 */
export function workspaceQualityLabel(filter, customLabels) {
    if (!isBuiltInFilter(filter))
        return customLabels?.get(filter) ?? filter.slice("custom.".length);
    if (filter === "all")
        return "All findings";
    if (filter === "character_budget" || filter === "terminology")
        return projectRuleKinds[filter].label;
    return localizationCheckCatalogue[filter].label;
}
/** A check's default severity, from the catalogue; every finding of a check shares it. */
export function workspaceQualitySeverity(filter) {
    if (!isBuiltInFilter(filter))
        return "normal";
    if (filter === "character_budget" || filter === "terminology")
        return projectRuleKinds[filter].severity;
    return localizationCheckCatalogue[filter].severity;
}
const Selection = { target: LocalizationTargetName, culture: Schema.optionalKey(CultureCode) };
/**
 * What narrows a quality list besides its check. `query` searches as the Text tab does: each
 * word in the line's source or in the finding's culture's translation, ignoring case; a source
 * finding's own source text. `severities` keeps those severities' findings, and `fixable` the
 * findings with (or without) a suggested fix.
 */
export const WorkspaceQualityNarrowing = {
    query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
    severities: Schema.optionalKey(Schema.Array(CheckSeverity).check(Schema.isMaxLength(3))),
    fixable: Schema.optionalKey(Schema.Boolean)
};
/**
 * Target/culture quality-list request with a filter, its narrowing and an offset. The workspace
 * retains complete findings while each host page stays bounded.
 */
export const WorkspaceQualityRequest = Schema.Struct({
    ...Selection,
    filter: WorkspaceQualityFilter,
    ...WorkspaceQualityNarrowing,
    offset: Offset
});
/**
 * Finding focus request with separate occurrence and PO-context offsets. Offsets belong to the
 * retained target/culture quality generation.
 */
export const WorkspaceQualityFocusRequest = Schema.Struct({
    ...Selection,
    id: TextQualityFindingId,
    occurrenceOffset: Offset,
    poContextOffset: Offset
});
const SourceVariants = Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(Schema.isMinLength(2), Schema.isMaxLength(16));
/**
 * Bounded host finding preview with policy severity, source/problem/context and optional first
 * saved location. Full structured evidence remains available through focus/report operations.
 */
export const WorkspaceFinding = Schema.Struct({
    id: TextQualityFindingId,
    filter: WorkspaceQualityFilter,
    severity: CheckSeverity,
    source: Schema.String.check(Schema.isMaxLength(512)),
    /** A key's conflicting saved texts, listed apart; `source` is the gathered one or the first. */
    sourceVariants: Schema.optionalKey(SourceVariants),
    problem: Schema.String.check(Schema.isMaxLength(1024)),
    context: Schema.String.check(Schema.isMaxLength(1024)),
    culture: Schema.optionalKey(CultureCode),
    /** The first place the finding affects, so hosts can name it the way they name a line's places. */
    location: Schema.optionalKey(TextLocation),
    /** How many places the finding affects. */
    locations: Schema.optionalKey(Count)
});
/**
 * Bounded quality findings plus exact filter/severity totals, custom filter labels and
 * check-limit counts. Unsupported evidence remains separate from a clean check result.
 */
export const WorkspaceQualityPage = Schema.Struct({
    findings: Schema.Array(WorkspaceFinding).check(Schema.isMaxLength(50)),
    total: Count,
    counts: Schema.Record(WorkspaceQualityFilter, Count),
    /** The rule file's custom checks: their filters and labels, in the file's order. */
    customFilters: Schema.Array(Schema.Struct({ filter: CustomQualityFilter, label: Schema.String })).check(Schema.isMaxLength(512)),
    /**
     * Counts follow every filter but their own: `counts` each check's findings under the
     * narrowing, and `severityCounts` each severity's findings under the check and the narrowing
     * without `severities`. `total` follows every filter.
     */
    severityCounts: Schema.Record(CheckSeverity, Count),
    nextOffset: Offset,
    suggestedFixCount: Count,
    limits: Schema.Array(Schema.Struct({ code: LocalizationCheckDiagnostic.fields.code, count: Count })).check(Schema.isMaxLength(32)),
    unsupportedRuleCultures: Count,
    rules: Schema.Array(TextQualityRuleSummary).check(Schema.isMaxLength(1032))
});
const decodeCounts = Schema.decodeUnknownEffect(WorkspaceQualityPage.fields.counts);
const decodeQualityCounts = Schema.decodeUnknownSync(WorkspaceQualityPage.fields.counts);
/** File reports keep every matching finding; renderer pages remain bounded. */
export const WorkspaceQualityReport = WorkspaceQualityPage.mapFields(({ nextOffset: _offset, ...fields }) => ({
    ...fields,
    findings: Schema.Array(WorkspaceFinding),
    corpusCoverage: TextCorpus.fields.coverage,
    status: TextCorpus.fields.status,
    target: WorkspaceQualityRequest.fields.target,
    culture: WorkspaceQualityRequest.fields.culture,
    filter: WorkspaceQualityRequest.fields.filter,
    ...WorkspaceQualityNarrowing
}));
const Failure = Schema.Struct({
    status: Schema.Literal("failed"),
    message: Schema.String,
    recovery: Schema.String
});
const NotReady = Schema.Struct({ status: Schema.Literal("not_ready") });
/**
 * Quality page outcome separating ready data, unavailable state and recoverable host failure.
 * An unavailable page is not an empty successful audit.
 */
export const WorkspaceQualityResult = Schema.Union([
    NotReady,
    Failure,
    Schema.Struct({ status: Schema.Literal("ready"), page: WorkspaceQualityPage })
]);
const BoundedChange = LocalizationChange.mapFields((fields) => ({
    ...fields,
    source: Schema.String.check(Schema.isMaxLength(16384)),
    translation: Schema.String.check(Schema.isMaxLength(16384)),
    previousTranslation: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16384)))
}));
const isBoundedChange = Schema.is(BoundedChange);
const Changes = LocalizationChangeSet.mapFields((fields) => ({
    ...fields,
    provenance: fields.provenance.mapFields((provenance) => ({
        ...provenance,
        files: provenance.files.check(Schema.isMaxLength(0))
    })),
    changes: Schema.Array(BoundedChange).check(Schema.isMaxLength(100))
}));
/**
 * Bounded proposed localization change document with remaining-change count. Ready means the
 * proposal is available; it does not mean any file has been written.
 */
export const WorkspaceChangesResult = Schema.Union([
    NotReady,
    Failure,
    Schema.Struct({
        status: Schema.Literal("ready"),
        document: Changes,
        remaining: Count
    })
]);
const Range = Schema.Struct({ start: Count, end: Count });
/**
 * Focused localization finding with bounded source/translation ranges, occurrences and PO
 * context. Suggested changes remain proposals requiring the localization write workflow.
 */
export const WorkspaceLocalizationFindingFocus = Schema.Struct({
    kind: Schema.Literal("localization"),
    id: TextQualityFindingId,
    source: Excerpt,
    translation: Schema.NullOr(Excerpt),
    translationOrigin: Schema.Literals(["po", "archive", "absent"]),
    sourceRanges: Schema.Array(Range).check(Schema.isMaxLength(64)),
    translationRanges: Schema.Array(Range).check(Schema.isMaxLength(64)),
    truncated: Schema.Boolean,
    sourceVariants: Schema.optionalKey(SourceVariants),
    problem: WorkspaceFinding.fields.problem,
    recovery: Schema.String,
    check: WorkspaceQualityFilter,
    severity: CheckSeverity,
    /** The rule a review file records when someone accepts this finding. */
    ruleId: Schema.String,
    culture: CultureCode,
    textUnitId: Schema.optionalKey(TextUnitId),
    affectedOccurrences: Schema.Array(TextQualityAffectedOccurrence).check(Schema.isMaxLength(50)),
    totalOccurrences: Count,
    nextOccurrenceOffset: Offset,
    translations: LocalizationFocus,
    suggestedChange: Schema.optionalKey(BoundedChange)
});
/**
 * Quality focus outcome for source or localization findings, including explicit not-found,
 * unavailable and failed states. Branch on kind before reading domain-specific evidence.
 */
export const WorkspaceQualityFocusResult = Schema.Union([
    NotReady,
    Failure,
    Schema.Struct({ status: Schema.Literal("not_found") }),
    Schema.Struct({
        status: Schema.Literal("found"),
        focus: Schema.Union([
            Schema.Struct({ kind: Schema.Literal("source"), focus: TextQualityFocus }),
            WorkspaceLocalizationFindingFocus
        ])
    })
]);
/**
 * Maps structured finding kind to its workspace filter key, including project rules and custom
 * checks. Policy severity does not affect the filter identity.
 */
export function workspaceQualityFilterOf(finding) {
    if (finding.kind === "localization_character_budget")
        return "character_budget";
    if (finding.kind === "localization_terminology")
        return "terminology";
    if (finding.kind === "custom")
        return customQualityFilter(finding.ruleId);
    return finding.kind;
}
const braced = (names) => names.map((name) => "{" + name + "}").join(", ");
const tagged = (names) => names.map((name) => "<" + name + ">").join(", ");
const quoted = (text) => "“" + (text.length > 40 ? text.slice(0, 39) + "…" : text) + "”";
function problem(finding) {
    switch (finding.kind) {
        case "format_arguments":
            return [
                finding.actual.missing.length ? "Missing " + braced(finding.actual.missing) : "",
                finding.actual.added.length ? "uses " + braced(finding.actual.added) : ""
            ]
                .filter(Boolean)
                .join(" · ");
        case "argument_modifiers":
            return "Check plural, ordinal and gender forms";
        case "rich_text":
            return "Unbalanced rich text tag";
        case "po_escape_safety":
            return "Unsafe escape " + finding.actual.sequences.join(", ");
        case "whitespace":
            return finding.actual.trailing !== finding.expectation.trailing
                ? "Trailing space"
                : finding.actual.leading !== finding.expectation.leading
                    ? "Leading space"
                    : "Whitespace or line breaks differ";
        case "empty_translation":
            return "Empty translation";
        case "missing_translator_notes":
            return "No translator notes";
        case "duplicate_source":
            return ("Same text, different keys · " + textCountLabel(finding.actual.identityCount, "key"));
        case "format_argument_renamed":
            return finding.actual.renamed
                .map(({ from, to }) => "{" + from + "} should be {" + to + "}")
                .join(" · ");
        case "rich_text_tags":
            return [
                finding.actual.missing.length ? "Missing " + tagged(finding.actual.missing) : "",
                finding.actual.added.length ? "adds " + tagged(finding.actual.added) : ""
            ]
                .filter(Boolean)
                .join(" · ");
        case "rich_text_tags_added":
            return "Adds " + tagged(finding.actual.added);
        case "rich_text_tag_case":
            return finding.actual.changed
                .map(({ source, translation }) => "<" + translation + "> should be <" + source + ">")
                .join(" · ");
        case "line_breaks":
            return (textCountLabel(finding.actual.lineBreaks, "line break") +
                ", source has " +
                finding.expectation.lineBreaks);
        case "segment_separator":
            return (quoted(finding.actual.separator) +
                " " +
                finding.actual.count +
                "×, source has " +
                finding.expectation.count +
                "×");
        case "length_outlier":
            return ((finding.actual.ratio < 1 ? "Much shorter" : "Much longer") +
                " than the source · " +
                finding.actual.ratio +
                "×");
        case "outdated_translation":
            return "Translated from " + quoted(finding.actual.translatedSource);
        case "source_line_endings_changed":
            return "Source line endings changed since it was translated";
        case "placeholder_translation":
            return "Placeholder translation " + quoted(finding.actual.translation);
        case "inconsistent_translation":
            return finding.actual.untranslated &&
                finding.actual.variants[0]?.translation !== finding.actual.translation
                ? "Not translated · " +
                    textCountLabel(finding.actual.variants[0]?.lines ?? 0, "line") +
                    " use " +
                    quoted(finding.actual.variants[0]?.translation ?? "")
                : finding.actual.untranslated
                    ? "Not translated, while " +
                        textCountLabel(finding.actual.variants
                            .slice(1)
                            .reduce((sum, variant) => sum + variant.lines, 0), "line") +
                        " translate it"
                    : "Translated inconsistently · " +
                        textCountLabel(finding.actual.variantCount, "translation") +
                        ", most use " +
                        quoted(finding.actual.variants[0]?.translation ?? "");
        case "culture_invariant_text":
            return "Won’t be translated: culture invariant";
        case "placeholder_text":
            return "Placeholder " + finding.actual.matches.map(quoted).join(", ");
        case "source_whitespace":
            return finding.actual.leading || finding.actual.trailing
                ? "Space or line break at the start or end"
                : "Doubled spaces";
        case "source_markup":
            return finding.actual.xmlClosings?.length
                ? "Closes with " +
                    finding.actual.xmlClosings.map((name) => "</" + name + ">").join(", ") +
                    "; rich text closes with </>"
                : finding.actual.richText.opening !== finding.actual.richText.closing
                    ? "Unbalanced rich-text tags"
                    : "Unbalanced { }";
        case "number_only_text":
            return "Number-only text sent for translation";
        case "string_table_key_collision":
            return ("Key in " +
                textCountLabel(finding.actual.tableCount, "String Table") +
                " with one namespace");
        case "shared":
            return "Used in " + textCountLabel(finding.actual.occurrences, "place");
        case "long":
            return "Long text · " + textCountLabel(finding.actual.length, "character");
        case "character_budget":
        case "localization_character_budget":
            return ("Maximum " +
                textCountLabel(finding.expectation.maximumCharacters, "character") +
                " · " +
                textCountLabel(finding.actual.characterCount, "character"));
        case "terminology":
        case "localization_terminology":
            return finding.expectation.kind === "forbidden_term"
                ? "Remove “" + finding.actual.term + "”"
                : "Prefer “" +
                    finding.expectation.preferredTerm +
                    "” · uses “" +
                    finding.actual.term +
                    "”";
        case "custom":
            return finding.check === "rule"
                ? finding.label
                : finding.label + " · " + customProblem(finding);
    }
}
function customProblem(finding) {
    // A complete rule's evidence is its own; its label says what it found.
    if (finding.check === "rule")
        return finding.label;
    const { actual, expectation } = finding;
    if (finding.check === "length")
        return (textCountLabel(actual.length ?? 0, "character") +
            (expectation.minimum !== undefined ? " · minimum " + expectation.minimum : "") +
            (expectation.maximum !== undefined ? " · maximum " + expectation.maximum : ""));
    const matches = actual.matches ?? [];
    if (finding.check === "forbidden_term")
        return "Uses " + matches.map((match) => quoted(match.match)).join(", ");
    return expectation.report === "no_match"
        ? "Does not match the pattern"
        : "Matches " + matches.map((match) => quoted(match.match)).join(", ");
}
/**
 * JSON with object keys sorted at every level: listed properties serialize in list order, so equal
 * values hash equally whether a schema or a check built them.
 */
function canonicalJson(finding) {
    const values = [
        finding.lineId,
        finding.culture,
        finding.ruleId,
        finding.kind,
        finding.actual,
        finding.expectation
    ];
    const keys = new Set();
    JSON.stringify(values, (key, item) => {
        keys.add(key);
        return item;
    });
    return JSON.stringify(values, [...keys].sort());
}
/**
 * Two 32-bit lanes of a fast string hash over the finding's line, culture, rule, check and
 * observed and expected values. IDs stay stable while that text is unchanged.
 */
export function localizationFindingHash(finding) {
    const text = canonicalJson(finding);
    let first = 0x811c9dc5, second = 0x9e3779b9;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ code, 0x5bd1e995);
        second ^= second >>> 15;
    }
    return [first >>> 0, second >>> 0];
}
/**
 * Derives a localization finding identity from stable evidence fields. Severity/display labels
 * are not identity, so adjusting policy presentation does not erase accepted-review matching.
 */
export function localizationFindingId([first, second]) {
    return TextQualityFindingId.make("localization-finding:" +
        first.toString(16).padStart(8, "0") +
        second.toString(16).padStart(8, "0"));
}
/** The finding's suggested change when it fits a proposal; otherwise undefined. */
export function eligibleLocalizationChange(finding) {
    return "suggestedChange" in finding &&
        finding.suggestedChange &&
        isBoundedChange(finding.suggestedChange)
        ? finding.suggestedChange
        : undefined;
}
/**
 * The source text a localization finding is about: the checked text for source checks, else the
 * gathered source, else the first of conflicting texts, never the join's joined text.
 */
function findingSource(finding, line) {
    switch (finding.kind) {
        case "duplicate_source":
        case "culture_invariant_text":
        case "placeholder_text":
        case "source_whitespace":
        case "source_markup":
        case "number_only_text":
            return finding.actual.source;
    }
    const variants = "sourceVariants" in finding ? finding.sourceVariants : undefined;
    return line?.manifestSource ?? variants?.[0] ?? line?.source ?? "";
}
const lineFacts = (line) => line && {
    manifestSource: line.manifest[0]?.source.Text,
    manifestPath: line.manifest[0]?.path,
    source: line.source,
    key: line.identity?.key
};
/**
 * Builds a bounded workspace finding preview from structured evidence and an optional joined
 * line. Keeps the original finding/line available alongside presentation text.
 */
export function workspaceQualityItem(finding, line, sourceKey) {
    return { finding, line, summary: qualitySummary(finding, lineFacts(line), sourceKey) };
}
function qualitySummary(finding, line, sourceKey) {
    const localized = "culture" in finding;
    const id = localized
        ? localizationFindingId(localizationFindingHash(finding))
        : textQualityFindingId(finding);
    const location = finding.affectedOccurrences[0]?.location;
    const context = (location
        ? textAssetName(textLocationPath(location))
        : (line?.manifestPath ?? "Source file")) +
        " · " +
        (localized
            ? (finding.identity?.key ?? "No key")
            : (sourceKey ??
                line?.key ??
                (location?.kind === "string_table_entry" ? location.entryKey : finding.ruleId))) +
        " · " +
        (finding.kind === "custom"
            ? finding.label
            : workspaceQualityLabel(workspaceQualityFilterOf(finding))) +
        " · " +
        textCountLabel(finding.affectedOccurrences.length, "location");
    const filter = workspaceQualityFilterOf(finding);
    const variants = "sourceVariants" in finding ? finding.sourceVariants : undefined;
    const summary = {
        id,
        filter,
        severity: localized ? finding.severity : workspaceQualitySeverity(filter),
        source: (localized ? findingSource(finding, line) : finding.actual.source).slice(0, 512),
        ...(variants
            ? { sourceVariants: variants.slice(0, 16).map((variant) => variant.slice(0, 512)) }
            : undefined),
        problem: ((localized ? finding.culture + " · " : "") + problem(finding)).slice(0, 1024),
        context: context.slice(0, 1024),
        ...(localized ? { culture: finding.culture } : undefined),
        ...(location ? { location } : undefined),
        locations: finding.affectedOccurrences.length
    };
    return summary;
}
function ranges(text, finding, side) {
    const matches = [];
    const add = (start, end) => {
        if (matches.length < 64 && start < 4096 && end > start)
            matches.push({ start, end: Math.min(end, 4096) });
    };
    const terms = (values) => {
        for (const term of values) {
            let start = text.indexOf(term);
            while (start >= 0 && matches.length < 64) {
                add(start, start + term.length);
                start = text.indexOf(term, start + term.length);
            }
        }
    };
    const pattern = (expression) => {
        for (const match of text.matchAll(expression))
            add(match.index, match.index + match[0].length);
    };
    switch (finding.kind) {
        case "format_arguments":
            terms((side === "source" ? finding.actual.missing : finding.actual.added).map((name) => "{" + name + "}"));
            break;
        case "format_argument_renamed":
            terms(finding.actual.renamed.map(({ from, to }) => "{" + (side === "source" ? to : from) + "}"));
            break;
        case "localization_terminology":
            if (side === "translation")
                add(finding.actual.start, finding.actual.end);
            break;
        case "custom":
            if (finding.check !== "rule" && side === finding.subject)
                for (const match of finding.actual.matches ?? [])
                    add(match.start, match.end);
            break;
        case "rich_text":
        case "rich_text_tags":
        case "rich_text_tags_added":
        case "rich_text_tag_case":
            pattern(/<[^<>]*>/gu);
            break;
        case "argument_modifiers":
            pattern(/\|(?:plural|ordinal|gender)\([^)]*\)/gu);
            break;
        case "po_escape_safety":
            pattern(/\\[nrt]/gu);
            break;
        case "whitespace":
            pattern(/^\s+|\s+$/gu);
            break;
        case "line_breaks":
            pattern(/\r\n|\r|\n/gu);
            break;
        case "segment_separator":
            terms([finding.actual.separator]);
            break;
        case "placeholder_text":
            if (side === "source")
                terms(finding.actual.matches);
            break;
        case "source_whitespace":
            if (side === "source")
                pattern(/^\s+|\s+$| {2,}/gu);
            break;
        case "source_markup":
            if (side === "source")
                pattern(/<[^<>]*>|[{}]/gu);
            break;
    }
    return matches.sort((a, b) => a.start - b.start);
}
/** A retained index; every page, type count and proposal uses the same culture/filter selection. */
export function localizationQualityWorkspace(source, report, join) {
    const quality = materializedLocalizationQuality(report, join);
    const reads = localizationQualityReads(source, quality);
    return {
        search: (request) => materializeQualityRead(reads.search(request), quality.findings.items),
        export: (request) => materializeQualityRead(reads.export(request), quality.findings.items),
        focus: (request) => materializeQualityRead(reads.focus(request), quality.findings.items),
        changes: (request) => materializeQualityRead(reads.changes(request), quality.findings.items)
    };
}
/** The in-memory form: findings of a whole report, with the join their lines come from. */
function materializedLocalizationQuality(report, join) {
    const lines = new Map(join.lines.map((line) => [line.id, line]));
    const units = new Map(join.lines.flatMap((line) => line.origin.kind === "corpus"
        ? line.origin.unitIds.map((id) => [id, line])
        : []));
    const itemAt = (position) => {
        const finding = report.findings[position];
        return workspaceQualityItem(finding, "culture" in finding ? lines.get(finding.lineId) : units.get(finding.textUnitId));
    };
    return {
        findings: {
            length: report.findings.length,
            culture: (position) => {
                const finding = report.findings[position];
                return ("culture" in finding ? finding.culture : undefined);
            },
            filter: (position) => workspaceQualityFilterOf(report.findings[position]),
            severity: (position) => {
                const finding = report.findings[position];
                return "culture" in finding
                    ? finding.severity
                    : workspaceQualitySeverity(workspaceQualityFilterOf(finding));
            },
            ruleId: (position) => report.findings[position].ruleId,
            eligible: (position) => eligibleLocalizationChange(report.findings[position]) !== undefined,
            reportedBySource: (position) => {
                const finding = report.findings[position];
                return ("culture" in finding &&
                    finding.kind === "placeholder_text" &&
                    finding.unreportedMatches?.length === 0);
            },
            find: (id, culture) => {
                const position = report.findings.findIndex((finding) => (!culture || ("culture" in finding && finding.culture === culture)) &&
                    ("culture" in finding
                        ? localizationFindingId(localizationFindingHash(finding))
                        : textQualityFindingId(finding)) === id);
                return position < 0 ? undefined : position;
            },
            items: (positions) => positions.map(itemAt),
            limits: (culture) => {
                const limits = new Map();
                for (const diagnostic of report.checkDiagnostics) {
                    if (!culture || diagnostic.culture === culture)
                        limits.set(diagnostic.code, (limits.get(diagnostic.code) ?? 0) + 1);
                }
                return [...limits].map(([code, count]) => ({ code, count }));
            }
        },
        metadata: {
            join,
            rules: report.rules.map((rule) => rule.ruleId),
            ...(report.customChecks ? { customChecks: report.customChecks } : undefined),
            unsupportedRuleCultures: report.ruleDiagnostics?.length ?? 0,
            status: report.status,
            coverage: report.coverage,
            lineOfUnit: (id) => units.get(id)
        }
    };
}
/**
 * A whole report's quality in memory, in the shape an index serves, for hosts and tests without
 * an index. Its workspace lists a source report's findings when `localizationQualityWorkspaceOf`
 * is given one.
 */
export function localizationQuality(report, join) {
    const withSource = (source) => {
        const memory = localizationQualityWorkspace(source, report, join);
        return {
            search: (request) => Effect.sync(() => memory.search(request)),
            export: (request) => Effect.sync(() => memory.export(request)),
            focus: (request) => Effect.sync(() => memory.focus(request)),
            changes: (request) => Effect.sync(() => memory.changes(request))
        };
    };
    return { workspace: withSource(undefined), withSource };
}
/**
 * The summary a list showing the rule file's source findings gives an item: a `placeholder_text`
 * finding names only the placeholders the source terminology does not report. The finding and its
 * ID are unchanged.
 */
function withoutSourceReported(item) {
    return {
        ...item,
        summary: withoutSourceReportedSummary(item.finding, item.summary, lineFacts(item.line))
    };
}
function withoutSourceReportedSummary(finding, summary, line) {
    if (!("culture" in finding) || finding.kind !== "placeholder_text")
        return summary;
    const left = finding.unreportedMatches;
    if (!left?.length || left.length === finding.actual.matches.length)
        return summary;
    return {
        ...qualitySummary({ ...finding, actual: { ...finding.actual, matches: left } }, line),
        id: summary.id
    };
}
/**
 * The workspace over any finding list. Pages and exports list blocking findings, then normal, then
 * low; within a severity, source findings come first, then localization findings in report order.
 */
/** A quality search's words, as the engine splits them: lowercase, between whitespace. */
function searchTerms(query) {
    return (query ?? "")
        .toLowerCase()
        .split(/\s+/u)
        .filter((term) => term.length > 0);
}
/**
 * Whether each word is in the finding's source, or for a line finding in its culture's archive
 * translation or, when not synced, its PO text: the text the engine searches. A source finding
 * reads its own source, not the other sources its unit holds.
 */
function itemMatches(item, terms) {
    const finding = item.finding;
    const texts = [
        "culture" in finding ? (item.line?.source ?? item.summary.source) : finding.actual.source
    ];
    if ("culture" in finding) {
        const mark = item.line?.cultures.find((mark) => mark.culture === finding.culture);
        if (mark?.archive)
            texts.push(mark.archive.translation.Text);
        if (mark && (mark.facts.includes("not_synced") || mark.state === "not_synced"))
            texts.push(mark.poTranslation ?? "");
    }
    const lowered = texts.map((text) => text.toLowerCase());
    return terms.every((term) => lowered.some((text) => text.includes(term)));
}
/** The request's narrowing, for a report to record what it lists. */
function narrowingOf(request) {
    return {
        ...(request.query?.trim() ? { query: request.query } : undefined),
        ...(request.severities ? { severities: request.severities } : undefined),
        ...(request.fixable !== undefined ? { fixable: request.fixable } : undefined)
    };
}
/** What a retained selection was selected by. */
function selectionKey(request) {
    return JSON.stringify([
        request.culture ?? null,
        request.filter,
        searchTerms(request.query),
        request.severities ?? null,
        request.fixable ?? null
    ]);
}
function localizationQualityReads(source, { findings: list, metadata }) {
    const sourceFindings = source?.findings ?? [];
    const customFilters = (metadata.customChecks ?? []).map(({ ruleId, label }) => ({
        filter: customQualityFilter(ruleId),
        label
    }));
    // The last page's source IDs also serve focus without hashing every preceding finding.
    const pageSources = new Map();
    const sourceItem = (finding) => {
        // A source summary with an occurrence already has its asset context. Only the joined key
        // is missing; reading all translations and evidence for that key costs far more.
        const item = workspaceQualityItem(finding, metadata.lineOfUnit(finding.textUnitId));
        pageSources.set(item.summary.id, finding);
        return item;
    };
    const sourceItemAt = (position) => sourceItem(sourceFindings[position]);
    const sourceCount = sourceFindings.length, total = sourceCount + list.length;
    // One list shows source and localization findings: a placeholder is reported once. The checks
    // ran with the rule document the source report comes from, and recorded which placeholders
    // its terminology reports; nothing is hydrated here.
    const hidden = (position) => source !== undefined && list.reportedBySource(position);
    const withSummary = (item) => source === undefined ? item : withoutSourceReported(item);
    const inCulture = (request, position) => position < sourceCount ||
        (!hidden(position - sourceCount) &&
            (!request.culture || list.culture(position - sourceCount) === request.culture));
    const filterAt = (position) => position < sourceCount
        ? workspaceQualityFilterOf(sourceFindings[position])
        : list.filter(position - sourceCount);
    /** Source findings have their rule kind's severity; localization findings their stored one. */
    const severityAt = (position) => {
        if (position >= sourceCount)
            return list.severity(position - sourceCount);
        const filter = filterAt(position);
        return filter === "all" ? "normal" : workspaceQualitySeverity(filter);
    };
    const ruleAt = (position) => position < sourceCount
        ? sourceFindings[position].ruleId
        : list.ruleId(position - sourceCount);
    const eligibleAt = (position) => position < sourceCount
        ? eligibleLocalizationChange(sourceFindings[position]) !== undefined
        : list.eligible(position - sourceCount);
    const itemsAt = function* (positions) {
        pageSources.clear();
        const localized = yield positions
            .filter((position) => position >= sourceCount)
            .map((p) => p - sourceCount);
        let next = 0;
        return positions.map((position) => position < sourceCount ? sourceItemAt(position) : withSummary(localized[next++]));
    };
    /** Summaries in batches, so a large export never holds every finding and line at once. */
    const summariesAt = function* (positions) {
        const summaries = [];
        for (let start = 0; start < positions.length; start += 2048)
            for (const item of yield* itemsAt(positions.slice(start, start + 2048)))
                summaries.push(item.summary);
        return summaries;
    };
    /**
     * The narrowing's test besides severities. A search reads every finding's line in the culture
     * selection, in batches, as the engine reads its text columns.
     */
    const narrowedBy = function* (request) {
        const terms = searchTerms(request.query);
        let found;
        if (terms.length > 0) {
            const hits = new Uint8Array(total);
            const positions = [];
            for (let position = 0; position < total; position++)
                if (inCulture(request, position))
                    positions.push(position);
            for (let start = 0; start < positions.length; start += 2048) {
                const batch = positions.slice(start, start + 2048);
                const items = yield* itemsAt(batch);
                items.forEach((item, index) => {
                    if (itemMatches(item, terms))
                        hits[batch[index]] = 1;
                });
            }
            found = hits;
        }
        const fixable = request.fixable;
        return (position) => (fixable === undefined || eligibleAt(position) === fixable) &&
            (found === undefined || found[position] === 1);
    };
    const severityWanted = (request, severity) => request.severities === undefined || request.severities.includes(severity);
    /** Matching positions, blocking findings first, then normal, then low; else in order. */
    const matched = (request, narrowed, wanted = (_position) => true) => {
        const bySeverity = new Map(CheckSeverity.literals.map((severity) => [severity, []]));
        for (let position = 0; position < total; position++)
            if (inCulture(request, position) &&
                (request.filter === "all" || request.filter === filterAt(position)) &&
                severityWanted(request, severityAt(position)) &&
                narrowed(position) &&
                wanted(position))
                bySeverity.get(severityAt(position)).push(position);
        return [...bySeverity.values()].flat();
    };
    // Keep just the current selection's numeric positions and counts. Moving through its pages
    // neither rechecks findings nor walks the full list again; changing selection replaces it.
    const select = (request, narrowed) => {
        const typeCounts = new Map();
        const ruleCounts = new Map();
        const severityCounts = { blocking: 0, normal: 0, low: 0 };
        const matchedBySeverity = {
            blocking: [],
            normal: [],
            low: []
        };
        let cultureCount = 0, matchedCount = 0, suggestedFixCount = 0;
        // Counts follow every filter but their own, as the engine counts them.
        const record = (filter, severity, rule, count, eligible) => {
            const byFilter = request.filter === "all" || request.filter === filter, bySeverity = severityWanted(request, severity);
            if (bySeverity) {
                cultureCount += count;
                typeCounts.set(filter, (typeCounts.get(filter) ?? 0) + count);
                ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + count);
            }
            if (byFilter)
                severityCounts[severity] += count;
            if (!byFilter || !bySeverity)
                return false;
            matchedCount += count;
            suggestedFixCount += eligible;
            return true;
        };
        for (let position = 0; position < total; position++) {
            if (!inCulture(request, position) || !narrowed(position))
                continue;
            const filter = filterAt(position), rule = ruleAt(position), severity = severityAt(position);
            if (record(filter, severity, rule, 1, eligibleAt(position) ? 1 : 0))
                matchedBySeverity[severity].push(position);
        }
        const runs = {
            blocking: [],
            normal: [],
            low: []
        };
        for (const severity of CheckSeverity.literals)
            if (matchedBySeverity[severity].length)
                runs[severity].push({
                    positions: Uint32Array.from(matchedBySeverity[severity]),
                    base: 0
                });
        const counts = decodeQualityCounts(Object.fromEntries([
            ...BuiltInQualityFilter.literals.map((filter) => [
                filter,
                filter === "all" ? cultureCount : (typeCounts.get(filter) ?? 0)
            ]),
            ...customFilters.map(({ filter }) => [filter, typeCounts.get(filter) ?? 0])
        ]));
        return {
            key: selectionKey(request),
            positions: CheckSeverity.literals.map((severity) => runs[severity]),
            counts,
            customFilters,
            severityCounts,
            limits: [...list.limits(request.culture)],
            unsupportedRuleCultures: metadata.unsupportedRuleCultures,
            total: matchedCount,
            suggestedFixCount,
            rules: [...(source?.rules ?? []).map((rule) => rule.ruleId), ...metadata.rules].map((ruleId) => ({ ruleId, findingCount: ruleCounts.get(ruleId) ?? 0 }))
        };
    };
    let selection;
    const search = function* (request) {
        if (selection?.key !== selectionKey(request))
            selection = select(request, yield* narrowedBy(request));
        const { key: _key, positions, ...page } = selection;
        const offset = request.offset ?? 0;
        const selected = [];
        let skipped = 0;
        const lowerBound = (values, value) => {
            let low = 0, high = values.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (values[middle] < value)
                    low = middle + 1;
                else
                    high = middle;
            }
            return low;
        };
        // Select by rank across sorted fact groups, without merging or walking their full contents.
        for (const runs of positions) {
            const count = runs.reduce((sum, run) => sum + run.positions.length, 0);
            if (skipped + count <= offset) {
                skipped += count;
                continue;
            }
            const start = Math.max(0, offset - skipped);
            let low = 0, high = total;
            while (low < high) {
                const middle = Math.floor((low + high) / 2);
                const through = runs.reduce((sum, run) => sum + lowerBound(run.positions, middle + 1 - run.base), 0);
                if (through <= start)
                    low = middle + 1;
                else
                    high = middle;
            }
            const candidates = [];
            for (const run of runs) {
                const from = lowerBound(run.positions, low - run.base);
                for (const position of run.positions.subarray(from, from + 50 - selected.length))
                    candidates.push(position + run.base);
            }
            candidates.sort((a, b) => a - b);
            selected.push(...candidates.slice(0, 50 - selected.length));
            skipped += count;
            if (selected.length === 50)
                break;
        }
        const { suggestedFixCount, rules, ...summary } = page;
        return {
            ...summary,
            findings: (yield* itemsAt(selected)).map((item) => item.summary),
            suggestedFixCount,
            rules,
            ...(offset + 50 < page.total ? { nextOffset: offset + 50 } : undefined)
        };
    };
    return {
        search,
        export: function* (request) {
            const { nextOffset: _offset, ...page } = yield* search(request);
            return {
                ...page,
                findings: yield* summariesAt(matched(request, yield* narrowedBy(request))),
                corpusCoverage: metadata.coverage,
                status: metadata.status,
                target: request.target,
                filter: request.filter,
                ...(request.culture ? { culture: request.culture } : undefined),
                ...narrowingOf(request)
            };
        },
        focus: function* (request) {
            const sourceFinding = pageSources.get(request.id) ??
                (request.id.startsWith("quality-finding:")
                    ? sourceFindings.find((finding) => textQualityFindingId(finding) === request.id)
                    : undefined);
            let item = sourceFinding ? sourceItem(sourceFinding) : undefined;
            if (!item) {
                const position = list.find(request.id, request.culture);
                item =
                    position === undefined || hidden(position)
                        ? undefined
                        : withSummary((yield [position])[0]);
            }
            if (!item)
                return { status: "not_found" };
            const { finding, line, summary } = item;
            if (!("culture" in finding)) {
                const offset = request.occurrenceOffset ?? 0;
                const previous = offset ? finding.affectedOccurrences[offset - 1]?.id : undefined;
                const focus = source &&
                    textQualityQuery({ ...source, findings: [finding] }).focus({
                        id: summary.id,
                        pageSize: 50,
                        ...(previous ? { occurrenceCursor: previous } : undefined)
                    });
                return focus
                    ? { status: "found", focus: { kind: "source", focus } }
                    : { status: "not_found" };
            }
            if (!line)
                return { status: "not_found" };
            const mark = line.cultures.find((mark) => mark.culture === finding.culture);
            const sourceText = findingSource(finding, lineFacts(line));
            const translation = mark ? localizationShippedTranslation(mark).value : null;
            const detail = localizationFocusPage(metadata.join, {
                ...line,
                cultures: line.cultures.filter((mark) => mark.culture === finding.culture)
            }, {
                target: request.target,
                selection: { kind: "line", id: line.id },
                locationOffset: request.occurrenceOffset ?? 0,
                poContextOffset: request.poContextOffset ?? 0
            });
            const change = eligibleLocalizationChange(finding);
            return {
                status: "found",
                focus: {
                    kind: "localization",
                    id: summary.id,
                    source: sourceText.slice(0, 4096),
                    translation: translation?.slice(0, 4096) ?? null,
                    translationOrigin: finding.translationOrigin,
                    sourceRanges: ranges(sourceText, finding, "source"),
                    translationRanges: ranges(translation ?? "", finding, "translation"),
                    truncated: sourceText.length > 4096 || (translation?.length ?? 0) > 4096,
                    ...(summary.sourceVariants
                        ? { sourceVariants: summary.sourceVariants }
                        : undefined),
                    problem: summary.problem,
                    recovery: finding.recovery,
                    check: summary.filter,
                    severity: summary.severity,
                    ruleId: finding.ruleId,
                    culture: finding.culture,
                    affectedOccurrences: finding.affectedOccurrences.slice(request.occurrenceOffset ?? 0, (request.occurrenceOffset ?? 0) + 50),
                    totalOccurrences: finding.affectedOccurrences.length,
                    ...((request.occurrenceOffset ?? 0) + 50 < finding.affectedOccurrences.length
                        ? { nextOccurrenceOffset: (request.occurrenceOffset ?? 0) + 50 }
                        : undefined),
                    translations: detail,
                    ...(line.origin.kind === "corpus" && line.origin.unitIds[0]
                        ? { textUnitId: line.origin.unitIds[0] }
                        : undefined),
                    ...(change ? { suggestedChange: change } : undefined)
                }
            };
        },
        changes: function* (request) {
            const changes = [];
            const seen = new Set();
            let remaining = 0, bytes = 0, read = 0;
            const eligible = matched(request, yield* narrowedBy(request), eligibleAt);
            // Only format-argument findings suggest changes: one per line and culture, and a line's
            // identity is unique, so changes past the first 100 are counted without reading lines.
            while (read < eligible.length && changes.length < 100) {
                const batch = yield* itemsAt(eligible.slice(read, read + 128));
                read += batch.length;
                for (const { finding } of batch) {
                    const change = eligibleLocalizationChange(finding);
                    if (!change)
                        continue;
                    const key = JSON.stringify([
                        change.target,
                        change.culture,
                        change.namespace,
                        change.key
                    ]);
                    if (seen.has(key))
                        continue;
                    seen.add(key);
                    const size = new TextEncoder().encode(JSON.stringify(change)).length;
                    if (changes.length === 100 || bytes + size > 1_000_000) {
                        remaining++;
                        continue;
                    }
                    changes.push(change);
                    bytes += size;
                }
            }
            remaining += eligible.length - read;
            // File authority stays in the host. A proposal records complete change identities, without filesystem paths.
            return {
                status: "ready",
                document: {
                    schemaVersion: 1,
                    provenance: { producer: "ue-shed.localization.checks", files: [] },
                    changes
                },
                remaining
            };
        }
    };
}
/**
 * Target progress report request with optional culture-page offset. The request scopes
 * presentation and does not change project or target evidence.
 */
export const WorkspaceReportRequest = Schema.Struct({
    target: LocalizationTargetName,
    offset: Offset
});
const Words = Schema.NullOr(Count);
/**
 * Per-culture progress row for a bounded host report. Unknown word/count evidence remains
 * explicit rather than being shown as confirmed translated work.
 */
export const WorkspaceReportRow = Schema.Struct({
    culture: CultureCode,
    translatedLines: Words,
    totalLines: Count,
    linesPercent: Schema.NullOr(Schema.Finite),
    wordsPercent: Schema.NullOr(Schema.Finite),
    wordsNeedingWork: Words,
    notSynced: Count,
    /** Present once the project has a review file for the target. */
    reviewedLines: Schema.optionalKey(Count),
    proofreadLines: Schema.optionalKey(Count),
    newWords: Schema.optionalKey(Words),
    changedWords: Schema.optionalKey(Words)
});
/**
 * Bounded progress rows plus corpus/gather coverage, unknown reasons and optional baseline
 * summary. Failed and missing evidence counts qualify the displayed completion totals.
 */
export const WorkspaceReportPage = Schema.Struct({
    target: LocalizationTargetName,
    rows: Schema.Array(WorkspaceReportRow).check(Schema.isMaxLength(50)),
    totalCultures: Count,
    nextOffset: Offset,
    coverage: TextCorpus.fields.coverage,
    gatherFilesRead: Count,
    /** Every evidence file that failed, including files the working copy does not have. */
    gatherFilesFailed: Count,
    /** The failed files that are absent from the working copy rather than unreadable. */
    gatherFilesMissing: Schema.optionalKey(Count),
    /** The folder Game Text looked in for the target's evidence files. */
    localizationFolder: Schema.optionalKey(Schema.String),
    /** Failed evidence files, missing or unreadable, with their paths and error codes. */
    gatherFileProblems: Schema.optionalKey(Schema.Array(LocalizationFileProblem).check(Schema.isMaxLength(50))),
    wordCountUnknown: Count,
    unknownReasons: LocalizationProgressCulture.fields.unknownReasons,
    baseline: Schema.optionalKey(Schema.Struct({
        target: LocalizationTargetName,
        createdAt: Schema.String,
        /** Lines since the baseline: new keys, removed keys, changed keys and changed source. */
        since: Schema.optionalKey(Schema.Struct({ added: Count, removed: Count, keyChanged: Count, changed: Count }))
    }))
});
const decodeUnknownReasons = Schema.decodeUnknownSync(WorkspaceReportPage.fields.unknownReasons);
/**
 * Progress report outcome with ready page, unavailable state or failure. Unavailable evidence
 * must not be rendered as a complete zero-line report.
 */
export const WorkspaceReportResult = Schema.Union([
    NotReady,
    Failure,
    Schema.Struct({ status: Schema.Literal("ready"), page: WorkspaceReportPage })
]);
/**
 * Target-scoped save-baseline, compare-baseline or CSV-export operation. The host owns
 * destination selection and writable-file policy.
 */
export const WorkspaceReportFileRequest = Schema.Struct({
    target: LocalizationTargetName,
    operation: Schema.Literals(["save_baseline", "compare_baseline", "export_csv"])
});
/**
 * Report-file operation outcome including cancellation, save confirmation or compared page.
 * Failed/unavailable operations retain guidance without claiming a file was persisted.
 */
export const WorkspaceReportFileResult = Schema.Union([
    NotReady,
    Failure,
    Schema.Struct({ status: Schema.Literal("cancelled") }),
    Schema.Struct({ status: Schema.Literal("saved"), message: Schema.String }),
    Schema.Struct({ status: Schema.Literal("compared"), page: WorkspaceReportPage })
]);
/**
 * Projects a progress report into native-culture-first bounded rows and aggregate evidence
 * totals. Optional baseline metadata is retained for comparison presentation.
 */
export function localizationReportPage(report, native, request, baseline) {
    const cultures = [...report.cultures].sort((a, b) => Number(b.culture === native) - Number(a.culture === native));
    const offset = request.offset ?? 0;
    const problems = localizationFileProblems(report.gatherEvidence);
    const folder = localizationEvidenceFolder(report.gatherEvidence);
    const reasons = decodeUnknownReasons(Object.fromEntries(LocalizationUnknownReason.literals.map((reason) => [
        reason,
        cultures.reduce((sum, culture) => sum + culture.unknownReasons[reason], 0)
    ])));
    return {
        target: report.target,
        rows: cultures.slice(offset, offset + 50).map((culture) => ({
            culture: culture.culture,
            translatedLines: culture.upToDateArchive.lines,
            totalLines: culture.total.lines,
            linesPercent: culture.translatedPercent.lines,
            wordsPercent: culture.translatedPercent.words,
            wordsNeedingWork: culture.total.sourceWords !== null && culture.upToDateArchive.sourceWords !== null
                ? Math.max(0, culture.total.sourceWords - culture.upToDateArchive.sourceWords)
                : null,
            notSynced: culture.notSynced.lines,
            ...(culture.reviewed === "not_tracked" || culture.proofread === "not_tracked"
                ? undefined
                : {
                    reviewedLines: culture.reviewed.lines,
                    proofreadLines: culture.proofread.lines
                }),
            ...(culture.baselineDelta
                ? {
                    newWords: culture.baselineDelta.addedCounts.sourceWords,
                    changedWords: culture.baselineDelta.changedCounts.sourceWords
                }
                : undefined)
        })),
        totalCultures: cultures.length,
        coverage: report.coverage,
        gatherFilesRead: report.gatherEvidence.filter((file) => file.status === "read").length,
        gatherFilesFailed: problems.length,
        gatherFilesMissing: problems.filter((problem) => problem.state === "missing").length,
        ...(folder === undefined ? undefined : { localizationFolder: folder }),
        ...(problems.length > 0 ? { gatherFileProblems: problems.slice(0, 50) } : undefined),
        wordCountUnknown: report.wordCountDiagnostics.length,
        unknownReasons: reasons,
        ...(offset + 50 < cultures.length ? { nextOffset: offset + 50 } : undefined),
        ...(baseline
            ? {
                baseline: {
                    target: baseline.target,
                    createdAt: baseline.provenance.createdAt,
                    ...(report.cultures[0]?.baselineDelta
                        ? {
                            since: {
                                added: report.cultures[0].baselineDelta.addedCounts.lines,
                                removed: report.cultures[0].baselineDelta.removedCounts.lines,
                                keyChanged: report.cultures[0].baselineDelta.keyChangedCounts.lines,
                                changed: report.cultures[0].baselineDelta.changedCounts.lines
                            }
                        }
                        : undefined)
                }
            }
            : undefined)
    };
}
/**
 * Formats the retained localization progress report as spreadsheet-safe CSV. Explicit unknown
 * metrics remain distinguishable from numeric zero.
 */
export function localizationReportCsv(pages, baseline = false) {
    const headers = [
        "Culture",
        "Lines translated",
        "Total lines",
        "% translated by lines",
        "% translated by words",
        "Words needing work",
        "Not synced"
    ];
    const reviewed = pages.some((row) => row.reviewedLines !== undefined);
    if (reviewed)
        headers.push("Lines reviewed", "Lines proofread");
    if (baseline)
        headers.push("New words", "Changed words");
    return spreadsheetCsv([
        headers,
        ...pages.map((row) => {
            const cells = [
                row.culture,
                row.translatedLines ?? "Unknown",
                row.totalLines,
                row.linesPercent ?? "Unknown",
                row.wordsPercent ?? "Unknown",
                row.wordsNeedingWork ?? "Unknown",
                row.notSynced
            ];
            if (reviewed)
                cells.push(row.reviewedLines ?? 0, row.proofreadLines ?? 0);
            if (baseline)
                cells.push(row.newWords ?? "Unknown", row.changedWords ?? "Unknown");
            return cells;
        })
    ]);
}
/** A spreadsheet of the same finding summaries the quality list displays. */
export function workspaceQualityCsv(report) {
    const customLabels = new Map(report.customFilters.map(({ filter, label }) => [filter, label]));
    return spreadsheetCsv([
        [
            "Target",
            "Culture",
            "Severity",
            "Check",
            "Source",
            "Problem",
            "Context",
            "Finding ID",
            "Scan status"
        ],
        ...report.findings.map((finding) => [
            report.target,
            finding.culture ?? "Source",
            finding.severity,
            workspaceQualityLabel(finding.filter, customLabels),
            finding.source,
            finding.problem,
            finding.context,
            finding.id,
            report.status
        ])
    ]);
}
/**
 * The workspace of a quality read. Queried quality lists the rule file's source findings itself,
 * so `source` is read only by in-memory quality.
 */
export function localizationQualityWorkspaceOf(source, quality) {
    return quality.withSource ? quality.withSource(source) : quality.workspace;
}
/** The workspace filter a rule's findings show under. */
function ruleFilter(rule) {
    if (rule.kind === "localization_character_budget")
        return "character_budget";
    if (rule.kind === "localization_terminology")
        return "terminology";
    if (rule.kind === "custom")
        return customQualityFilter(rule.ruleId);
    // SAFETY: built-in and source rule kinds are the workspace's filter names.
    // Verified by: findings-query.test.ts lists every rule's findings under its filter.
    return rule.kind;
}
/**
 * The Quality workspace over a findings layer. Pages list blocking findings, then normal, then
 * low; within a severity, source findings first, then line findings in report order, as the
 * scan listed them. `acceptance` names the review the workspace applies.
 */
export function queriedLocalizationQualityWorkspace(options) {
    const { findings, key, rules, acceptance, metadata } = options;
    const filterOfRule = new Map(rules.map((rule) => [rule.ruleId, ruleFilter(rule)]));
    const customFilters = (metadata.customChecks ?? []).map(({ ruleId, label }) => ({
        filter: customQualityFilter(ruleId),
        label
    }));
    const query = (request, fields) => findings.findingsQuery({
        key,
        view: "workspace",
        order: "severity",
        ...(request.culture ? { culture: request.culture } : undefined),
        ...(acceptance ? { acceptance } : undefined),
        ...(request.filter === "all"
            ? undefined
            : {
                rules: [...filterOfRule]
                    .filter(([, filter]) => filter === request.filter)
                    .map(([ruleId]) => ruleId)
            }),
        ...(request.query?.trim() ? { lines: { text: request.query } } : undefined),
        ...(request.severities ? { severities: request.severities } : undefined),
        ...(request.fixable !== undefined ? { fixable: request.fixable } : undefined),
        ...fields
    });
    const summaryOf = (finding) => {
        if (!("culture" in finding))
            return qualitySummary(finding, undefined, finding.sourceKey ?? undefined);
        const facts = {
            manifestSource: finding.manifestSource ?? undefined,
            manifestPath: finding.manifestLocations[0],
            source: finding.lineSource,
            key: finding.identity?.key
        };
        return withoutSourceReportedSummary(finding, qualitySummary(finding, facts), facts);
    };
    const search = Effect.fn("GameText.quality.search")(function* (request) {
        const offset = request.offset ?? 0;
        const page = yield* query(request, { offset, limit: 50, counts: true });
        const counts = page.counts;
        const typeCounts = new Map();
        const ruleCounts = new Map();
        for (const { ruleId, count } of counts.rules) {
            ruleCounts.set(ruleId, count);
            const filter = filterOfRule.get(ruleId);
            if (filter)
                typeCounts.set(filter, (typeCounts.get(filter) ?? 0) + count);
        }
        const result = {
            findings: page.findings.map(summaryOf),
            total: page.total,
            counts: yield* decodeCounts(Object.fromEntries([
                ...BuiltInQualityFilter.literals.map((filter) => [
                    filter,
                    filter === "all" ? counts.all : (typeCounts.get(filter) ?? 0)
                ]),
                ...customFilters.map(({ filter }) => [filter, typeCounts.get(filter) ?? 0])
            ])).pipe(Effect.orDie),
            customFilters,
            severityCounts: counts.severities,
            // SAFETY: diagnostic codes are the engine's DIAGNOSTIC_CODES, the host's code union.
            // Verified by: localization-checks.test.ts reads native syntax_limit diagnostics.
            limits: counts.limits,
            unsupportedRuleCultures: metadata.unsupportedRuleCultures,
            suggestedFixCount: counts.fixable,
            rules: metadata.rules.map((ruleId) => ({
                ruleId,
                findingCount: ruleCounts.get(ruleId) ?? 0
            })),
            ...(offset + 50 < page.total ? { nextOffset: offset + 50 } : undefined)
        };
        return result;
    });
    return {
        search,
        export: Effect.fn("GameText.quality.export")(function* (request) {
            const { nextOffset: _offset, ...page } = yield* search({ ...request, offset: 0 });
            const all = [];
            for (let offset = 0; offset === 0 || offset < page.total; offset += 5000) {
                const next = yield* query(request, { offset, limit: 5000 });
                all.push(...next.findings.map(summaryOf));
                if (next.findings.length < 5000)
                    break;
            }
            return {
                ...page,
                findings: all,
                corpusCoverage: metadata.coverage,
                status: metadata.status,
                target: request.target,
                filter: request.filter,
                ...(request.culture ? { culture: request.culture } : undefined),
                ...narrowingOf(request)
            };
        }),
        focus: Effect.fn("GameText.quality.focus")(function* (request) {
            const page = yield* query({ ...(request.culture ? { culture: request.culture } : undefined), filter: "all" }, { id: request.id, limit: 1 });
            const finding = page.findings[0];
            if (!finding)
                return { status: "not_found" };
            const summary = summaryOf(finding);
            if (!("culture" in finding)) {
                const offset = request.occurrenceOffset ?? 0;
                const previous = offset ? finding.affectedOccurrences[offset - 1]?.id : undefined;
                return {
                    status: "found",
                    focus: {
                        kind: "source",
                        focus: textQualityFindingFocus(finding, {
                            id: summary.id,
                            pageSize: 50,
                            ...(previous ? { occurrenceCursor: previous } : undefined)
                        })
                    }
                };
            }
            const detail = yield* options.detail({
                target: request.target,
                culture: finding.culture,
                selection: { kind: "line", id: finding.lineId },
                locationOffset: request.occurrenceOffset ?? 0,
                poContextOffset: request.poContextOffset ?? 0
            });
            if (!detail)
                return { status: "not_found" };
            // The focus shows the finding's culture alone, as the line's other cultures are not
            // what it is about.
            const translations = detail.translations.filter((translation) => translation.culture === finding.culture);
            const { problems: _problems, scopeSummary: _summary, nextCultureOffset: _next, ...rest } = detail;
            const scope = translations[0] && localizationScopeSummary(translations[0].state, request.target);
            const translationsPage = {
                ...rest,
                translations,
                totalCultures: translations.length,
                ...(scope ? { scopeSummary: scope } : undefined)
            };
            const facts = {
                manifestSource: finding.manifestSource ?? undefined,
                manifestPath: finding.manifestLocations[0],
                source: finding.lineSource,
                key: finding.identity?.key
            };
            const sourceText = findingSource(finding, facts);
            const translation = finding.shippedTranslation;
            const change = eligibleLocalizationChange(finding);
            const offset = request.occurrenceOffset ?? 0;
            return {
                status: "found",
                focus: {
                    kind: "localization",
                    id: summary.id,
                    source: sourceText.slice(0, 4096),
                    translation: translation?.slice(0, 4096) ?? null,
                    translationOrigin: finding.translationOrigin,
                    sourceRanges: ranges(sourceText, finding, "source"),
                    translationRanges: ranges(translation ?? "", finding, "translation"),
                    truncated: sourceText.length > 4096 || (translation?.length ?? 0) > 4096,
                    ...(summary.sourceVariants
                        ? { sourceVariants: summary.sourceVariants }
                        : undefined),
                    problem: summary.problem,
                    recovery: finding.recovery,
                    check: summary.filter,
                    severity: summary.severity,
                    ruleId: finding.ruleId,
                    culture: finding.culture,
                    affectedOccurrences: finding.affectedOccurrences.slice(offset, offset + 50),
                    totalOccurrences: finding.affectedOccurrences.length,
                    ...(offset + 50 < finding.affectedOccurrences.length
                        ? { nextOccurrenceOffset: offset + 50 }
                        : undefined),
                    translations: translationsPage,
                    ...(detail.origin.kind === "corpus" && detail.origin.unitIds[0]
                        ? { textUnitId: detail.origin.unitIds[0] }
                        : undefined),
                    ...(change ? { suggestedChange: change } : undefined)
                }
            };
        }),
        changes: Effect.fn("GameText.quality.changes")(function* (request) {
            const changes = [];
            const seen = new Set();
            let remaining = 0, bytes = 0, read = 0, total = 0;
            // Only format-argument findings suggest changes: one per line and culture, and a line's
            // identity is unique, so changes past the first 100 are counted without reading them.
            // Findings without a suggested fix offer none, so that filter copies nothing.
            if (request.fixable !== false)
                do {
                    const page = yield* query(request, { fixable: true, offset: read, limit: 128 });
                    total = page.total;
                    read += page.findings.length;
                    for (const finding of page.findings) {
                        const change = eligibleLocalizationChange(finding);
                        if (!change)
                            continue;
                        const id = JSON.stringify([
                            change.target,
                            change.culture,
                            change.namespace,
                            change.key
                        ]);
                        if (seen.has(id))
                            continue;
                        seen.add(id);
                        const size = new TextEncoder().encode(JSON.stringify(change)).length;
                        if (changes.length === 100 || bytes + size > 1_000_000) {
                            remaining++;
                            continue;
                        }
                        changes.push(change);
                        bytes += size;
                    }
                    if (page.findings.length === 0)
                        break;
                } while (read < total && changes.length < 100);
            remaining += total - read;
            return {
                status: "ready",
                document: {
                    schemaVersion: 1,
                    provenance: { producer: "ue-shed.localization.checks", files: [] },
                    changes
                },
                remaining
            };
        })
    };
}
