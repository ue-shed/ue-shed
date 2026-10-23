import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { GameTextIndexRefresh } from "./index-refresh.js";

import { CheckSeverity } from "./localization-check-ids.js";

import {
	BuiltInQualityFilter,
	eligibleLocalizationChange,
	localizationQualityWorkspace,
	localizationQualityWorkspaceOf,
	workspaceQualityItem,
	type WorkspaceQualityItem,
	type WorkspaceQualityRequest
} from "./localization-workspace.js";
import {
	workspaceScaleFixture,
	workspaceScaleRules
} from "./localization-workspace-scale.test-support.js";
import type { LocalizationJoin } from "./localization-schema.js";
import type { LocalizationQualityReport } from "./localization-quality-schema.js";
import type { TextQualityReport } from "./quality-schema.js";

/** The eager presentation oracle: materialize every summary, reconcile, then stable-sort. */
function eagerItems(
	source: TextQualityReport | undefined,
	report: LocalizationQualityReport,
	join: LocalizationJoin
) {
	const lines = new Map(join.lines.map((line) => [line.id, line]));
	const units = new Map(
		join.lines.flatMap((line) =>
			line.origin.kind === "corpus"
				? line.origin.unitIds.map((id) => [id, line] as const)
				: []
		)
	);
	const items = [
		...(source?.findings ?? []).map((finding) =>
			workspaceQualityItem(finding, units.get(finding.textUnitId))
		),
		...report.findings.flatMap((finding): WorkspaceQualityItem[] => {
			const line =
				"culture" in finding ? lines.get(finding.lineId) : units.get(finding.textUnitId);
			const item = workspaceQualityItem(finding, line);
			if (source && finding.kind === "placeholder_text") {
				const left = finding.unreportedMatches;
				if (left?.length === 0) return [];
				if (left?.length && left.length !== finding.actual.matches.length)
					return [
						{
							...item,
							summary: {
								...workspaceQualityItem(
									{ ...finding, actual: { ...finding.actual, matches: left } },
									line
								).summary,
								id: item.summary.id
							}
						}
					];
			}
			return [item];
		})
	];
	return items.sort(
		(a, b) =>
			CheckSeverity.literals.indexOf(a.summary.severity) -
			CheckSeverity.literals.indexOf(b.summary.severity)
	);
}

it.live(
	"generated indexed and in-memory pages equal eager presentation, with bounded hydration",
	() =>
		Effect.gen(function* () {
			const { fixture, target } = yield* workspaceScaleFixture(2048, 4);
			yield* Effect.gen(function* () {
				const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
				const join = yield* result.localizationJoin;
				const source = yield* (yield* result.sourceQuality(workspaceScaleRules)).export(
					"all"
				);
				const report = yield* result.localizationCheck(workspaceScaleRules);
				const quality = yield* result.localizationQuality(workspaceScaleRules);
				for (const rules of [source, undefined]) {
					const expected = eagerItems(rules, report, join);
					const memory = localizationQualityWorkspace(rules, report, join);
					let hydrated = 0,
						sourceLines = 0,
						facts = 0;
					const indexed = localizationQualityWorkspaceOf(rules, {
						...quality,
						metadata: {
							...quality.metadata,
							lineOfUnit: (id) => {
								sourceLines++;
								return quality.metadata.lineOfUnit(id);
							}
						},
						findings: {
							...quality.findings,
							filter: (position) => {
								facts++;
								return quality.findings.filter(position);
							},
							items: (positions) => {
								hydrated += positions.length;
								return quality.findings.items(positions);
							}
						}
					});
					expect([hydrated, sourceLines, facts]).toEqual([0, 0, 0]);
					for (const culture of [undefined, ...target.cultures]) {
						const inCulture = expected.filter(
							({ summary }) =>
								!culture || !summary.culture || summary.culture === culture
						);
						const severityCounts = Object.fromEntries(
							CheckSeverity.literals.map((severity) => [
								severity,
								inCulture.filter(({ summary }) => summary.severity === severity)
									.length
							])
						);
						const ruleCounts = new Map<string, number>();
						for (const { finding } of inCulture)
							ruleCounts.set(
								finding.ruleId,
								(ruleCounts.get(finding.ruleId) ?? 0) + 1
							);
						const counts = Object.fromEntries(
							BuiltInQualityFilter.literals.map((kind) => [
								kind,
								kind === "all"
									? inCulture.length
									: inCulture.filter(({ summary }) => summary.filter === kind)
											.length
							])
						);
						for (const filter of BuiltInQualityFilter.literals) {
							const selected = inCulture.filter(
								({ summary }) => filter === "all" || summary.filter === filter
							);
							const suggestedFixCount = selected.filter(({ finding }) =>
								eligibleLocalizationChange(finding)
							).length;
							for (const offset of new Set([
								0,
								50,
								Math.max(0, selected.length - 25),
								selected.length
							])) {
								const request: WorkspaceQualityRequest = {
									target: target.name,
									filter,
									offset,
									...(culture ? { culture } : undefined)
								};
								const before = hydrated + sourceLines;
								const page = yield* indexed.search(request);
								expect(hydrated + sourceLines - before).toBeLessThanOrEqual(50);
								expect(page).toEqual(memory.search(request));
								expect(page.findings).toEqual(
									selected.slice(offset, offset + 50).map((item) => item.summary)
								);
								expect(page.total).toBe(selected.length);
								expect(page.severityCounts).toEqual(severityCounts);
								for (const rule of page.rules)
									expect(rule.findingCount).toBe(
										ruleCounts.get(rule.ruleId) ?? 0
									);
								expect(page.suggestedFixCount).toBe(suggestedFixCount);
								expect(page.counts).toEqual(counts);
								const beforeFacts = facts;
								yield* indexed.search({ ...request, offset: offset + 50 });
								expect(facts).toBe(beforeFacts);
							}
						}
					}
					for (const filter of [
						"all",
						"terminology",
						"placeholder_text",
						"format_argument_renamed"
					] as const) {
						const request = { target: target.name, filter };
						const exported = yield* indexed.export(request);
						expect(exported).toEqual(memory.export(request));
						expect(exported.findings).toEqual(
							expected
								.filter(
									({ summary }) => filter === "all" || summary.filter === filter
								)
								.map((item) => item.summary)
						);
						for (const { id } of (yield* indexed.search(request)).findings.slice(0, 2))
							expect(yield* indexed.focus({ target: target.name, id })).toEqual(
								memory.focus({ target: target.name, id })
							);
					}
					expect(yield* indexed.changes({ target: target.name, filter: "all" })).toEqual(
						memory.changes({ target: target.name, filter: "all" })
					);
					expect(sourceLines).toBe(0);
				}
			}).pipe(Effect.provide(fixture.layer()));
		}),
	// Native debug evaluation and asynchronous hydration retain every existing scale assertion.
	300_000
);
