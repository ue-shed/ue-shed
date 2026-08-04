import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	PROJECT_INDEX_MAX_PAGE_SIZE,
	ProjectIdentity,
	ProjectIndexGeneration,
	ProjectIndexPage,
	ProjectIndexQuery
} from "./project-index.js";

const projectId = ProjectIdentity.make("fixture-project");
const generation = ProjectIndexGeneration.make(1);

describe("Project Index public contract", () => {
	it("rejects a query above the package-enforced page limit", async () => {
		const result = await Effect.runPromiseExit(
			Schema.decodeUnknownEffect(ProjectIndexQuery)({
				_tag: "Maps",
				expectedGeneration: generation,
				limit: PROJECT_INDEX_MAX_PAGE_SIZE + 1,
				projectId
			})
		);
		expect(result._tag).toBe("Failure");
	});

	it("rejects an adapter page above the same bound", async () => {
		const result = await Effect.runPromiseExit(
			Schema.decodeUnknownEffect(ProjectIndexPage)({
				generation,
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
