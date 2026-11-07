import { Effect, Schema } from "effect";
import { materializeQualityRead } from "./quality-hydration.js";
import { TextQualityAffectedOccurrence, TextQualityRoleSummary, TextQualityRuleSummary } from "./quality-schema.js";
import { GameTextRuleDocument } from "./game-text-rules.js";
import { textCountLabel } from "./csv.js";
import { TextCorpus, TextLocation, TextOccurrenceId, TextUnitId } from "./schema.js";
import { gameTextResponseParser } from "./response-parser.js";
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));
/**
 * Opaque evidence-based source-quality finding identifier. It survives unrelated finding
 * reordering; changing relevant evidence produces a different identity.
 */
export const TextQualityFindingId = Schema.String.pipe(Schema.brand("TextQualityFindingId"));
/**
 * Brands an already constructed finding ID. Use textQualityFindingId to derive the canonical
 * identity from finding evidence.
 */
export const makeTextQualityFindingId = TextQualityFindingId.make;
/**
 * Source quality finding categories supported by the focused quality query. Localization
 * built-in/custom categories use their separate report contracts.
 */
export const TextQualityFindingKind = Schema.Literals(["character_budget", "terminology"]);
/**
 * All source findings or a single supported source finding kind. The filter scopes
 * search/export without changing authored rule evaluation.
 */
export const TextQualityFilter = Schema.Literals(["all", "character_budget", "terminology"]);
/**
 * Retained source-quality totals with coverage, role/rule counts and policy document version.
 * Findings themselves are hydrated by bounded search/focus or explicit export.
 */
export const TextQualityQuerySummary = Schema.Struct({
    characterBudgetCount: Count,
    coverage: TextCorpus.fields.coverage,
    diagnosticCount: Count,
    findingCount: Count,
    roles: Schema.Array(TextQualityRoleSummary),
    rules: Schema.Array(TextQualityRuleSummary),
    ruleDocumentVersion: Schema.Literal(1),
    schemaVersion: Schema.Literal(1),
    status: TextCorpus.fields.status,
    terminologyCount: Count
});
const decodeRoleSummaries = Schema.decodeEffect(TextQualityQuerySummary.fields.roles);
const decodeRuleSummaries = Schema.decodeEffect(TextQualityQuerySummary.fields.rules);
/**
 * Whether the host keeps a standalone rules file it can save these rules to. Hosts report only
 * this fact; the file's path never crosses the result.
 */
export const TextQualityRuleFile = Schema.Literals(["attached", "none"]);
/**
 * Quality policy load/preparation outcome. Completed includes the document and summary;
 * unavailable, cancelled and failed states remain distinct.
 */
export const TextQualityQueryRunResult = Schema.Union([
    Schema.Struct({
        document: GameTextRuleDocument,
        status: Schema.Literal("completed"),
        summary: TextQualityQuerySummary,
        ruleFile: Schema.optionalKey(TextQualityRuleFile)
    }),
    Schema.Struct({ status: Schema.Literal("cancelled") }),
    Schema.Struct({ status: Schema.Literal("not_ready") }),
    Schema.Struct({
        status: Schema.Literal("failed"),
        error: Schema.Struct({
            code: Schema.Literals([
                "invalid_rules",
                "read_failed",
                "contract_failure",
                "already_exists",
                "write_failed"
            ]),
            message: Schema.String,
            recovery: Schema.String,
            retrySafe: Schema.Boolean
        })
    })
]);
/**
 * Validates a host quality-load response while preserving failed/cancelled/unavailable outcomes
 * as domain values. Invalid response contracts fail with typed guidance.
 */
export const parseTextQualityQueryRunResult = gameTextResponseParser(TextQualityQueryRunResult, "quality rule load result");
/**
 * Policy-save outcome with updated document/summary only on completion. Validation and write
 * failures remain explicit so hosts do not display an unsaved policy as persisted.
 */
export const TextQualityRuleUpdateResult = Schema.Union([
    Schema.Struct({
        document: GameTextRuleDocument,
        status: Schema.Literal("completed"),
        summary: TextQualityQuerySummary,
        ruleFile: Schema.optionalKey(TextQualityRuleFile)
    }),
    Schema.Struct({ status: Schema.Literal("not_ready") }),
    Schema.Struct({
        status: Schema.Literal("failed"),
        error: Schema.Struct({
            code: Schema.Literals(["invalid_rules", "write_failed", "contract_failure"]),
            message: Schema.String,
            recovery: Schema.String,
            retrySafe: Schema.Boolean
        })
    })
]);
/**
 * Validates a host policy-save response before replacing displayed policy state. A valid failed
 * result remains failure evidence rather than a decoder failure.
 */
export const parseTextQualityRuleUpdateResult = gameTextResponseParser(TextQualityRuleUpdateResult, "quality rule update result");
/**
 * Bounded finding preview with excerpts, labels and occurrence count. Use focus for complete
 * evidence and paged affected places rather than parsing the display labels.
 */
export const TextQualityFindingSummary = Schema.Struct({
    actual: Schema.String.check(Schema.isMaxLength(512)),
    expectation: Schema.String.check(Schema.isMaxLength(512)),
    id: TextQualityFindingId,
    kind: TextQualityFindingKind,
    location: Schema.optional(TextLocation),
    occurrenceCount: Count,
    recovery: Schema.String.check(Schema.isMaxLength(2048)),
    role: Schema.String,
    ruleId: Schema.String,
    sourceExcerpt: Schema.String.check(Schema.isMaxLength(512)),
    textUnitId: TextUnitId
});
/**
 * Source-quality search scope, optional evidence cursor and bounded page size. The cursor
 * belongs to the retained report that issued it.
 */
export const TextQualitySearchRequest = Schema.Struct({
    cursor: Schema.optional(TextQualityFindingId),
    filter: TextQualityFilter,
    pageSize: PageSize
});
/**
 * Bounded source finding page with whole-filter total and continuation cursor. Finding excerpts
 * are presentation summaries, not the canonical evidence used for identity.
 */
export const TextQualitySearchPage = Schema.Struct({
    findings: Schema.Array(TextQualityFindingSummary).check(Schema.isMaxLength(50)),
    nextCursor: Schema.optional(TextQualityFindingId),
    total: Count
});
/**
 * Ready quality search page or explicit not-ready state. An unavailable quality query is not
 * equivalent to zero findings.
 */
export const TextQualitySearchResult = Schema.Union([
    Schema.Struct({ status: Schema.Literal("ready"), page: TextQualitySearchPage }),
    Schema.Struct({ status: Schema.Literal("not_ready") })
]);
/**
 * Validates a host's bounded quality-search page or not-ready response. Contract mismatches
 * retain response guidance instead of becoming zero matches.
 */
export const parseTextQualitySearchResult = gameTextResponseParser(TextQualitySearchResult, "quality search result");
/**
 * Evidence finding ID and bounded occurrence page request. occurrenceCursor pages saved places
 * within that finding.
 */
export const TextQualityFocusRequest = Schema.Struct({
    id: TextQualityFindingId,
    occurrenceCursor: Schema.optional(TextOccurrenceId),
    pageSize: PageSize
});
const FocusBase = {
    affectedOccurrences: Schema.Array(TextQualityAffectedOccurrence).check(Schema.isMaxLength(50)),
    id: TextQualityFindingId,
    nextOccurrenceCursor: Schema.optional(TextOccurrenceId),
    recovery: Schema.String,
    role: Schema.String,
    ruleId: Schema.String,
    sourceExcerpt: Schema.String.check(Schema.isMaxLength(4096)),
    sourceOffset: Count,
    sourceTruncated: Schema.Boolean,
    textUnitId: TextUnitId,
    totalOccurrences: Count
};
/**
 * Focused source finding with structured actual/expected evidence and bounded saved places.
 * sourceOffset and sourceTruncated locate excerpts within the original source.
 */
export const TextQualityFocus = Schema.Union([
    Schema.Struct({
        ...FocusBase,
        actual: Schema.Struct({ characterCount: Count, kind: Schema.Literal("character_count") }),
        expectation: Schema.Struct({
            kind: Schema.Literal("maximum_characters"),
            maximumCharacters: Schema.Int.check(Schema.isGreaterThan(0))
        }),
        kind: Schema.Literal("character_budget")
    }),
    Schema.Struct({
        ...FocusBase,
        actual: Schema.Struct({
            end: Count,
            kind: Schema.Literal("terminology_match"),
            start: Count,
            term: Schema.String
        }),
        expectation: Schema.Union([
            Schema.Struct({ kind: Schema.Literal("forbidden_term"), term: Schema.String }),
            Schema.Struct({
                discouragedTerm: Schema.String,
                kind: Schema.Literal("preferred_term"),
                preferredTerm: Schema.String
            })
        ]),
        kind: Schema.Literal("terminology")
    })
]);
/**
 * Focus result distinguishing found evidence, unknown ID and unavailable quality state. A
 * missing ID can follow relevant source/policy changes.
 */
export const TextQualityFocusResult = Schema.Union([
    Schema.Struct({ status: Schema.Literal("found"), focus: TextQualityFocus }),
    Schema.Struct({ status: Schema.Literal("not_found") }),
    Schema.Struct({ status: Schema.Literal("not_ready") })
]);
/**
 * Validates a host quality-focus response, including bounded occurrences and structured finding
 * evidence. Well-formed not-found and not-ready outcomes remain values.
 */
export const parseTextQualityFocusResult = gameTextResponseParser(TextQualityFocusResult, "quality finding focus result");
function excerpt(source, maximum) {
    return source.length <= maximum ? source : `${source.slice(0, maximum - 1)}…`;
}
function actualLabel(finding) {
    return finding.kind === "character_budget"
        ? textCountLabel(finding.actual.characterCount, "character")
        : `“${finding.actual.term}” at ${finding.actual.start}–${finding.actual.end}`;
}
function expectationLabel(finding) {
    if (finding.kind === "character_budget") {
        return `Maximum ${textCountLabel(finding.expectation.maximumCharacters, "character")}`;
    }
    return finding.expectation.kind === "forbidden_term"
        ? `Remove “${finding.expectation.term}”`
        : `Prefer “${finding.expectation.preferredTerm}”`;
}
function sourceOf(finding) {
    return finding.actual.source;
}
/** FNV-1a over UTF-16 code units, 64 bits held as two u32 halves. */
export function textQualityEvidenceHash(evidence) {
    let high = 0xcbf29ce4, low = 0x84222325;
    for (let index = 0; index < evidence.length; index++) {
        // Multiplying by 2^40 + 0x1b3 modulo 2^64: every partial product stays below 2^53.
        const mixed = (low ^ evidence.charCodeAt(index)) >>> 0;
        const product = mixed * 0x1b3;
        high = (high * 0x1b3 + Math.floor(product / 0x100000000) + ((mixed << 8) >>> 0)) >>> 0;
        low = product >>> 0;
    }
    return [high, low];
}
/** The finding ID of an evidence hash. */
export function textQualityFindingIdOf(high, low) {
    return makeTextQualityFindingId("quality-finding:" +
        (high === 0 ? low.toString(16) : high.toString(16) + low.toString(16).padStart(8, "0")));
}
/** The evidence hash a finding ID names, or undefined when no finding has this ID's form. */
export function textQualityFindingIdHash(id) {
    const match = /^quality-finding:([0-9a-f]{1,16})$/u.exec(id);
    if (!match)
        return undefined;
    const hex = match[1];
    const high = hex.length > 8 ? Number.parseInt(hex.slice(0, -8), 16) : 0, low = Number.parseInt(hex.slice(-8), 16);
    return textQualityFindingIdOf(high, low) === id ? [high, low] : undefined;
}
/** The finding's evidence hash: the two halves of its ID. */
export function textQualityFindingHash(finding) {
    return textQualityEvidenceHash(JSON.stringify([
        finding.ruleId,
        finding.role,
        finding.textUnitId,
        finding.kind,
        finding.actual,
        finding.expectation,
        finding.affectedOccurrences.map((occurrence) => occurrence.id).sort()
    ]));
}
/** Evidence-based IDs survive reordering and unrelated findings disappearing after a scan. */
export function textQualityFindingId(finding) {
    const [high, low] = textQualityFindingHash(finding);
    return textQualityFindingIdOf(high, low);
}
/** Findings hydrated per batch when an export reads them all. */
const EXPORT_BATCH = 2048;
function findingSummary(finding, id) {
    return {
        actual: excerpt(actualLabel(finding), 512),
        expectation: excerpt(expectationLabel(finding), 512),
        id,
        kind: finding.kind,
        ...(finding.affectedOccurrences[0]
            ? { location: finding.affectedOccurrences[0].location }
            : undefined),
        occurrenceCount: finding.affectedOccurrences.length,
        recovery: excerpt(finding.recovery, 2048),
        role: finding.role,
        ruleId: finding.ruleId,
        sourceExcerpt: excerpt(sourceOf(finding), 512),
        textUnitId: finding.textUnitId
    };
}
/** One source finding's focus page, as a query over its report gives it. */
export function textQualityFindingFocus(finding, request) {
    return findingFocus(finding, textQualityFindingId(finding), request);
}
function findingFocus(finding, id, request) {
    const cursorIndex = request.occurrenceCursor
        ? finding.affectedOccurrences.findIndex((occurrence) => occurrence.id === request.occurrenceCursor) + 1
        : 0;
    const start = Math.max(0, cursorIndex);
    const affectedOccurrences = finding.affectedOccurrences.slice(start, start + request.pageSize);
    const final = affectedOccurrences.at(-1)?.id;
    const source = sourceOf(finding);
    const sourceOffset = finding.kind === "terminology" && finding.actual.end > 4096
        ? Math.max(0, finding.actual.end - 3072)
        : 0;
    const base = {
        affectedOccurrences,
        id,
        recovery: finding.recovery,
        role: finding.role,
        ruleId: finding.ruleId,
        sourceExcerpt: excerpt(source.slice(sourceOffset), 4096),
        sourceOffset,
        sourceTruncated: source.length > 4096,
        textUnitId: finding.textUnitId,
        totalOccurrences: finding.affectedOccurrences.length,
        ...(final !== undefined &&
            start + affectedOccurrences.length < finding.affectedOccurrences.length
            ? { nextOccurrenceCursor: final }
            : undefined)
    };
    return finding.kind === "character_budget"
        ? {
            ...base,
            actual: {
                characterCount: finding.actual.characterCount,
                kind: finding.actual.kind
            },
            expectation: finding.expectation,
            kind: finding.kind
        }
        : {
            ...base,
            actual: {
                end: finding.actual.end,
                kind: finding.actual.kind,
                start: finding.actual.start,
                term: finding.actual.term
            },
            expectation: finding.expectation,
            kind: finding.kind
        };
}
/**
 * The presentation query over a report whose findings are a list. Counts read only kinds;
 * search, focus and export hydrate just the findings they return.
 */
function textQualityReads(report, list) {
    const matchedByFilter = new Map();
    const matched = (filter) => {
        let positions = matchedByFilter.get(filter);
        if (!positions) {
            const kept = [];
            for (let position = 0; position < list.length; position++)
                if (filter === "all" || list.kind(position) === filter)
                    kept.push(position);
            positions = Uint32Array.from(kept);
            matchedByFilter.set(filter, positions);
        }
        return positions;
    };
    let characterBudgetCount = 0;
    for (let position = 0; position < list.length; position++)
        if (list.kind(position) === "character_budget")
            characterBudgetCount++;
    const summary = {
        characterBudgetCount,
        coverage: report.coverage,
        diagnosticCount: report.diagnosticCount,
        findingCount: list.length,
        roles: report.roles,
        rules: report.rules,
        ruleDocumentVersion: report.ruleDocumentVersion,
        schemaVersion: 1,
        status: report.status,
        terminologyCount: list.length - characterBudgetCount
    };
    return {
        export: function* (filter) {
            const positions = Array.from(matched(filter));
            const findings = [];
            for (let start = 0; start < positions.length; start += EXPORT_BATCH)
                findings.push(...(yield positions.slice(start, start + EXPORT_BATCH)));
            return { ...report, findings };
        },
        summary: () => summary,
        search: function* (request) {
            const positions = matched(request.filter);
            // Equal findings share an ID; a cursor names the first of them.
            const cursor = request.cursor === undefined ? undefined : list.find(request.cursor);
            let start = 0;
            if (cursor !== undefined) {
                let low = 0, high = positions.length;
                while (low < high) {
                    const middle = (low + high) >>> 1;
                    if (positions[middle] < cursor)
                        low = middle + 1;
                    else
                        high = middle;
                }
                if (positions[low] === cursor)
                    start = low + 1;
            }
            const page = Array.from(positions.subarray(start, start + request.pageSize));
            const findings = yield page;
            const final = page.at(-1);
            return {
                findings: findings.map((finding, index) => findingSummary(finding, list.id(page[index]))),
                total: positions.length,
                ...(final !== undefined && start + page.length < positions.length
                    ? { nextCursor: list.id(final) }
                    : undefined)
            };
        },
        focus: function* (request) {
            const position = list.find(request.id);
            if (position === undefined)
                return undefined;
            return findingFocus((yield [position])[0], list.id(position), request);
        }
    };
}
/** Pure presentation over already materialized findings. */
export function textQualityQueryOf(report, list) {
    const reads = textQualityReads(report, list);
    return {
        summary: reads.summary,
        search: (request) => materializeQualityRead(reads.search(request), list.items.bind(list)),
        focus: (request) => materializeQualityRead(reads.focus(request), list.items.bind(list)),
        export: (filter) => materializeQualityRead(reads.export(filter), list.items.bind(list))
    };
}
/** The presentation query over a report whose findings are all in memory. */
export function textQualityQuery(report) {
    const { findings, ...rest } = report;
    const ids = findings.map(textQualityFindingId);
    const first = new Map();
    ids.forEach((id, position) => {
        if (!first.has(id))
            first.set(id, position);
    });
    return textQualityQueryOf(rest, {
        length: findings.length,
        kind: (position) => findings[position].kind,
        id: (position) => ids[position],
        find: (id) => first.get(id),
        items: (positions) => positions.map((position) => findings[position])
    });
}
/**
 * The source quality query over a findings layer: the layer's `unit_source` findings in the
 * source report's order, each read a findings query. Counts are read once, when it opens.
 */
export const queriedTextQualityQuery = Effect.fn("GameText.sourceQuality.open")(function* (options) {
    const { findings, evaluation, report } = options;
    const sourceRules = evaluation.rules.filter((rule) => rule.subject === "unit_source");
    const ids = (filter) => sourceRules
        .filter((rule) => filter === "all" || rule.kind === filter)
        .map((rule) => rule.ruleId);
    const query = (filter, fields) => findings.findingsQuery({
        key: evaluation.key,
        view: "workspace",
        order: "source",
        rules: ids(filter),
        ...fields
    });
    const counted = yield* query("all", { limit: 0, counts: true });
    const counts = new Map(counted.counts.rules.map(({ ruleId, count }) => [ruleId, count]));
    const rules = [...sourceRules]
        .sort((left, right) => left.ruleId.localeCompare(right.ruleId))
        .map((rule) => ({ findingCount: counts.get(rule.ruleId) ?? 0, ruleId: rule.ruleId }));
    const roles = [...evaluation.roles]
        .sort((left, right) => left.role.localeCompare(right.role))
        .map(({ role, matchedOccurrences, matchedTextUnits }) => ({
        matchedOccurrences,
        matchedTextUnits,
        role
    }));
    let characterBudgetCount = 0, findingCount = 0;
    for (const rule of sourceRules) {
        const count = counts.get(rule.ruleId) ?? 0;
        findingCount += count;
        if (rule.kind === "character_budget")
            characterBudgetCount += count;
    }
    const header = {
        ...report,
        roles: yield* decodeRoleSummaries(roles).pipe(Effect.orDie),
        rules: yield* decodeRuleSummaries(rules).pipe(Effect.orDie)
    };
    const summary = {
        characterBudgetCount,
        coverage: report.coverage,
        diagnosticCount: report.diagnosticCount,
        findingCount,
        roles: header.roles,
        rules: header.rules,
        ruleDocumentVersion: report.ruleDocumentVersion,
        schemaVersion: 1,
        status: report.status,
        terminologyCount: findingCount - characterBudgetCount
    };
    const idOf = (finding) => TextQualityFindingId.make(finding.id);
    const strip = ({ id: _id, sourceKey: _key, ...finding }) => finding;
    const sourceFindings = (page) => 
    // SAFETY: every rule this query names is a `unit_source` rule, and the engine returns
    // only the named rules' findings.
    // Verified by: source-quality-index.test.ts compares every page with the in-memory query.
    page.findings;
    return {
        findingsKey: evaluation.key,
        summary: () => summary,
        search: Effect.fn("GameText.sourceQuality.search")(function* (request) {
            // One past the page says whether another follows.
            const page = yield* query(request.filter, {
                ...(request.cursor ? { after: request.cursor } : undefined),
                limit: request.pageSize + 1
            });
            const found = sourceFindings(page);
            const shown = found.slice(0, request.pageSize);
            const final = shown.at(-1);
            return {
                findings: shown.map((finding) => findingSummary(strip(finding), idOf(finding))),
                total: page.total,
                ...(final !== undefined && found.length > request.pageSize
                    ? { nextCursor: idOf(final) }
                    : undefined)
            };
        }),
        focus: Effect.fn("GameText.sourceQuality.focus")(function* (request) {
            const page = yield* query("all", { id: request.id, limit: 1 });
            const finding = sourceFindings(page)[0];
            return finding && findingFocus(strip(finding), idOf(finding), request);
        }),
        export: Effect.fn("GameText.sourceQuality.export")(function* (filter) {
            const all = [];
            for (let offset = 0;; offset += 5000) {
                const page = yield* query(filter, { offset, limit: 5000 });
                all.push(...sourceFindings(page).map(strip));
                if (page.findings.length < 5000)
                    break;
            }
            return { ...header, findings: all };
        })
    };
});
