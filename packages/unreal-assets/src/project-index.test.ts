import { it as effectIt } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	foldProjectIndexRefresh,
	decodeProjectIndexPage,
	getProjectIndexCacheRoot,
	getProjectIndexStatus,
	PROJECT_INDEX_CACHE_ROOT_ENV,
	PROJECT_INDEX_MAX_PAGE_SIZE,
	ProjectIdentity,
	ProjectIndexConfigLive,
	ProjectIndexGeneration,
	ProjectIndexHeader,
	ProjectIndexMap,
	ProjectIndexPage,
	ProjectIndexQuery,
	queryProjectIndex,
	refreshProjectIndex
} from "./project-index.js";
import {
	projectIndexMemoryLayer,
	projectIndexMemoryLayerWithConfig
} from "./project-index-memory.js";

const projectId = ProjectIdentity.make("fixture-project");
const projectRoot = "C:/Fixture";
const cacheRoot = "C:/Caches/project-index";

const maps: readonly ProjectIndexMap[] = [
	{
		kind: "map",
		mapPath: "Content/Maps/L_Fixture.umap",
		packageName: "/Game/Maps/L_Fixture"
	}
];

const headers: readonly ProjectIndexHeader[] = [
	{
		classes: ["/Script/Engine.DataTable", "/Script/EnhancedInput.InputAction"],
		kind: "header",
		packageName: "/Game/Data/DT_Items",
		packagePath: "Content/Data/DT_Items.uasset",
		serializedNames: ["TextProperty", "RowStruct"]
	},
	{
		classes: ["/Script/Engine.Texture2D"],
		kind: "header",
		packageName: "/Game/Textures/T_Icon",
		packagePath: "Content/Textures/T_Icon.uasset",
		serializedNames: ["BulkData"]
	}
];

const memoryLayer = projectIndexMemoryLayerWithConfig({
	cacheRoot,
	seed: { headers, maps, projectId }
});

describe("Project Index public contract", () => {
	effectIt.effect(
		"reuses only deeply frozen validated pages across adapter and public boundaries",
		() =>
			Effect.gen(function* () {
				const input = {
					generation: 1,
					projectId: "fixture",
					items: [
						{
							kind: "header",
							packageName: "/Game/A",
							packagePath: "Content/A.uasset",
							classes: ["Class"],
							serializedNames: ["Name"]
						}
					]
				};
				const page = yield* decodeProjectIndexPage(input);
				expect(yield* decodeProjectIndexPage(page)).toBe(page);
				input.generation = 0;
				expect((yield* Effect.result(decodeProjectIndexPage(input)))._tag).toBe("Failure");
				expect(Object.isFrozen(page)).toBe(true);
				expect(Object.isFrozen(page.items)).toBe(true);
				const item = page.items[0];
				if (item?.kind !== "header") throw new Error("expected header");
				expect(Object.isFrozen(item)).toBe(true);
				expect(Object.isFrozen(item.classes)).toBe(true);
				expect(Object.isFrozen(item.serializedNames)).toBe(true);
				expect(() => Object.assign(item.classes, { 0: "changed" })).toThrow();
				expect(() => Object.assign(page, { generation: 0 })).toThrow();
				// Freezing an arbitrary object does not grant validation provenance.
				const invalid = Object.freeze({ ...page, generation: 0 });
				const result = yield* Effect.result(decodeProjectIndexPage(invalid));
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure")
					expect(result.failure._tag).toBe("ProjectIndexUnavailable");
			})
	);

	effectIt.effect("keeps domain bounds on dictionary-expanded and ordinary page values", () =>
		Effect.gen(function* () {
			const header = {
				kind: "header",
				packageName: "/Game/A",
				packagePath: "Content/A.uasset",
				classes: ["Class"],
				serializedNames: ["Name"]
			};
			for (const change of [
				{ classes: ["x".repeat(1025)] },
				{ serializedNames: Array(65).fill("Name") },
				{ packagePath: "x".repeat(32768) },
				{ packageName: "" }
			]) {
				const result = yield* Effect.result(
					decodeProjectIndexPage({
						generation: 1,
						projectId: "fixture",
						items: [{ ...header, ...change }]
					})
				);
				expect(result._tag).toBe("Failure");
			}
		})
	);
	it("rejects a query above the package-enforced page limit", async () => {
		const result = await Effect.runPromiseExit(
			Schema.decodeUnknownEffect(ProjectIndexQuery)({
				_tag: "Maps",
				expectedGeneration: ProjectIndexGeneration.make(1),
				limit: PROJECT_INDEX_MAX_PAGE_SIZE + 1,
				projectId
			})
		);
		expect(result._tag).toBe("Failure");
	});

	it("rejects an adapter page above the same bound", async () => {
		const result = await Effect.runPromiseExit(
			Schema.decodeUnknownEffect(ProjectIndexPage)({
				generation: ProjectIndexGeneration.make(1),
				items: Array.from({ length: PROJECT_INDEX_MAX_PAGE_SIZE + 1 }, (_, index) => ({
					classes: [],
					kind: "header",
					packageName: `/Game/Fixture/P_${index}`,
					packagePath: `Content/Fixture/P_${index}.uasset`,
					serializedNames: []
				})),
				projectId
			})
		);
		expect(result._tag).toBe("Failure");
	});
});

effectIt.effect("refreshes and answers bounded queries through the in-memory adapter", () =>
	Effect.gen(function* () {
		expect(yield* getProjectIndexStatus({ projectRoot })).toEqual({ status: "absent" });

		const summary = yield* foldProjectIndexRefresh(
			yield* Stream.runCollect(refreshProjectIndex({ projectRoot }))
		);
		expect(summary.projectId).toBe(projectId);
		expect(summary.generation).toBe(1);
		expect(summary.mapCount).toBe(1);
		expect(summary.packageCount).toBe(3);

		const mapsPage = yield* queryProjectIndex(
			ProjectIndexQuery.cases.Maps.make({
				expectedGeneration: summary.generation,
				limit: 10,
				projectId: summary.projectId
			})
		);
		expect(mapsPage.items).toEqual(maps);

		const tables = yield* queryProjectIndex(
			ProjectIndexQuery.cases.ExactClasses.make({
				expectedGeneration: summary.generation,
				limit: 10,
				projectId: summary.projectId,
				values: ["/Script/Engine.DataTable"]
			})
		);
		expect(tables.items).toEqual([headers[0]]);

		const prefixes = yield* queryProjectIndex(
			ProjectIndexQuery.cases.ClassPrefixes.make({
				expectedGeneration: summary.generation,
				limit: 10,
				projectId: summary.projectId,
				values: ["/Script/EnhancedInput."]
			})
		);
		expect(prefixes.items).toEqual([headers[0]]);

		expect(yield* getProjectIndexCacheRoot()).toBe(cacheRoot);
	}).pipe(Effect.provide(memoryLayer))
);

effectIt.effect("rejects stale generations and pages with an enforced limit", () =>
	Effect.gen(function* () {
		const summary = yield* foldProjectIndexRefresh(
			yield* Stream.runCollect(refreshProjectIndex({ projectRoot }))
		);
		yield* foldProjectIndexRefresh(
			yield* Stream.runCollect(refreshProjectIndex({ projectRoot }))
		);

		const stale = yield* queryProjectIndex(
			ProjectIndexQuery.cases.Maps.make({
				expectedGeneration: summary.generation,
				limit: 10,
				projectId: summary.projectId
			})
		).pipe(Effect.flip);
		expect(stale._tag).toBe("ProjectIndexStaleGeneration");

		const page = yield* queryProjectIndex(
			ProjectIndexQuery.cases.ExactClasses.make({
				expectedGeneration: ProjectIndexGeneration.make(2),
				limit: 1,
				projectId: summary.projectId,
				values: ["/Script/Engine.DataTable", "/Script/Engine.Texture2D"]
			})
		);
		expect(page.items).toHaveLength(1);
		expect(page.nextCursor).toBe("1");
	}).pipe(Effect.provide(memoryLayer))
);

effectIt.effect("loads cache-root policy from configuration without Electron imports", () =>
	Effect.gen(function* () {
		const root = yield* getProjectIndexCacheRoot();
		expect(root).toBe("D:/Caches/from-config");
	}).pipe(
		Effect.provide(
			Layer.merge(
				projectIndexMemoryLayer({ cacheRoot: "D:/Caches/from-config" }),
				ProjectIndexConfigLive
			)
		),
		Effect.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					[PROJECT_INDEX_CACHE_ROOT_ENV]: "D:/Caches/from-config"
				})
			)
		)
	)
);
