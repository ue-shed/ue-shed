import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { afterEach, expect } from "vitest";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";

const fixture = resolve("fixtures/unreal-project");
const reviewPath = "Config/UEShed/Localization/FixtureGame.review.json";
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project() {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-cli-review-"));
	roots.push(root);
	for (const path of ["Config/DefaultEditor.ini", "Config/Localization", "Content/Localization"])
		await cp(join(fixture, path), join(root, path), { recursive: true });
	return root;
}

const review = (...args: string[]) =>
	Effect.gen(function* () {
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
		yield* runCli(["loc", "review", ...args]).pipe(Effect.provide(runtime));
		return { text: yield* Ref.get(output), code: yield* Ref.get(exitCode) };
	});

const line = "Fixture.Localization.Table,NamedArgument";

it.effect("loc review sets, merges and clears flags in a sorted review file", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(project);
		const base = [
			"--target",
			"FixtureGame",
			"--culture",
			"de",
			"--line",
			line,
			"--by",
			"tester"
		];
		const set = yield* review("set", root, ...base, "--flag", "reviewed");
		expect(set.code).toBe(0);
		expect(set.text).toContain('"status": "written"');
		yield* review("set", root, ...base, "--flag", "proofread");
		const file = yield* Effect.promise(() => readFile(join(root, reviewPath), "utf8"));
		expect(file).toContain('"key": "NamedArgument"');
		expect(file).toMatch(/"flags": \[\s*"reviewed",\s*"proofread"\s*\]/u);
		expect(file).toContain('"by": "tester"');
		expect(file.endsWith("}\n")).toBe(true);
		yield* review("clear", root, ...base);
		const cleared = yield* Effect.promise(() => readFile(join(root, reviewPath), "utf8"));
		expect(cleared).toContain('"records": []');
	})
);

it.effect("loc review accepts findings and rejects lines that are not gathered", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(project);
		const accepted = yield* review(
			"accept",
			root,
			"--target",
			"FixtureGame",
			"--culture",
			"de",
			"--check",
			"localization.format_arguments",
			"--line",
			line
		);
		expect(accepted.code).toBe(0);
		expect(accepted.text).toContain('"acceptedFindings": 1');
		const missing = yield* review(
			"set",
			root,
			"--target",
			"FixtureGame",
			"--culture",
			"de",
			"--flag",
			"reviewed",
			"--line",
			"Fixture.Localization.Table,AddedAfterGather"
		);
		expect(missing.code).toBe(2);
		expect(missing.text).toContain('"code": "not_gathered"');
	})
);
