import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { LocalizationEvidence } from "@ue-shed/localization";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { textCorpusQuery } from "./query.test-support.js";
import { SharedIndex, sharedIndexDirectory, sharedIndexNodeLayer } from "./shared-index.js";

// Facts are unordered flags; all evidence, primary states and unknown reasons compare exactly.
const orderedFacts = (join: ReturnType<typeof joinLocalizationTarget>) => ({
	...join,
	lines: join.lines.map((line) => ({
		...line,
		cultures: line.cultures.map((culture) => ({
			...culture,
			facts: [...culture.facts].sort()
		}))
	}))
});

it.live(
	"shares package extraction across source and targets while preserving each joined view",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const other = fixture.addTarget("Other");
			yield* Effect.gen(function* () {
				const service = yield* GameTextIndexRefresh;
				const source = yield* service.refresh({ projectRoot: fixture.projectRoot });
				expect(fixture.packageReads()).toBe(1);
				const localized = yield* service.refresh(fixture.request);
				const secondTarget = yield* service.refresh({
					projectRoot: fixture.projectRoot,
					targetName: other.name
				});
				expect(fixture.packageReads()).toBe(1);
				expect(localized.packages.readPackages).toBe(0);
				expect(secondTarget.packages.readPackages).toBe(0);
				const sourceAgain = yield* service.refresh({ projectRoot: fixture.projectRoot });
				const targetAgain = yield* service.refresh(fixture.request);
				expect(sourceAgain.join.rebuilt).toBe(false);
				expect(targetAgain.join.rebuilt).toBe(false);
				expect(sourceAgain.join.key).toBe(source.join.key);
				expect(targetAgain.join.key).toBe(localized.join.key);
				yield* service.invalidate(fixture.request);
				expect(
					(yield* service.refresh({ projectRoot: fixture.projectRoot })).join.rebuilt
				).toBe(false);
				expect((yield* service.refresh(fixture.request)).join.rebuilt).toBe(true);
				const search = { query: "Source", capability: "all" as const, pageSize: 10 };
				const pinned = yield* source.query.search(search);
				fixture.setSource("Updated");
				const changedTarget = yield* service.refresh(fixture.request);
				expect(fixture.packageReads()).toBe(2);
				const changedSource = yield* service.refresh({ projectRoot: fixture.projectRoot });
				expect(fixture.packageReads()).toBe(2);
				expect(changedSource.packages.readPackages).toBe(0);
				expect(changedTarget.join.rebuilt).toBe(true);
				expect(
					(yield* changedSource.query.search({ ...search, query: "Updated" })).total
				).toBe(1);
				expect(yield* source.query.search(search)).toEqual(pinned);
				expect((yield* localized.localizationJoin).target).toBe(fixture.target.name);
				expect((yield* secondTarget.localizationJoin).target).toBe(other.name);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const store = yield* SharedIndex;
						yield* (yield* store.writer()).compact(true);
					})
				).pipe(
					Effect.provide(
						sharedIndexNodeLayer({
							cacheRoot: join(fixture.projectRoot, "cache"),
							projectKey: fixture.projectRoot,
							targetKey: "SavedText",
							projectView: { kind: "source" }
						})
					)
				);
				const compacted = yield* service.refresh(fixture.request);
				expect(fixture.packageReads()).toBe(2);
				expect((yield* compacted.localizationJoin).target).toBe(fixture.target.name);
				expect(yield* source.query.search(search)).toEqual(pinned);
			}).pipe(Effect.provide(fixture.layer()));
			const configuration = {
				cacheRoot: fixture.projectRoot,
				projectKey: fixture.projectRoot
			};
			expect(
				sharedIndexDirectory({
					...configuration,
					targetKey: "SavedText",
					projectView: { kind: "source" }
				})
			).toBe(
				sharedIndexDirectory({
					...configuration,
					targetKey: fixture.target.name,
					projectView: { kind: "localization", target: fixture.target.name }
				})
			);
		}).pipe(Effect.scoped)
);

it.live.each(["manifest", "archive", "po"] as const)(
	"keeps failed current %s input distinct from pinned historical evidence and repairs",
	(kind) =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const file = kind === "manifest" ? "Review.manifest" : `de.${kind}`;
			const saved = fixture.contents[kind];
			yield* Effect.gen(function* () {
				const index = yield* GameTextIndexRefresh;
				const first = yield* index.refresh(fixture.request);
				const pinned = (yield* first.localizationJoin).lines;
				for (const broken of ["malformed", "missing"] as const) {
					yield* Effect.promise(() =>
						broken === "missing"
							? unlink(join(fixture.projectRoot, file))
							: writeFile(join(fixture.projectRoot, file), "not a localization file")
					);
					const failed = yield* index.refresh(fixture.request);
					const culture = failed.evidence.cultures.find((item) => item.culture === "de");
					const currentFile =
						kind === "manifest" ? failed.evidence.manifest : culture?.[kind];
					expect(currentFile?.status).toBe("failed");
					if (!currentFile || currentFile.status !== "failed")
						throw new Error("Expected failed current input");
					expect(currentFile.error.code === "file_missing").toBe(broken === "missing");
					const oracle = yield* Effect.gen(function* () {
						return yield* (yield* LocalizationEvidence).read({
							projectRoot: fixture.projectRoot,
							target: fixture.target
						});
					}).pipe(Effect.provide(fixture.evidence));
					const expected = joinLocalizationTarget(fixture.raw(), oracle);
					expect(orderedFacts(yield* failed.localizationJoin)).toEqual(
						orderedFacts(expected)
					);
					const search = {
						query: "",
						capability: "all" as const,
						pageSize: 10,
						localization: {
							target: fixture.target.name,
							culture: fixture.target.cultures[1]!
						}
					};
					expect((yield* failed.query.search(search)).localization?.counts).toEqual(
						textCorpusQuery(fixture.raw(), undefined, expected).search(search)
							.localization?.counts
					);
					const reopened = yield* Effect.gen(function* () {
						return yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
					}).pipe(Effect.provide(fixture.layer(), { local: true }));
					expect(yield* reopened.localizationJoin).toEqual(
						yield* failed.localizationJoin
					);
					expect((yield* first.localizationJoin).lines).toEqual(pinned);
					expect(yield* first.corpus).toEqual(fixture.raw());
					yield* Effect.promise(() => writeFile(join(fixture.projectRoot, file), saved));
					const repaired = yield* index.refresh(fixture.request);
					expect((yield* repaired.localizationJoin).lines).toEqual(pinned);
				}
			}).pipe(Effect.provide(fixture.layer()));
		})
);

it.live("raw corpus retains invisible units and empty-source String Table evidence", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		const base = {
			dev_notes: "",
			edit_capability: "read_only" as const,
			location: {
				kind: "asset_property" as const,
				object_path: "/Game/Text/Table.Table",
				class_path: "/Script/Engine.DataAsset",
				property_path: "Label"
			}
		};
		fixture.update([
			...(["Visible", "", " \t\r\n"] as const).map((source, index) => ({
				...base,
				source,
				identity: { status: "resolved" as const, namespace: "UI", key: `K${index}` }
			})),
			{
				...base,
				source: "",
				identity: {
					status: "string_table" as const,
					table_id: "/Game/Text/ST_Empty.ST_Empty",
					key: "Empty"
				}
			}
		]);
		const indexed = yield* Effect.gen(function* () {
			return yield* (yield* GameTextIndexRefresh).refresh({
				projectRoot: fixture.projectRoot
			});
		}).pipe(Effect.provide(fixture.layer()));
		expect(yield* indexed.corpus).toEqual(fixture.raw());
		expect((yield* indexed.corpus).units).toHaveLength(4);
		expect((yield* indexed.corpus).coverage.textOccurrences).toBe(4);
		const search = { query: "", capability: "all" as const, pageSize: 10 };
		const oracle = textCorpusQuery(fixture.raw());
		expect((yield* indexed.query.search(search)).total).toBe(oracle.search(search).total);
		expect(yield* indexed.query.export(search)).toEqual(oracle.export(search));
	})
);
