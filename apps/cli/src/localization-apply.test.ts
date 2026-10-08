import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";
import { afterEach, expect } from "vitest";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";

const fixture = resolve("fixtures/unreal-project");
const dePO = "Content/Localization/FixtureGame/de/FixtureGame.po";
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project() {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-cli-apply-"));
	roots.push(root);
	for (const path of ["Config/DefaultEditor.ini", "Config/Localization", "Content/Localization"])
		await cp(join(fixture, path), join(root, path), { recursive: true });
	return root;
}

const change = {
	target: "FixtureGame",
	culture: "de",
	namespace: "Fixture.Localization.Table",
	key: "NamedArgument",
	source: "Talking with {PlayerName}",
	previousTranslation: "Gespräch mit {Name}",
	translation: "Gespräch mit {PlayerName}"
};

const Line = Schema.fromJsonString(
	Schema.Struct({ type: Schema.String, receipt: Schema.optionalKey(Schema.Json) })
);

const apply = (root: string, changes: string, ...flags: string[]) =>
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
		yield* runCli(["loc", "apply", root, "--changes", changes, "--json", ...flags]).pipe(
			Effect.provide(runtime)
		);
		return { text: yield* Ref.get(output), code: yield* Ref.get(exitCode) };
	});

it.effect("loc apply reviews, writes only the PO msgstr, and rejects a stale re-apply", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(project);
		const changes = join(root, "changes.json");
		yield* Effect.promise(() =>
			writeFile(
				changes,
				JSON.stringify({
					schemaVersion: 1,
					provenance: { producer: "test", files: [] },
					changes: [change]
				})
			)
		);
		const before = yield* Effect.promise(() => readFile(join(root, dePO), "utf8"));

		const review = yield* apply(root, changes, "--review");
		expect(review.code).toBe(0);
		expect(review.text).toContain('"outcome":"ready"');
		expect(yield* Effect.promise(() => readFile(join(root, dePO), "utf8"))).toBe(before);

		const written = yield* apply(root, changes);
		expect(written.code).toBe(0);
		const receipt = yield* Schema.decodeUnknownEffect(Line)(written.text.trim());
		expect(receipt.type).toBe("receipt");
		expect(JSON.stringify(receipt.receipt)).toContain('"status":"written"');
		const after = yield* Effect.promise(() => readFile(join(root, dePO), "utf8"));
		expect(after).toBe(
			before.replace('msgstr "Gespräch mit {Name}"', 'msgstr "Gespräch mit {PlayerName}"')
		);

		const again = yield* apply(root, changes);
		expect(again.code).toBe(2);
		expect(again.text).toContain('"status":"rejected"');
		expect(again.text).toContain('"outcome":"stale_translation"');
	})
);

it.effect("loc apply reports an unreadable change set without echoing it", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(project);
		const changes = join(root, "broken.json");
		yield* Effect.promise(() => writeFile(changes, "{ not json: secret translation"));
		const result = yield* apply(root, changes);
		expect(result.code).toBe(2);
		expect(result.text).toContain('"code":"invalid_change_set"');
		expect(result.text).not.toContain("secret translation");
	})
);
