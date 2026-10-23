import { Effect } from "effect";
import type { LocalizationTargetEvidence } from "@ue-shed/localization";
import { textCorpusDiagnosticSummary } from "./corpus-summary.js";
import { IndexedPolicyData } from "./indexed-policy-data.js";
import type { JoinedTargetReader } from "./joined-target-reader.js";
import { localizationLineUnits } from "./gathered-text.js";
import {
	checkLocalizationGroups,
	compareLocalizationFindings,
	compareReportedLocalizationFindings,
	enabledLocalizationChecks,
	localizationDuplicateCandidate,
	localizationDuplicatePlaces,
	localizationDuplicateSources,
	localizationLocalizableProperties,
	localizationRuleContext,
	localizationTranslationVariants
} from "./localization-checks.js";
import { localizationRuleId } from "./localization-check-catalogue.js";
import { localizationEvidenceFileStatuses } from "./localization-status.js";
import { withoutAcceptedFindings } from "./localization-review.js";
import { localizationPolicyRules } from "./localization-policy.js";
import { customLocalizationChecks } from "./localization-custom-checks.js";
import { translateRuleDocument } from "./rules/translate.js";
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
import type { TextCorpus } from "./schema.js";
import type { LocalizationJoin } from "./localization-schema.js";

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

/** Assemble the public report; only corpus group checks evaluate here. */
export function assembleLocalizationCheckReport(
	corpus: TextCorpus,
	join: LocalizationJoin,
	evidence: LocalizationTargetEvidence,
	checked: ReadonlyMap<string, CheckedLine>,
	options: LocalizationCheckOptions = {},
	document?: GameTextRuleDocument
) {
	const enabled = enabledLocalizationChecks(join, evidence, options, document);
	const lines = [...join.lines].sort((a, b) => a.id.localeCompare(b.id));
	const byUnit = new Map(corpus.units.map((unit) => [unit.id, unit]));
	const duplicates = localizationDuplicateSources();
	for (const [position, line] of join.lines.entries())
		if (localizationDuplicateCandidate(line))
			duplicates.add(line.source, line.identity!, position, -1, () =>
				localizationDuplicatePlaces(
					line,
					localizationLineUnits(line, byUnit).flatMap((unit) => unit.occurrences)
				)
			);
	const { shared } = duplicates.finish();
	const ruleContext = localizationRuleContext(document);
	const variants = localizationTranslationVariants(
		shared,
		join.nativeCulture,
		ruleContext.checks.inconsistent_translation.params
	);
	if (enabled.includes("inconsistent_translation"))
		for (const line of join.lines) variants.add(line);
	const context = {
		...ruleContext,
		target: join.target,
		nativeCulture: join.nativeCulture,
		options,
		enabled,
		duplicates: shared,
		translations: variants.finish(),
		localizableProperties: enabled.includes("culture_invariant_text")
			? localizationLocalizableProperties(corpus.units)
			: new Set<string>()
	};
	const builtIns: LocalizationQualityFinding[] = [],
		policy: LocalizationPolicyFinding[] = [],
		custom: LocalizationCustomFinding[] = [],
		diagnostics: LocalizationCheckDiagnostic[] = [];
	const selected = <F extends { readonly culture: string }>(values: readonly F[]) =>
		values.filter((value) => !options.culture || value.culture === options.culture);

	for (const line of lines) {
		const result = checked.get(line.id)!;
		builtIns.push(...selected(result.builtIns));
		policy.push(...selected(result.policy));
		custom.push(...selected(result.custom));
		diagnostics.push(...selected(result.diagnostics));
		checkLocalizationGroups(line, () => localizationLineUnits(line, byUnit), context, builtIns);
	}

	const policyRules =
		document && document.schemaVersion !== 1
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
	const visible = withoutAcceptedFindings(join, all, options.review);
	const files = localizationEvidenceFileStatuses(evidence);
	return LocalizationQualityReport.make({
		schemaVersion: 1,
		ruleDocumentVersion: document?.schemaVersion ?? 1,
		status: corpus.status,
		coverage: corpus.coverage,
		...textCorpusDiagnosticSummary(corpus.diagnostics),
		target: join.target,
		gatherEvidence: files,
		findings: [...visible.findings]
			.sort(compareReportedLocalizationFindings)
			.map(reportedFinding),
		checkDiagnostics: diagnostics,
		roles: [],
		rules: [
			...(document && document.schemaVersion !== 1
				? (document.localizationRules ?? []).map((rule) => rule.id)
				: []
			).map((ruleId) => ({
				ruleId,
				findingCount: visible.findings.filter((finding) => finding.ruleId === ruleId).length
			})),
			...enabled.map((id) => ({
				ruleId: localizationRuleId(id),
				findingCount: visible.findings.filter((finding) => finding.kind === id).length
			})),
			...customOrder.map((ruleId) => ({
				ruleId,
				findingCount: visible.findings.filter((finding) => finding.ruleId === ruleId).length
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
		...(document && document.schemaVersion !== 1
			? { ruleDiagnostics: policyRules.diagnostics }
			: undefined),
		...(options.review ? { acceptedFindings: visible.accepted } : undefined),
		...(customChecks.length
			? { customChecks: customChecks.map(({ id, label }) => ({ ruleId: id, label })) }
			: undefined)
	});
}

/** CLI report assembly over native row findings and the remaining corpus group checks. */
export const indexedLocalizationCheckReport = Effect.fn("GameText.localizationCheckReport")(
	function* (
		joined: JoinedTargetReader,
		corpus: TextCorpus,
		join: LocalizationJoin,
		evidence: LocalizationTargetEvidence,
		native: NativeFindings,
		options: LocalizationCheckOptions = {},
		document?: GameTextRuleDocument
	) {
		enabledLocalizationChecks(join, evidence, options, document);
		const evaluated = yield* native.findingsEvaluate(translateRuleDocument(document, options));
		const data = new IndexedPolicyData(joined),
			rows = new Map<string, number>();
		for (let row = 0; row < data.joined.meta.count; row++) rows.set(data.lineId(row), row);
		const lines = [...join.lines].sort((a, b) => a.id.localeCompare(b.id)),
			checked = new Map<string, CheckedLine>();
		for (let start = 0; start < lines.length; start += 5000) {
			const batch = lines.slice(start, start + 5000),
				results = yield* native.findingsLines(
					evaluated.key,
					batch.map((line) => rows.get(line.id)!)
				);
			batch.forEach((line, index) => checked.set(line.id, results[index]!));
		}
		return assembleLocalizationCheckReport(corpus, join, evidence, checked, options, document);
	}
);
