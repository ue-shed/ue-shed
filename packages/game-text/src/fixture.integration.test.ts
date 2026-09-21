import { assetReaderLayer } from "@ue-shed/unreal-assets";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { scanTextCorpus } from "./corpus.js";
import { searchTextCorpus } from "./search.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();

describe.skipIf(!executable)("game text fixture corpus", () => {
	it("keeps localized and string-table identities with their occurrences", async () => {
		const corpus = await Effect.runPromise(
			scanTextCorpus({ projectRoot: fixture.root }).pipe(
				Effect.provide(assetReaderLayer({ executable: executable! }))
			)
		);

		expect(corpus.status).toBe("complete");
		expect(corpus.coverage).toMatchObject({
			// The maps, World Partition external actors, animation fixture, and nested-only timeline
			// carry no text of their own. Every InputAction and InputMappingContext carries one FText
			// description, the text timeline contributes three localized keys, and the Blueprint graph
			// fixture contributes one localized pin label. The StringTable reference contributes
			// one additional unit and occurrence with its table/key identity.
			discoveredPackages: 77,
			inspectedPackages: 77,
			failedPackages: 0,
			textUnits: 38,
			textOccurrences: 39,
			resolvedOccurrences: 39,
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
		const equalSource = confirmMatches.filter(
			(unit) => unit.source.status === "consistent" && unit.source.value === "Confirm"
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
		expect(corpus.diagnostics).toEqual([]);
	});
});
