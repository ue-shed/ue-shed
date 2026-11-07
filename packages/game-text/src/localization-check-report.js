import { Effect, Schema } from "effect";
import { enabledLocalizationChecks } from "./localization-checks.js";
import { localizationRuleId } from "./localization-check-catalogue.js";
import { localizationEvidenceFileStatuses } from "./localization-status.js";
import { localizationPolicyRules } from "./localization-policy.js";
import { customRulesOf, localizationRulesOf } from "./game-text-rules.js";
import { effectiveRuleDocument } from "./rules/effective.js";
import { LocalizationQualityReport } from "./localization-quality-schema.js";
import { acceptReview, checkCompleteRules } from "./native-findings.js";
const LocalizationQualityReportJson = Schema.fromJsonString(LocalizationQualityReport);
const decodeLocalizationQualityReportJson = Schema.decodeEffect(LocalizationQualityReportJson);
/** Findings one engine read returns. */
const PAGE = 5000;
/**
 * Writes the report a member at a time, as `JSON.stringify(report, null, "\t")` and a line
 * break would: each `checkDiagnostics` element is encoded on its own, and the engine writes the
 * findings' elements. JSON strings hold no line breaks, so a nested line is indented by
 * prefixing its line breaks.
 */
const writeReport = Effect.fn("GameText.writeLocalizationCheckReport")(function* (report, write, findings) {
    let chunk = "";
    const flush = Effect.suspend(() => {
        const text = chunk;
        chunk = "";
        return text === "" ? Effect.void : write(text);
    });
    const append = (text) => {
        chunk += text;
        return chunk.length >= 1 << 20 ? flush : Effect.void;
    };
    let separator = "{";
    for (const [key, value] of Object.entries(report)) {
        yield* append(`${separator}\n\t${JSON.stringify(key)}: `);
        separator = ",";
        if (key === "findings") {
            yield* append("[");
            yield* flush;
            const decoder = new TextDecoder();
            const page = yield* findings((bytes) => write(decoder.decode(bytes, { stream: true })));
            yield* append(`${decoder.decode()}${page.sink?.rows ? "\n\t]" : "]"}`);
        }
        else if (key === "checkDiagnostics" && Array.isArray(value) && value.length > 0) {
            yield* append("[");
            for (const [at, item] of value.entries())
                yield* append(`${at ? "," : ""}\n\t\t${JSON.stringify(item, null, "\t").replaceAll("\n", "\n\t\t")}`);
            yield* append("\n\t]");
        }
        else
            yield* append(JSON.stringify(value, null, "\t").replaceAll("\n", "\n\t"));
    }
    yield* append("\n}\n");
    yield* flush;
});
/**
 * The CLI report over the engine's findings, group checks included, prepared to write: findings
 * in report order with the review's acceptance applied, check diagnostics, and the proposals,
 * collected before acceptance applies. The engine orders, filters, counts and writes the
 * findings; nothing here holds the join or the findings.
 */
export const prepareLocalizationCheck = Effect.fn("GameText.prepareLocalizationCheck")(function* (join, corpus, evidence, native, options = {}, document) {
    const enabled = enabledLocalizationChecks(join, evidence, options, document);
    yield* checkCompleteRules(native, document);
    const evaluated = yield* native.findingsEvaluate(effectiveRuleDocument(document, options));
    const acceptance = yield* acceptReview(native, evaluated.key, options.review);
    const read = (fields) => native.findingsQuery({
        key: evaluated.key,
        view: "report",
        ...(options.culture ? { culture: options.culture } : undefined),
        ...fields
    });
    // The first diagnostics page counts the findings the report lists.
    const diagnostics = [];
    let counts;
    for (let offset = 0;; offset += PAGE) {
        const page = yield* read({
            order: "report",
            limit: 0,
            diagnostics: { offset, limit: PAGE },
            ...(offset === 0
                ? { counts: true, ...(acceptance ? { acceptance } : undefined) }
                : undefined)
        });
        counts ??= page.counts;
        // SAFETY: diagnostic codes are the engine's DIAGNOSTIC_CODES, the host's code union.
        // Verified by: localization-checks.test.ts reads native syntax_limit diagnostics.
        diagnostics.push(...page.diagnostics.rows);
        if (page.diagnostics.rows.length < PAGE)
            break;
    }
    // CLI proposals deliberately include accepted findings; workspace proposals are collected later.
    const changes = [];
    for (let offset = 0;; offset += PAGE) {
        const page = yield* read({
            order: "line",
            rules: [localizationRuleId("format_argument_renamed")],
            change: true,
            offset,
            limit: PAGE
        });
        for (const finding of page.findings)
            if ("suggestedChange" in finding && finding.suggestedChange)
                changes.push(finding.suggestedChange);
        if (page.findings.length < PAGE)
            break;
    }
    const ruleCounts = new Map((counts?.rules ?? []).map(({ ruleId, count }) => [ruleId, count]));
    const policyRules = document
        ? localizationPolicyRules(join.cultures, document)
        : { rules: [], diagnostics: [] };
    const customChecks = customRulesOf(document);
    const files = localizationEvidenceFileStatuses(evidence);
    const report = LocalizationQualityReport.make({
        schemaVersion: 1,
        ruleDocumentVersion: 1,
        status: corpus.status,
        coverage: corpus.coverage,
        diagnostics: corpus.diagnostics,
        diagnosticCount: corpus.diagnosticCount,
        diagnosticCounts: corpus.diagnosticCounts,
        diagnosticsOmitted: corpus.diagnosticsOmitted,
        target: join.target,
        gatherEvidence: files,
        findings: [],
        checkDiagnostics: diagnostics,
        roles: [],
        rules: [
            ...localizationRulesOf(document).map(({ id }) => id),
            ...enabled.map(localizationRuleId),
            ...customChecks.map(({ id }) => id)
        ].map((ruleId) => ({ ruleId, findingCount: ruleCounts.get(ruleId) ?? 0 })),
        changes: {
            schemaVersion: 1,
            provenance: {
                producer: "ue-shed.localization.checks",
                files: files.flatMap((file) => (file.provenance ? [file.provenance] : []))
            },
            changes
        },
        ...(document ? { ruleDiagnostics: policyRules.diagnostics } : undefined),
        ...(options.review ? { acceptedFindings: counts?.accepted ?? 0 } : undefined),
        ...(customChecks.length
            ? { customChecks: customChecks.map(({ id, label }) => ({ ruleId: id, label })) }
            : undefined)
    });
    return {
        findings: counts?.total ?? 0,
        changes: report.changes,
        write: (write) => writeReport(report, write, (text) => native.findingsWrite({
            key: evaluated.key,
            view: "report",
            ...(options.culture ? { culture: options.culture } : undefined),
            order: "report",
            ...(acceptance ? { acceptance } : undefined)
        }, text))
    };
});
/** The CLI report as a value, read back from the text `prepareLocalizationCheck` writes. */
export const indexedLocalizationCheckReport = Effect.fn("GameText.localizationCheckReport")(function* (...input) {
    const prepared = yield* prepareLocalizationCheck(...input);
    const pieces = [];
    yield* prepared.write((text) => Effect.sync(() => void pieces.push(text)));
    return yield* decodeLocalizationQualityReportJson(pieces.join("")).pipe(Effect.orDie);
});
