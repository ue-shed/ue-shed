import { Effect } from "effect";
import type { LocalizationTargetEvidence } from "@ue-shed/localization";
import type { TextCorpusReportHeader } from "./corpus-summary.js";
import { IndexedPolicyData } from "./indexed-policy-data.js";
import type { JoinedTargetReader } from "./joined-target-reader.js";
import {
	compareLocalizationFindings,
	compareReportedLocalizationFindings,
	enabledLocalizationChecks
} from "./localization-checks.js";
import { localizationRuleId } from "./localization-check-catalogue.js";
import { localizationEvidenceFileStatuses } from "./localization-status.js";
import { lazyAcceptedFindingFilter } from "./localization-review.js";
import { localizationPolicyRules } from "./localization-policy.js";
import { customLocalizationChecks, localizationRulesOf } from "./game-text-rules.js";
import { effectiveRuleDocument } from "./rules/effective.js";
import {
	LocalizationQualityReport,
	type LocalizationCheckOptions,
	type LocalizationQualityFinding,
	type LocalizationPolicyFinding,
	type LocalizationCustomFinding,
	type LocalizationCheckDiagnostic
} from "./localization-quality-schema.js";
import type { NativeFindings } from "./native-findings.js";
import type { GameTextRuleDocument } from "./game-text-rules.js";
import type { TextCorpusQuerySummary } from "./schema.js";
import type { LocalizationJoin, LocalizationLine } from "./localization-schema.js";
import type { BuiltInCheckId } from "./localization-check-ids.js";

type CheckedLine = Effect.Success<ReturnType<NativeFindings["findingsLines"]>>[number];

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

/**
 * Assemble the public report from the engine's findings; nothing evaluates here. `checked` are
 * the join's lines in report order, and `lineOf` hydrates the few lines accepted findings need.
 */
function assembleLocalizationCheckReport(
	corpus: ReportCorpus,
	join: Pick<LocalizationJoin, "target" | "cultures">,
	evidence: LocalizationTargetEvidence,
	enabled: readonly BuiltInCheckId[],
	checked: readonly CheckedLine[],
	lineOf: (id: string) => LocalizationLine | undefined,
	options: LocalizationCheckOptions = {},
	document?: GameTextRuleDocument
) {
	const builtIns: LocalizationQualityFinding[] = [],
		policy: LocalizationPolicyFinding[] = [],
		custom: LocalizationCustomFinding[] = [],
		diagnostics: LocalizationCheckDiagnostic[] = [];
	const selected = <F extends { readonly culture: string }>(values: readonly F[]) =>
		values.filter((value) => !options.culture || value.culture === options.culture);

	for (const result of checked) {
		builtIns.push(...selected(result.builtIns));
		policy.push(...selected(result.policy));
		custom.push(...selected(result.custom));
		diagnostics.push(...selected(result.diagnostics));
	}

	const policyRules = document
		? localizationPolicyRules(join.cultures, document)
		: { rules: [], diagnostics: [] };
	const customChecks = customLocalizationChecks(document);
	const policyOrder = policyRules.rules.map(({ rule }) => rule.id),
		customOrder = customChecks.map((check) => check.id);
	policy.sort((a, b) => policyOrder.indexOf(a.ruleId) - policyOrder.indexOf(b.ruleId));
	custom.sort((a, b) => customOrder.indexOf(a.ruleId) - customOrder.indexOf(b.ruleId));
	// CLI proposals deliberately include accepted findings; workspace proposals are collected later.
	const changes = builtIns.flatMap((finding) =>
		finding.kind === "format_argument_renamed" && finding.suggestedChange
			? [finding.suggestedChange]
			: []
	);
	const all = [...builtIns.sort(compareLocalizationFindings), ...policy, ...custom];
	const keep = lazyAcceptedFindingFilter(options.review);
	const visible = keep
		? all.filter((finding) => keep(() => lineOf(finding.lineId), finding))
		: all;
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
		findings: [...visible].sort(compareReportedLocalizationFindings).map(reportedFinding),
		checkDiagnostics: diagnostics,
		roles: [],
		rules: [
			...localizationRulesOf(document).map(({ id: ruleId }) => ({
				ruleId,
				findingCount: visible.filter((finding) => finding.ruleId === ruleId).length
			})),
			...enabled.map((id) => ({
				ruleId: localizationRuleId(id),
				findingCount: visible.filter((finding) => finding.kind === id).length
			})),
			...customOrder.map((ruleId) => ({
				ruleId,
				findingCount: visible.filter((finding) => finding.ruleId === ruleId).length
			}))
		],
		changes: {
			schemaVersion: 1,
			provenance: {
				producer: "ue-shed.localization.checks",
				files: files.flatMap((file) => (file.provenance ? [file.provenance] : []))
			},
			changes
		},
		...(document ? { ruleDiagnostics: policyRules.diagnostics } : undefined),
		...(options.review ? { acceptedFindings: all.length - visible.length } : undefined),
		...(customChecks.length
			? { customChecks: customChecks.map(({ id, label }) => ({ ruleId: id, label })) }
			: undefined)
	});
}

/** Lines whose findings one engine read returns. */
const FINDING_PAGE_LINES = 5000;

/**
 * The CLI report over the engine's findings, group checks included. It reads the join's lines
 * as rows, their findings in pages, and hydrates only lines an accepted finding names, so it
 * never holds the corpus or the join. `joinRows` are the join's lines in the join's order.
 */
export const indexedLocalizationCheckReport = Effect.fn("GameText.localizationCheckReport")(
	function* (
		joined: JoinedTargetReader,
		corpus: ReportCorpus,
		joinRows: Uint32Array,
		evidence: LocalizationTargetEvidence,
		native: NativeFindings,
		options: LocalizationCheckOptions = {},
		document?: GameTextRuleDocument
	) {
		const data = new IndexedPolicyData(joined);
		const target = data.joined.meta.input.target;
		const join = { target: target.name, cultures: target.cultures };
		const enabled = enabledLocalizationChecks(join, evidence, options, document);
		const evaluated = yield* native.findingsEvaluate(effectiveRuleDocument(document, options));
		// Report order is line ID order, ties in join order.
		const ids = Array.from(joinRows, (row) => data.lineId(row));
		const collator = new Intl.Collator();
		const order = Array.from(ids.keys())
			.sort((a, b) => collator.compare(ids[a]!, ids[b]!))
			.map((position) => joinRows[position]!);
		const checked: CheckedLine[] = [];
		for (let start = 0; start < order.length; start += FINDING_PAGE_LINES)
			checked.push(
				...(yield* native.findingsLines(
					evaluated.key,
					order.slice(start, start + FINDING_PAGE_LINES)
				))
			);
		const rowOf = new Map(ids.map((id, position) => [id, joinRows[position]!]));
		const lineOf = (id: string) => {
			const row = rowOf.get(id);
			return row === undefined ? undefined : data.line(row);
		};
		return assembleLocalizationCheckReport(
			corpus,
			join,
			evidence,
			enabled,
			checked,
			lineOf,
			options,
			document
		);
	}
);
