import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { makeElectronAppTestLayer } from "../adapters/electron-app.js";
import { makeLocalFilesTestLayer } from "../adapters/local-files.js";
import { WorkbenchProjectHistory, WorkbenchProjectHistoryLive } from "./project-history.js";

const userData = "C:/Workbench/UserData";

function historyDependencies(files: Map<string, Uint8Array> = new Map()) {
	return Layer.mergeAll(
		makeElectronAppTestLayer({ getPath: () => Effect.succeed(userData) }),
		makeLocalFilesTestLayer(files)
	);
}

it.effect("persists a bounded most-recent-first project list without duplicates", () =>
	Effect.gen(function* () {
		const history = yield* WorkbenchProjectHistory;
		for (let index = 0; index < 10; index += 1) {
			yield* history.record(`D:/Projects/Project${index}`);
		}
		yield* history.record("d:/projects/project5/");

		const recent = yield* history.recent();
		expect(recent).toHaveLength(8);
		expect(recent[0]).toEqual({
			projectName: "project5",
			projectRoot: "d:/projects/project5"
		});
		expect(
			recent.filter((project) => project.projectName.toLowerCase() === "project5")
		).toHaveLength(1);
		expect(recent.at(-1)?.projectName).toBe("Project2");
	}).pipe(Effect.provide(WorkbenchProjectHistoryLive), Effect.provide(historyDependencies()))
);

it.effect("treats a malformed local history as an empty recoverable preference", () => {
	const files = new Map([
		[join(userData, "project-history-v1.json"), new TextEncoder().encode("not-json")]
	]);
	return Effect.gen(function* () {
		const history = yield* WorkbenchProjectHistory;
		expect(yield* history.recent()).toEqual([]);
		yield* history.record("C:/Projects/Recovered");
		expect(yield* history.recent()).toEqual([
			{ projectName: "Recovered", projectRoot: "C:/Projects/Recovered" }
		]);
	}).pipe(
		Effect.provide(WorkbenchProjectHistoryLive),
		Effect.provide(historyDependencies(files))
	);
});
