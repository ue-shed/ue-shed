import { resolve } from "node:path";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import {
	AssetReader,
	assetReaderLayer,
	extractProjectTextPackages,
	scanSavedProject
} from "../packages/unreal-assets/dist/index.js";
import { auditPackageTextCandidates } from "./package-text-candidates.test-support.ts";
import { textCorpusFromExtractionEvents } from "../packages/game-text/dist/index.js";
import { compareTextCorpora } from "./package-text-oracle.test-support.ts";
import {
	measureNativeText,
	packageTextFixtureProjects
} from "./package-text-reader.test-support.ts";
import { ensureUassetExecutable } from "./native-tools.ts";

const executable = ensureUassetExecutable();
it("StringTable and the opaque native fixture have no TextProperty header name", async () => {
	const scan = await Effect.runPromise(
		scanSavedProject({
			projectRoot: resolve("fixtures/unreal-project"),
			paths: [
				"Content/Fixture/Text/ST_Game.uasset",
				"Content/Fixture/ParserNative/DA_Native.uasset"
			],
			depth: "header",
			names: ["TextProperty"],
			classes: ["StringTable", "UEShedNativeCoverageAsset"]
		}).pipe(Effect.provide(assetReaderLayer({ executable })))
	);
	expect(scan.failures).toEqual([]);
	expect(scan.assets).toHaveLength(2);
	for (const entry of scan.assets) {
		if (entry.depth !== "header") throw new Error("Expected header");
		expect(entry.header.matched_names ?? []).not.toContain("TextProperty");
	}
});
it.each(packageTextFixtureProjects)(
	"audit Unreal gather candidates against the full corpus for %s",
	async (project) => {
		const {
			expected,
			actual,
			measurement: { oracle, gapsMovedToExcluded, clauses }
		} = await auditPackageTextCandidates(executable, project);
		expect(oracle, JSON.stringify(oracle)).toMatchObject({ equal: true, differenceCount: 0 });
		expect(compareTextCorpora({ ...actual, units: expected.units }, actual).equal).toBe(true);
		expect(clauses.textPropertyBeyondFlag).toBe(0);
		if (project === "fixtures/unreal-project") {
			expect(expected.coverage.unsupportedTextProperties).toBe(1);
			expect(actual.coverage.unsupportedTextProperties).toBe(0);
			expect(gapsMovedToExcluded).toContainEqual(
				expect.objectContaining({
					propertyPath: "OpaqueValue.Value",
					message: expect.stringContaining("Excluded because Unreal does not gather it")
				})
			);
			expect(actual.packageCoverage).toContainEqual(
				expect.objectContaining({
					packageFile: expect.stringContaining("DA_Native.uasset"),
					status: "not_gatherable"
				})
			);
			expect(actual.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "package_not_gatherable",
					packageFile: expect.stringContaining("DA_Native.uasset")
				})
			);
		}
	}
);
it.each(packageTextFixtureProjects)(
	"native package records equal the legacy corpus for %s",
	(project) => {
		const old = measureNativeText(executable, project, false);
		const compact = measureNativeText(executable, project, true);
		expect(compact.outcome).toBe(old.outcome);
		expect(
			compareTextCorpora(
				textCorpusFromExtractionEvents({
					projectRoot: resolve(project),
					events: old.events
				}),
				textCorpusFromExtractionEvents({
					projectRoot: resolve(project),
					events: compact.events
				})
			)
		).toMatchObject({ equal: true, differenceCount: 0 });
	}
);

it("the public reader negotiates v1.8 and validates package records", async () => {
	const projectRoot = resolve("fixtures/unreal-project");
	const events = await Effect.runPromise(
		extractProjectTextPackages({
			projectRoot,
			paths: ["Content/Fixture/Text/ST_Game.uasset"]
		}).pipe(Stream.runCollect, Effect.provide(assetReaderLayer({ executable })))
	);
	expect(
		events.some(
			(event) => event.event === "text_package_record" && event.occurrences.length > 0
		)
	).toBe(true);
	expect(events.at(-1)?.event).toBe("text_summary");
});

it("the public reader preserves an explicit empty selection without starting a worker", async () => {
	const events = await Effect.runPromise(
		extractProjectTextPackages({ projectRoot: "unused", paths: [] }).pipe(
			Stream.runCollect,
			Effect.provide(assetReaderLayer({ executable: "missing" }))
		)
	);
	expect(events).toEqual([]);
});

it("custom readers can keep their legacy API and report an absent capability", async () => {
	const error = await Effect.runPromise(
		Effect.gen(function* () {
			const reader = yield* AssetReader;
			const { extractProjectTextPackages: _capability, ...legacy } = reader;
			return yield* extractProjectTextPackages({ projectRoot: "unused" }).pipe(
				Stream.runDrain,
				Effect.flip,
				Effect.provide(Layer.succeed(AssetReader, legacy))
			);
		}).pipe(Effect.provide(assetReaderLayer({ executable })))
	);
	expect(error.code).toBe("unsupported_capability");
	expect(error.kind).toBe("contract");
});
