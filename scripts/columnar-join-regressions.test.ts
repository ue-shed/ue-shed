import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { parseManifest, parseArchive } from "../packages/localization/src/index.ts";
import { importLocalizationFile } from "../packages/game-text/src/localization-import.ts";
import { expect, it } from "vitest";
import { JoinFuzzInput, compareJoinFuzzInput } from "./columnar-join-fuzz.test-support.ts";
import { withJoinCache } from "./columnar-join.test-support.ts";

it.each(["lone-utf16-source"])(
	"%s preserves a source containing a lone UTF-16 code unit",
	async (name) => {
		const input = Schema.decodeUnknownSync(Schema.fromJsonString(JoinFuzzInput))(
			await readFile(
				new URL(`./test-fixtures/columnar-join/${name}.json`, import.meta.url),
				"utf8"
			)
		);
		await withJoinCache(async (cache) => {
			const differences = await compareJoinFuzzInput(input, cache, true);
			expect(differences, JSON.stringify(differences, null, 2)).toEqual([]);
		});
	}
);

it("lone-utf16-localization: both parsers reject the escaped surrogate as Unreal does", async () => {
	const input = Schema.decodeUnknownSync(Schema.fromJsonString(JoinFuzzInput))(
		await readFile(
			new URL("./test-fixtures/columnar-join/lone-utf16-localization.json", import.meta.url),
			"utf8"
		)
	);
	await withJoinCache(async (cache) => {
		for (const format of ["manifest", "archive"] as const) {
			const name = `Surrogate.${format}`;
			const entry = input.manifest[0]!;
			const text = JSON.stringify({
				FormatVersion: format === "manifest" ? 1 : 2,
				Namespace: entry.namespace,
				Children: [
					format === "manifest"
						? {
								Source: { Text: entry.source },
								Keys: [{ Key: entry.key, Path: entry.path }]
							}
						: {
								Key: entry.key,
								Source: { Text: entry.source },
								Translation: { Text: "Translation" }
							}
				]
			});
			const bytes = Buffer.from(text);
			await writeFile(join(cache, name), bytes);
			const parsed =
				format === "manifest"
					? parseManifest(bytes, undefined, name)
					: parseArchive(bytes, undefined, name);
			const indexed = await Effect.runPromise(
				importLocalizationFile({
					projectRoot: cache,
					cacheRoot: join(cache, "cache"),
					relativePath: name,
					format
				}).pipe(Effect.scoped, Effect.result)
			);
			for (const result of [parsed, indexed]) {
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure") {
					expect(result.failure).toMatchObject({ code: `malformed_${format}` });
					expect(result.failure.message).toContain(name);
					expect(result.failure.message).toContain("character offset");
					expect(result.failure.message).toContain(
						"Unreal Engine 5.7 and 5.8 cannot load"
					);
				}
			}
		}
	});
});
