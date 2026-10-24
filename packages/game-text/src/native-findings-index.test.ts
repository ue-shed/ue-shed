import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { GameTextRuleDocument } from "./game-text-rules.js";
import { STARTER_CHECK_RULES } from "./starter-rules.js";
import { localizationQualityWorkspaceOf } from "./localization-workspace.js";

it.effect("reads native findings through both compact indexes and the CLI report", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			yield* Effect.gen(function* () {
				const index = yield* GameTextIndexRefresh;
				const model = yield* index.refresh({
					projectRoot: fixture.projectRoot,
					targetName: fixture.target.name
				});
				const document = Schema.decodeUnknownSync(GameTextRuleDocument)({
					schemaVersion: 1,
					roles: [
						{
							id: "all",
							scopes: [
								{
									matchers: [
										{ kind: "object_path", operator: "prefix", value: "/Game/" }
									]
								}
							]
						}
					],
					rules: [
						...STARTER_CHECK_RULES.rules,
						{
							id: "limit",
							role: "all",
							kind: "character_budget",
							maximumCharacters: 3,
							recovery: "Shorten the source."
						}
					]
				});
				const source = yield* model.sourceQuality(document);
				const report = yield* source.export("all");
				expect(report.findings).toHaveLength(1);
				expect(report.findings[0]?.actual).toEqual({
					kind: "character_count",
					source: "Source",
					characterCount: 6
				});
				const page = yield* source.search({ filter: "all", pageSize: 1 });
				expect(page.total).toBe(1);
				expect(
					(yield* source.focus({ id: page.findings[0]!.id, pageSize: 1 }))?.ruleId
				).toBe("limit");
				const quality = yield* model.localizationQuality(document);
				const workspace = localizationQualityWorkspaceOf(report, quality);
				const checked = yield* workspace.search({
					target: fixture.target.name,
					filter: "all"
				});
				expect(
					checked.findings.some(
						(finding) => finding.filter === "missing_translator_notes"
					)
				).toBe(true);
				const cli = yield* model.localizationCheck(document);
				expect(
					cli.findings.some((finding) => finding.kind === "missing_translator_notes")
				).toBe(true);
			}).pipe(Effect.provide(fixture.layer()));
		})
	)
);
