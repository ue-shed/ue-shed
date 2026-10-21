import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import { expect } from "vitest";
import { createLocalizationBaseline } from "@ue-shed/game-text/corpus";
import { corpus, evidence } from "../../../packages/game-text/src/localization.test-support.js";
import {
	readLocalizationBaseline,
	writeLocalizationBaseline
} from "./workflows/localization-report.js";

it.effect("saves and reads a baseline exclusively, with typed safe IO and schema failures", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const directory = yield* fs.makeTempDirectoryScoped();
		const destination = join(directory, "baseline.json");
		const baseline = createLocalizationBaseline(corpus(), evidence(), "2026-10-07T00:00:00Z");
		yield* writeLocalizationBaseline(destination, baseline);
		expect(yield* readLocalizationBaseline(destination)).toEqual(baseline);
		const before = yield* fs.readFileString(destination);
		const existing = yield* writeLocalizationBaseline(destination, {
			...baseline,
			entries: []
		}).pipe(Effect.result);
		if (Result.isSuccess(existing)) throw new Error("Existing baseline was overwritten.");
		expect(existing.failure.code).toBe("baseline_exists");
		expect(yield* fs.readFileString(destination)).toBe(before);
		for (const name of [
			"Test.po",
			"Test.archive",
			"Test.locres",
			"Test.locmeta",
			"Test.manifest"
		]) {
			const rejected = yield* writeLocalizationBaseline(join(directory, name), baseline).pipe(
				Effect.result
			);
			if (Result.isSuccess(rejected))
				throw new Error("Unreal output was accepted as a baseline destination.");
			expect(rejected.failure.code).toBe("invalid_baseline_destination");
			expect(rejected.failure.message).not.toContain(directory);
		}
		const invalid = join(directory, "invalid.json");
		yield* fs.writeFileString(invalid, "{}");
		const decoded = yield* readLocalizationBaseline(invalid).pipe(Effect.result);
		if (Result.isSuccess(decoded)) throw new Error("An invalid baseline was accepted.");
		expect(decoded.failure.code).toBe("invalid_baseline");
		const missing = yield* readLocalizationBaseline(join(directory, "missing.json")).pipe(
			Effect.result
		);
		if (Result.isSuccess(missing)) throw new Error("A missing baseline was accepted.");
		expect(missing.failure.code).toBe("baseline_unreadable");
	}).pipe(Effect.provide(NodeServices.layer))
);
