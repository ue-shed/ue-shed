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
			discoveredPackages: 19,
			inspectedPackages: 19,
			failedPackages: 0,
			textUnits: 8,
			textOccurrences: 9,
			resolvedOccurrences: 9,
			unsupportedTextProperties: 1
		});
		const holdMatches = searchTextCorpus(corpus, "Hold to skip");
		expect(holdMatches).toHaveLength(2);
		expect(holdMatches.flatMap((unit) => unit.occurrences)).toHaveLength(3);
		expect(searchTextCorpus(corpus, "Confirm")).toHaveLength(2);
		expect(corpus.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "unsupported_text_history",
				propertyPath: "StringTableReference"
			})
		);
	});
});
