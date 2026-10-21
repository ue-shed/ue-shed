import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { decodeAuthoringCatalogResultFromHost } from "./authoring-client.js";

describe("Workbench authoring catalog boundary", () => {
	it("turns malformed host results into a typed contract failure", async () => {
		const result = await Effect.runPromiseExit(
			decodeAuthoringCatalogResultFromHost({
				status: "ready",
				tables: "not-an-array"
			})
		);

		expect(Exit.isFailure(result)).toBe(true);
	});
});
