import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import {
	createStarterTextRules,
	TextRulesFileError,
	decodeTextQualityRuleDocumentJson
} from "@ue-shed/game-text";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";

it.effect("text rules init creates the default file and refuses to overwrite it", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-text-rules-"))),
				(path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
			);
			const output = yield* Ref.make("");
			const errors = yield* Ref.make("");
			const code = yield* Ref.make(0);
			const runtime = Layer.succeed(
				CliRuntime,
				CliRuntime.of({
					print: (value) => Ref.update(output, (current) => current + value),
					printError: (value) => Ref.update(errors, (current) => current + value),
					setExitCode: (value) => Ref.set(code, value)
				})
			);
			yield* runCli(["text", "rules", "init", root]).pipe(Effect.provide(runtime));
			const path = join(root, "Config", "UEShed", "GameTextRules.json");
			expect((yield* Ref.get(output)).trim()).toBe(path);
			const original = yield* Effect.promise(() => readFile(path, "utf8"));
			yield* decodeTextQualityRuleDocumentJson(original);
			const cliFailure = yield* runCli(["text", "rules", "init", root]).pipe(
				Effect.provide(runtime),
				Effect.flip
			);
			expect(cliFailure._tag).toBe("CliCommandError");
			expect(cliFailure.message).toContain("already exists");
			expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(original);
			const failure = yield* createStarterTextRules(root).pipe(Effect.flip);
			expect(failure).toBeInstanceOf(TextRulesFileError);
			expect(failure.code).toBe("already_exists");
			expect(failure.recovery).toContain("never overwritten");
			const custom = join(root, "custom.json");
			yield* runCli(["text", "rules", "init", root, "--output", "custom.json"]).pipe(
				Effect.provide(runtime)
			);
			yield* decodeTextQualityRuleDocumentJson(
				yield* Effect.promise(() => readFile(custom, "utf8"))
			);
			yield* Effect.promise(() => writeFile(custom, "existing content"));
			expect((yield* createStarterTextRules(root, custom).pipe(Effect.flip)).code).toBe(
				"already_exists"
			);
			expect(yield* Effect.promise(() => readFile(custom, "utf8"))).toBe("existing content");
		})
	)
);
