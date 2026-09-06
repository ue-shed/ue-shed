import { it } from "@effect/vitest";
import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { movementGymScenario } from "./demo.js";
import { readScenarioDocumentFile, writeScenarioDocumentFile } from "./document-file.js";

it.effect("round-trips the edited document and rejects incompatible files", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-scenario-"))),
				(path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
			);
			const path = join(root, "draft.json");
			const document = { ...movementGymScenario, seed: 42, title: "Edited scenario" };
			yield* writeScenarioDocumentFile(path, document);
			expect(yield* readScenarioDocumentFile(path)).toEqual(document);
			yield* writeScenarioDocumentFile(path, { ...document, seed: 43 });
			expect((yield* readScenarioDocumentFile(path)).seed).toBe(43);
			yield* Effect.promise(() => writeFile(path, '{"schemaVersion":99}'));
			expect((yield* readScenarioDocumentFile(path).pipe(Effect.flip))._tag).toBe(
				"ScenarioDocumentFileError"
			);
		})
	)
);
