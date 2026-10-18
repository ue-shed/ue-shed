import { AssetReader, assetReaderLayer } from "@ue-shed/unreal-assets";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { scanTextCorpus, textCorpusFromExtractionEvents } from "./corpus.js";
import { searchTextCorpus } from "./search.test-support.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();

describe.skipIf(!executable)("game text fixture corpus", () => {
	it("keeps localized and string-table identities with their occurrences", async () => {
		const corpus = await Effect.runPromise(
			scanTextCorpus({ projectRoot: fixture.root }).pipe(
				Effect.provide(assetReaderLayer({ executable: executable! }))
			)
		);

		// One Game Text problem case is a package the reader only partly decodes.
		expect(corpus.status).toBe("partial");
		expect(corpus.coverage).toMatchObject({
			// The maps, World Partition external actors, animation fixture, and nested-only timeline
			// carry no text of their own. Every InputAction and InputMappingContext carries one FText
			// description, the text timeline contributes three localized keys, and the Blueprint graph
			// fixture contributes one localized pin label, while the richer review Blueprint adds
			// saved variable/component categories, including Review|Settings. The StringTable reference contributes
			// one additional unit and occurrence with its table/key identity. The localization target's
			// String Table, DataTable and data asset add twenty-two localized units and occurrences, and
			// the user-defined enum adds its two display names. The ten Game Text problem packages add
			// 46 units and 53 occurrences: this scan does not fold the three Widget Blueprints'
			// compiled copies (eight occurrences of three keys), and one row is culture invariant. The twelve
			// Game Text identity packages add 16 units and 35 occurrences. Compiled Blueprint bytecode adds
			// seven Print Text literals in five new ids: two in the sign Blueprint, which its branch copy
			// shares, and three in its Content Browser duplicate, whose new keys split the shared one.
			// Identity slice 2 adds nine packages (eight under Slice2/ and one World Partition
			// external actor), 17 occurrences and 12 units; two occurrences are culture invariant.
			discoveredPackages: 115,
			inspectedPackages: 115,
			partialPackages: 1,
			failedPackages: 0,
			textUnits: 143,
			textOccurrences: 185,
			resolvedOccurrences: 182,
			unsupportedTextProperties: 0
		});
		const holdMatches = searchTextCorpus(corpus, "Hold to skip");
		expect(holdMatches).toHaveLength(2);
		expect(holdMatches.flatMap((unit) => unit.occurrences)).toHaveLength(3);
		// Two units share the exact source "Confirm" under distinct keys — that equal-source,
		// distinct-identity pair is what this fixture exists to prove. Corpus lookup is
		// intentionally source-text-only, so assert the resulting texts rather than identity keys.
		const confirmMatches = searchTextCorpus(corpus, "Confirm");
		expect(confirmMatches.length).toBeGreaterThanOrEqual(2);
		// The localization target repeats this pair under /Game/Fixture/Localization; count the text
		// fixture's own pair.
		const equalSource = confirmMatches.filter(
			(unit) =>
				unit.source.status === "consistent" &&
				unit.source.value === "Confirm" &&
				unit.occurrences.every((occurrence) =>
					occurrence.location.objectPath.startsWith("/Game/Fixture/Text/")
				)
		);
		expect(equalSource).toHaveLength(2);
		expect(
			new Set(
				equalSource.map((unit) =>
					unit.identity.status === "resolved" ? unit.identity.key : unit.id
				)
			).size
		).toBe(2);
		expect(corpus.units).toContainEqual(
			expect.objectContaining({
				identity: {
					status: "string_table",
					tableId: "/Game/Fixture/Text/ST_Game.ST_Game",
					key: "PromptContinue"
				},
				occurrences: [
					expect.objectContaining({
						location: expect.objectContaining({
							propertyPath: "StringTableReference"
						})
					})
				]
			})
		);
		expect(
			corpus.diagnostics.map((item) => [item.code, item.packageFile?.replace(/\\/gu, "/")])
		).toEqual([
			[
				"package_partially_decoded",
				"Content/Fixture/GameTextProblems/DA_FixturePartlyRead.uasset"
			]
		]);
	});

	it("reports a Blueprint's classes and keeps sites saved only under them", async () => {
		const events = await Effect.runPromise(
			Effect.gen(function* () {
				const reader = yield* AssetReader;
				return yield* Stream.runCollect(
					reader.extractProjectTextPackages!({
						projectRoot: fixture.root,
						paths: [
							"Content/Fixture/Blueprints/BP_ReviewFixture.uasset",
							"Content/Fixture/Text/DA_TextOccurrences.uasset"
						]
					})
				);
			}).pipe(Effect.provide(assetReaderLayer({ executable: executable! })))
		);
		const records = [...events].filter((event) => event.event === "text_package_record");
		const blueprint = records.find((record) =>
			record.path.endsWith("BP_ReviewFixture.uasset")
		)!;
		const path = "/Game/Fixture/Blueprints/BP_ReviewFixture";
		expect(blueprint.blueprintClasses).toEqual([
			{
				blueprint: `${path}.BP_ReviewFixture`,
				generatedClass: `${path}.BP_ReviewFixture_C`,
				classDefault: `${path}.Default__BP_ReviewFixture_C`
			}
		]);
		const corpus = textCorpusFromExtractionEvents({ projectRoot: fixture.root, events });
		// Construction-script nodes are saved only under the generated class: every one stays a
		// place, and nothing in either package is folded.
		const occurrences = corpus.units.flatMap((unit) => unit.occurrences);
		expect(corpus.coverage.textOccurrences).toBe(
			records.reduce((sum, record) => sum + record.occurrences.length, 0)
		);
		expect(occurrences.filter((item) => item.copies !== undefined)).toEqual([]);
		expect(
			occurrences.filter((item) =>
				item.location.objectPath.startsWith(`${path}.BP_ReviewFixture_C.`)
			)
		).toHaveLength(4);
		// fixture-contract.json: one key, two legitimate properties of one asset, two places.
		const shared = corpus.units.find(
			(unit) =>
				unit.identity.status === "resolved" && unit.identity.key === "SharedHoldPrompt"
		)!;
		expect(shared.occurrences).toHaveLength(2);
	});
});
