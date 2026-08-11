import { fileURLToPath } from "node:url";
import { assetReaderLayer } from "@ue-shed/unreal-assets";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { scanTextCorpus } from "./corpus.js";
import { searchTextCorpus } from "./search.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixtureRoot = fileURLToPath(new URL("../../../fixtures/unreal-project", import.meta.url));

describe.skipIf(!executable)("game text fixture corpus", () => {
	it("keeps Unreal identities, occurrences, and unsupported histories explicit", async () => {
		const corpus = await Effect.runPromise(
			scanTextCorpus({ projectRoot: fixtureRoot }).pipe(
				Effect.provide(assetReaderLayer({ executable: executable! }))
			)
		);

		expect(corpus.status).toBe("partial");
		expect(corpus.coverage).toMatchObject({
			// The maps, World Partition external actors, animation fixture, and nested-only timeline
			// carry no text of their own.
			// Every InputAction and InputMappingContext carries one FText description, while the
			// LevelSequence contributes three localized timeline keys.
			discoveredPackages: 69,
			inspectedPackages: 69,
			failedPackages: 0,
			textUnits: 36,
			textOccurrences: 37,
			resolvedOccurrences: 37,
			unsupportedTextProperties: 1
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
		expect(corpus.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "unsupported_text_history",
				propertyPath: "StringTableReference"
			})
		);
	});
});
