import { it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";
import { describe, expect } from "vitest";
import { LocalizationStatusReport } from "@ue-shed/game-text/browser";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();

describe.skipIf(!executable)("localization CLI with the real reader", () => {
	it.effect("status and text search share culture/state filtering and counts", () =>
		Effect.gen(function* () {
			if (executable === undefined) throw new Error("The saved reader is not configured.");
			const output = yield* Ref.make("");
			const exitCode = yield* Ref.make(0);
			const runtime = Layer.succeed(
				CliRuntime,
				CliRuntime.of({
					print: (text) => Ref.update(output, (value) => value + text),
					printError: () => Effect.void,
					setExitCode: (code) => Ref.set(exitCode, code)
				})
			);
			const flags = [
				"--target",
				"FixtureGame",
				"--culture",
				"de",
				"--state",
				"gathered_only",
				"--limit",
				"1",
				"--reader",
				executable
			];
			yield* runCli(["loc", "status", fixture.root, ...flags]).pipe(Effect.provide(runtime));
			const status = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(LocalizationStatusReport)
			)(yield* Ref.get(output));
			expect(status.page.total).toBe(2);
			expect(status.page.localization?.lines).toHaveLength(1);
			expect(
				status.counts.find((count) => count.culture === "de")?.states.gathered_only.lines
			).toBe(2);
			yield* Ref.set(output, "");
			yield* runCli(["text", "search", fixture.root, "Ready", ...flags]).pipe(
				Effect.provide(runtime)
			);
			const search = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(LocalizationStatusReport)
			)(yield* Ref.get(output));
			expect(search.page.total).toBe(1);
			expect(
				search.counts.find((count) => count.culture === "de")?.states.gathered_only.lines
			).toBe(1);
			expect(yield* Ref.get(exitCode)).toBe(0);
		})
	);
});
