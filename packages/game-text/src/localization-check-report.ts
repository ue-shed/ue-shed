import { Effect } from "effect";
import type { LocalizationTargetEvidence } from "@ue-shed/localization";
import type { TextCorpusReportHeader } from "./corpus-summary.js";
import type { GameTextContract } from "@ue-shed/protocol";
import type { LocalizationChange } from "@ue-shed/localization/browser";
import { enabledLocalizationChecks } from "./localization-checks.js";
import { localizationRuleId } from "./localization-check-catalogue.js";
import { localizationEvidenceFileStatuses } from "./localization-status.js";
import { localizationPolicyRules } from "./localization-policy.js";
import { customRulesOf, localizationRulesOf } from "./game-text-rules.js";
import { effectiveRuleDocument } from "./rules/effective.js";
import {
	LocalizationQualityReport,
	type LocalizationCheckOptions,
	type LocalizationQualityFinding,
	type LocalizationPolicyFinding,
	type LocalizationCustomFinding,
	type LocalizationCheckDiagnostic
} from "./localization-quality-schema.js";
import { acceptReview, checkCompleteRules, type NativeFindings } from "./native-findings.js";
import type { GameTextRuleDocument } from "./game-text-rules.js";
import type { TextCorpusQuerySummary } from "./schema.js";
import type { LocalizationJoin } from "./localization-schema.js";

/** Keep the CLI report's member order as well as its finding identities. */
type ReportedFinding =
	| LocalizationQualityFinding
	| LocalizationPolicyFinding
	| LocalizationCustomFinding;
function reportedFinding(finding: ReportedFinding): ReportedFinding {
	const affectedOccurrences = finding.affectedOccurrences.map(
		({ id, location, packageFile }) => ({
			id,
			location:
				location.kind === "asset_property"
					? {
							kind: location.kind,
							objectPath: location.objectPath,
							classPath: location.classPath,
							propertyPath: location.propertyPath
						}
					: location.kind === "data_table_cell"
						? {
								kind: location.kind,
								objectPath: location.objectPath,
								row: location.row,
								propertyPath: location.propertyPath
							}
						: {
								kind: location.kind,
								objectPath: location.objectPath,
								entryKey: location.entryKey
							},
			packageFile
		})
	);
	const {
		lineId,
		target,
		culture,
		identity,
		ruleId,
		kind,
		actual,
		expectation,
		recovery,
		severity,
		manifestLocations,
		translationOrigin
	} = finding;
	if (kind === "custom")
		// SAFETY: this branch preserves the custom discriminant and its paired evidence.
		// Verified by: localization-checks-shape.test.ts and localization-quality-index.test.ts.
		return {
			lineId,
			target,
			culture,
			identity,
			ruleId,
			recovery,
			affectedOccurrences,
			manifestLocations,
			translationOrigin,
			severity,
			kind,
			check: finding.check,
			label: finding.label,
			subject: finding.subject,
			actual,
			expectation
		} as ReportedFinding;
	if (kind === "localization_character_budget" || kind === "localization_terminology")
		// SAFETY: the policy kind and its matching evidence come from the same input finding.
		// Verified by: localization-checks-shape.test.ts and localization-quality-index.test.ts.
		return {
			lineId,
			target,
			culture,
			identity,
			role: finding.role,
			ruleId,
			recovery,
			translationOrigin,
			severity,
			affectedOccurrences,
			manifestLocations,
			kind,
			actual,
			expectation
		} as ReportedFinding;
	// SAFETY: member reordering keeps the remaining discriminant and its matching evidence.
	// Verified by: localization-checks-shape.test.ts and localization-quality-index.test.ts.
	return {
		lineId,
		target,
		culture,
		identity,
		affectedOccurrences,
		manifestLocations,
		translationOrigin,
		...(finding.sourceVariants ? { sourceVariants: finding.sourceVariants } : undefined),
		ruleId,
		kind,
		actual,
		expectation,
		recovery,
		...(kind === "placeholder_text" && finding.unreportedMatches !== undefined
			? { unreportedMatches: finding.unreportedMatches }
			: undefined),
		...(kind === "format_argument_renamed" && finding.suggestedChange
			? { suggestedChange: finding.suggestedChange }
			: undefined),
		severity
	} as ReportedFinding;
}

/** The corpus facts a report shows: its status, coverage and diagnostics, never its units. */
type ReportCorpus = Pick<TextCorpusQuerySummary, "status"> & TextCorpusReportHeader;

/** Findings one engine read returns. */
const PAGE = 5000;

/**
 * The CLI report over the engine's findings, group checks included: findings in report order
 * with the review's acceptance applied, check diagnostics, and the proposals, collected before
 * acceptance applies. The engine orders, filters and counts; nothing here holds the join.
 */
export const indexedLocalizationCheckReport = Effect.fn("GameText.localizationCheckReport")(
	function* (
		join: Pick<LocalizationJoin, "target" | "cultures">,
		corpus: ReportCorpus,
		evidence: LocalizationTargetEvidence,
		native: NativeFindings,
		options: LocalizationCheckOptions = {},
		document?: GameTextRuleDocument
	) {
		const enabled = enabledLocalizationChecks(join, evidence, options, document);
		yield* checkCompleteRules(native, document);
		const evaluated = yield* native.findingsEvaluate(effectiveRuleDocument(document, options));
		const acceptance = yield* acceptReview(native, evaluated.key, options.review);
		const read = (fields: Omit<GameTextContract.FindingsQueryRequest, "key" | "view">) =>
			native.findingsQuery({
				key: evaluated.key,
				view: "report",
				...(options.culture ? { culture: options.culture } : undefined),
				...fields
			});
		const findings: ReportedFinding[] = [];
		let counts: GameTextContract.FindingCounts | undefined;
		for (let offset = 0; ; offset += PAGE) {
			const page = yield* read({
				order: "report",
				...(acceptance ? { acceptance } : undefined),
				offset,
				limit: PAGE,
				...(offset === 0 ? { counts: true } : undefined)
			});
			counts ??= page.counts;
			// SAFETY: the report view returns line findings only.
			// Verified by: localization-check-report tests compare the report with the scan's.
			findings.push(...(page.findings as readonly ReportedFinding[]).map(reportedFinding));
			if (page.findings.length < PAGE) break;
		}
		const diagnostics: LocalizationCheckDiagnostic[] = [];
		for (let offset = 0; ; offset += PAGE) {
			const page = yield* read({
				order: "line",
				limit: 0,
				diagnostics: { offset, limit: PAGE }
			});
			// SAFETY: diagnostic codes are the engine's DIAGNOSTIC_CODES, the host's code union.
			// Verified by: localization-checks.test.ts reads native syntax_limit diagnostics.
			diagnostics.push(...(page.diagnostics!.rows as readonly LocalizationCheckDiagnostic[]));
			if (page.diagnostics!.rows.length < PAGE) break;
		}
		// CLI proposals deliberately include accepted findings; workspace proposals are collected later.
		const changes: LocalizationChange[] = [];
		for (let offset = 0; ; offset += PAGE) {
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
			if (page.findings.length < PAGE) break;
		}
		const ruleCounts = new Map(
			(counts?.rules ?? []).map(({ ruleId, count }) => [ruleId, count])
		);
		const policyRules = document
			? localizationPolicyRules(join.cultures, document)
			: { rules: [], diagnostics: [] };
		const customChecks = customRulesOf(document);
		const files = localizationEvidenceFileStatuses(evidence);
		return LocalizationQualityReport.make({
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
			findings,
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
	}
);
