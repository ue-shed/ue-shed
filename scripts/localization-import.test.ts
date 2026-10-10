import {
	mkdir,
	mkdtemp,
	readdir,
	rm,
	writeFile,
	readFile,
	symlink,
	stat,
	utimes
} from "node:fs/promises";
import { resolve, relative } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	LocalizationEvidenceNodeLive,
	defaultLocalizationLimits
} from "../packages/localization/dist/index.js";
import {
	importLocalizationFile,
	LocalizationImportSource,
	importLocalizationTarget,
	defaultLocalizationImportLimits
} from "../packages/game-text/src/localization-import.ts";
import { expectLocalizationImportMatchesParser } from "./localization-import-oracle.test-support.ts";
import { generateGameTextScale } from "./localization-scale-data.ts";
import { SharedIndex, sharedIndexNodeLayer } from "../packages/game-text/src/shared-index.ts";

let temporary: string;
beforeAll(async () => {
	await mkdir(resolve("test-results/localization-import"), { recursive: true });
	temporary = await mkdtemp(resolve("test-results/localization-import/test-"));
});
afterAll(async () => {
	if (temporary) await rm(temporary, { recursive: true, force: true });
});
async function localizationFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = resolve(root, entry.name);
		if (entry.isDirectory()) files.push(...(await localizationFiles(path)));
		else if (/\.(manifest|archive|po)$/u.test(entry.name)) files.push(path);
	}
	return files;
}
function request(relativePath: string, format: "manifest" | "archive" | "po", extras = {}) {
	return {
		projectRoot: temporary,
		relativePath,
		format,
		cacheRoot: resolve(temporary, "cache"),
		...extras
	};
}
const utf16 = (text: string) =>
	Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, "utf16le")]);
const manifest = JSON.stringify({
	FormatVersion: 1,
	Namespace: "",
	Children: [{ Source: { Text: "hello" }, Keys: [{ Key: "key", Path: "Content/Generated" }] }]
});

describe("localization snapshot parser oracle", () => {
	it("reuses unchanged local blocks after compaction and matches every refreshed PO entry", async () => {
		const file = "block-reuse.po";
		const text = Array.from(
			{ length: 20000 },
			(_, row) =>
				`msgctxt "namespace,key-${row}"\nmsgid "source-${row}-${"text".repeat(45)}"\nmsgstr "source-${row}-${"text".repeat(45)}"\n`
		).join("\n");
		const options = request(file, "po", { cacheRoot: resolve(temporary, "block-cache") });
		await writeFile(resolve(temporary, file), text);
		await Effect.runPromise(importLocalizationFile(options));
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const index = yield* SharedIndex;
					const writer = yield* index.writer();
					yield* writer.compact(true);
				})
			).pipe(
				Effect.provide(
					sharedIndexNodeLayer({
						cacheRoot: options.cacheRoot,
						projectKey: resolve(temporary),
						targetKey: "localization"
					})
				)
			)
		);
		await writeFile(resolve(temporary, file), text.replace("source-0-", "Source-0-"));
		const refreshed = await expectLocalizationImportMatchesParser(options);
		expect(refreshed.parsed).toBe(true);
		expect(refreshed.lookupStrings).toBe(1);
		expect(refreshed.reusedStrings).toBeGreaterThan(39000);
	}, 60000);
	it("matches every committed manifest, archive and PO fixture, including UE 5.7/5.8 outputs", async () => {
		const root = resolve(".");
		const files = await localizationFiles(resolve("fixtures"));
		expect(files.length).toBeGreaterThanOrEqual(21);
		for (const path of files) {
			const format = path.endsWith(".manifest")
				? "manifest"
				: path.endsWith(".archive")
					? "archive"
					: "po";
			await expectLocalizationImportMatchesParser({
				projectRoot: root,
				relativePath: relative(root, path),
				format,
				poFormat: "Unreal",
				cacheRoot: resolve(temporary, "fixtures-cache"),
				chunkBytes: 7
			});
		}
	}, 60000);
	it.each([0.0001, 0.001])(
		"matches every generated localization file at scale %s",
		async (scale) => {
			const root = resolve(temporary, `tiny-${scale}`);
			await generateGameTextScale({ root, scale, seed: 57 });
			for (const path of await localizationFiles(root)) {
				const format = path.endsWith(".manifest")
					? "manifest"
					: path.endsWith(".archive")
						? "archive"
						: "po";
				await expectLocalizationImportMatchesParser({
					projectRoot: root,
					relativePath: relative(root, path),
					format,
					poFormat: "Unreal",
					cacheRoot: resolve(temporary, "tiny-cache")
				});
			}
		},
		60000
	);
	it.each([1, 2, 3, 5, 17])(
		"handles UTF-16 BOM, escapes, nesting, duplicate identities and split surrogate pairs at %s bytes",
		async (chunkBytes) => {
			const text =
				'{"FormatVersion":1,"Subnamespaces":[{"Children":[{"Keys":[{"Key":"z","Path":"p","Optional":false,"MetaData":{"Info":{"Comment":"note"}},"DevNotes":""},{"Key":"a","Path":"q"}],"Source":{"Text":"🌏 \\uD83D\\uDE00 \\n\\t\\\\\\\"","Tags":[1,{"x":true}]}}],"Namespace":""},{"Namespace":"b","Children":[{"Source":{"Text":"x"},"Keys":[{"Key":"a","Path":"p"},{"Key":"a","Path":"q"}]}]}],"Namespace":"parent"}';
			const file = `split-${chunkBytes}.manifest`;
			await writeFile(resolve(temporary, file), utf16(text));
			await expectLocalizationImportMatchesParser(request(file, "manifest", { chunkBytes }));
		}
	);
	it("preserves complete archive source/translation objects, metadata and optional absence", async () => {
		const file = "objects.archive";
		await writeFile(
			resolve(temporary, file),
			utf16(
				JSON.stringify({
					FormatVersion: 2,
					Namespace: "",
					Subnamespaces: [
						{
							Namespace: "a",
							Children: [
								{
									Key: "key",
									Source: { Text: "hello 🌏", Extra: { n: 1 } },
									Translation: { Text: "world", Extra: false },
									Optional: true,
									MetaData: {}
								}
							]
						}
					]
				})
			)
		);
		await expectLocalizationImportMatchesParser(request(file, "archive", { chunkBytes: 1 }));
	});
	it.each([1, 2, 3, 7])(
		"preserves PO BOM, CRLF, comments, flags, continuations, plurals and U+2028 at %s bytes",
		async (chunkBytes) => {
			const file = `inline-${chunkBytes}.po`;
			await writeFile(
				resolve(temporary, file),
				'\uFEFFmsgid ""\r\nmsgstr "Header: generated\\n"\r\n\r\n# translator\r\n#. note\r\n#: Content/Generated\r\n#, fuzzy, format\r\n#| msgid "old"\r\nmsgctxt "a\\,b,key"\r\nmsgid "🌏 \u2028"\r\n"continued\\n"\r\nmsgid_plural "plural"\r\nmsgstr[0] "translated"\r\nmsgstr[1] "plural translated"\r\n\r\nmsgid "unidentified"\r\nmsgstr ""\r\n'
			);
			await expectLocalizationImportMatchesParser(request(file, "po", { chunkBytes }));
		}
	);
	it.each(["Unreal", "Crowdin", undefined] as const)(
		"matches PO source-presence and identity semantics for %s",
		async (poFormat) => {
			const file = `format-${poFormat ?? "auto"}.po`;
			await writeFile(
				resolve(temporary, file),
				'msgid "a,key"\nmsgstr "source"\n\nmsgid ""\nmsgstr "X-Crowdin-SourceKey: msgstr\\n"\n'
			);
			await expectLocalizationImportMatchesParser(
				request(file, "po", poFormat ? { poFormat } : {})
			);
		}
	);
	it("keeps empty inputs and source/translation domains valid", async () => {
		await writeFile(
			resolve(temporary, "empty.manifest"),
			utf16('{"FormatVersion":1,"Namespace":""}')
		);
		await writeFile(resolve(temporary, "empty.po"), "");
		await expectLocalizationImportMatchesParser(request("empty.manifest", "manifest"));
		await expectLocalizationImportMatchesParser(request("empty.po", "po"));
	});
	it("keeps flattened duplicate order when subnamespaces precede root children", async () => {
		const file = "reordered.manifest";
		await writeFile(
			resolve(temporary, file),
			utf16(
				JSON.stringify({
					FormatVersion: 1,
					Subnamespaces: [
						{
							Namespace: "",
							Children: [
								{
									Source: { Text: "child" },
									Keys: [{ Key: "same", Path: "child" }]
								}
							]
						}
					],
					Children: [{ Source: { Text: "root" }, Keys: [{ Key: "same", Path: "root" }] }],
					Namespace: ""
				})
			)
		);
		await expectLocalizationImportMatchesParser(request(file, "manifest", { chunkBytes: 3 }));
	});
	it("resolves a late Crowdin header across spilled source blocks", async () => {
		const file = "late-header.po";
		const entries = Array.from(
			{ length: 500 },
			(_, index) => `msgid "namespace,${"x".repeat(600)}${index}"\nmsgstr "translation"\n\n`
		).join("");
		await writeFile(
			resolve(temporary, file),
			entries + 'msgid ""\nmsgstr "X-Crowdin-SourceKey: msgstr\\n"\n'
		);
		await expectLocalizationImportMatchesParser(request(file, "po"));
	});
});

describe("localization import cache and failures", () => {
	it("reuses an implicit translation's old source ID when only the source changes", async () => {
		const file = "derived-translation.po";
		await writeFile(resolve(temporary, file), 'msgctxt "n,k"\nmsgid "one"\nmsgstr "one"\n');
		const input = request(file, "po", { poFormat: "Unreal" as const });
		await expectLocalizationImportMatchesParser(input);
		await writeFile(resolve(temporary, file), 'msgctxt "n,k"\nmsgid "two"\nmsgstr "one"\n');
		const refreshed = await expectLocalizationImportMatchesParser(input);
		expect(refreshed.lookupStrings).toBe(1);
		expect(refreshed.reusedStrings).toBeGreaterThan(0);
	});
	it("diffs by identity across reordering, insertion and deletion, retaining GUID case", async () => {
		const file = "identity-diff.po";
		const row = (key: string, source: string) =>
			`msgctxt "Namespace,${key}"\nmsgid "${source}"\nmsgstr "translated"\n\n`;
		const keys = [
			"0123456789abcdefABCDEF0123456789ab",
			"abcdef0123456789ABCDEF0123456789ab",
			"removed"
		];
		await writeFile(
			resolve(temporary, file),
			keys.map((key, i) => row(key, `source-${i}`)).join("")
		);
		const input = request(file, "po", { poFormat: "Unreal" as const });
		const first = await expectLocalizationImportMatchesParser(input);
		expect(first.reusedStrings).toBe(0);
		await writeFile(
			resolve(temporary, file),
			row(keys[1]!, "source-1") + row(keys[0]!, "source-0!") + row("new", "new-source")
		);
		const refreshed = await expectLocalizationImportMatchesParser(input);
		expect(refreshed.lookupStrings).toBe(3);
		expect(refreshed.reusedStrings).toBeGreaterThan(3);
		expect(refreshed.parsed).toBe(true);
		const statHit = await Effect.runPromise(importLocalizationFile(input));
		expect(statHit.lookupStrings).toBe(0);
		expect(statHit.statHit).toBe(true);
	});
	it("a second import does no parsing, and a one-byte change only reimports that file", async () => {
		const root = resolve(temporary, "refresh");
		await generateGameTextScale({ root, scale: 0.0001, seed: 57 });
		const run = () =>
			Effect.runPromise(
				importLocalizationTarget({
					projectRoot: root,
					cacheRoot: resolve(temporary, "refresh-cache"),
					targetName: "Generated"
				}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
			);
		const first = await run();
		expect(first.diagnostics).toEqual([]);
		expect(first.files).toHaveLength(21);
		expect(first.files.every((file) => file.parsed)).toBe(true);
		expect(first.profile?.workerCount).toBeGreaterThan(1);
		expect(first.profile?.probePasses).toBe(0);
		for (const file of first.files) {
			const checked = await expectLocalizationImportMatchesParser({
				projectRoot: root,
				cacheRoot: resolve(temporary, "refresh-cache"),
				relativePath: file.relativePath,
				format: file.format,
				sharedTargetKey: "Generated",
				poFormat: first.target.poFormat,
				collapseMode: first.target.collapseMode
			});
			expect(checked.statHit).toBe(true);
		}
		const second = await run();
		expect(second.files.map((file) => file.key)).toEqual(first.files.map((file) => file.key));
		expect(second.files.every((file) => !file.parsed)).toBe(true);
		const changed = first.files.find((file) => file.format === "po")!;
		const path = resolve(root, changed.relativePath);
		const bytes = await readFile(path);
		const index = bytes.indexOf(Buffer.from("Velora"));
		expect(index).toBeGreaterThan(0);
		bytes[index] = 78;
		await writeFile(path, bytes);
		const third = await run();
		expect(third.files.filter((file) => file.parsed).map((file) => file.relativePath)).toEqual([
			changed.relativePath
		]);
		expect(
			third.files.filter(
				(file) =>
					file.key !==
					first.files.find((old) => old.relativePath === file.relativePath)?.key
			)
		).toHaveLength(1);
	});
	it("keeps authored-file diagnostics and closes worker staging after a cold parser failure", async () => {
		const root = resolve(temporary, "cold-failure");
		await generateGameTextScale({ root, scale: 0.0001, seed: 57 });
		const file = "Content/Localization/Generated/en/Generated.po";
		await writeFile(resolve(root, file), 'msgid "source"\ninvalid syntax\n');
		const cacheRoot = resolve(temporary, "cold-failure-cache");
		const result = await Effect.runPromise(
			importLocalizationTarget({
				projectRoot: root,
				cacheRoot,
				targetName: "Generated"
			}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
		);
		expect(result.files).toHaveLength(20);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]!.error.code).toBe("malformed_po");
		expect(result.diagnostics[0]!.relativePath).toBe(file);
		expect(await readdir(resolve(cacheRoot, "localization-import-staging"))).toEqual([]);
	}, 60000);
	it("cancels cold worker preparation, cleans staging and releases the writer for retry", async () => {
		const root = resolve(temporary, "cold-cancel");
		await generateGameTextScale({ root, scale: 0.0001, seed: 57 });
		const cacheRoot = resolve(temporary, "cold-cancel-cache");
		const controller = new AbortController();
		const run = () =>
			importLocalizationTarget({
				projectRoot: root,
				cacheRoot,
				targetName: "Generated"
			}).pipe(Effect.provide(LocalizationEvidenceNodeLive));
		const pending = Effect.runPromiseExit(run(), { signal: controller.signal });
		await vi.waitFor(
			async () => {
				const target = (
					await readdir(resolve(cacheRoot, "localization-import-staging"))
				)[0];
				expect(target).toBeDefined();
				expect(
					(await readdir(resolve(cacheRoot, "localization-import-staging", target!)))
						.length
				).toBeGreaterThan(0);
			},
			{ timeout: 10000 }
		);
		controller.abort();
		expect((await pending)._tag).toBe("Failure");
		await vi.waitFor(
			async () => {
				expect(await readdir(resolve(cacheRoot, "localization-import-staging"))).toEqual(
					[]
				);
			},
			{ timeout: 10000 }
		);
		const retry = await Effect.runPromise(run());
		expect(retry.diagnostics).toEqual([]);
		expect(retry.files).toHaveLength(21);
		expect(retry.files.every((file) => file.parsed)).toBe(true);
	}, 60000);
	it("never invokes a tokenizer on unchanged input, even with limits too small to parse it", async () => {
		await writeFile(resolve(temporary, "reuse.manifest"), utf16(manifest));
		const first = await Effect.runPromise(
			importLocalizationFile(request("reuse.manifest", "manifest"))
		);
		const second = await Effect.runPromise(
			importLocalizationFile(
				request("reuse.manifest", "manifest", {
					limits: { ...defaultLocalizationImportLimits, maxRecordBytes: 1 }
				})
			)
		);
		expect(second.key).toBe(first.key);
		expect(second.parsed).toBe(false);
	});
	it("stat hits reuse without opening source, and rewrites discard parsing when the hash matches", async () => {
		const file = "stat-hit.manifest";
		const path = resolve(temporary, file);
		await writeFile(path, utf16(manifest));
		const opened: string[] = [];
		const native = LocalizationImportSource.defaultValue();
		const run = (extras = {}) =>
			Effect.runPromise(
				importLocalizationFile(request(file, "manifest", extras)).pipe(
					Effect.provideService(LocalizationImportSource, {
						open: async (value) => {
							opened.push(value);
							return native.open(value);
						}
					})
				)
			);
		const first = await run();
		const before = await stat(path);
		const again = await stat(path);
		const exact = await stat(path, { bigint: true });
		const records = await Promise.all(
			(await readdir(resolve(temporary, "cache/localization-file-stats"))).map(async (name) =>
				JSON.parse(
					await readFile(
						resolve(temporary, "cache/localization-file-stats", name),
						"utf8"
					)
				)
			)
		);
		const record = records.find(
			(value) => value.key === first.key && value.stamp.ino === String(exact.ino)
		);
		expect(record.stamp).toEqual({
			size: Number(exact.size),
			mtimeNs: String(exact.mtimeNs),
			ctimeNs: String(exact.ctimeNs),
			ino: String(exact.ino),
			dev: String(exact.dev)
		});
		expect(record.contentHash).toBe(first.contentHash);
		expect([again.ino, again.dev]).toEqual([before.ino, before.dev]);
		if (process.platform === "win32") expect(before.ino).toBeGreaterThan(0);
		opened.length = 0;
		const hit = await run();
		expect(hit.key).toBe(first.key);
		expect(opened).toEqual([]);
		await writeFile(path, utf16(manifest));
		const rewritten = await stat(path);
		expect([rewritten.ino, rewritten.dev]).toEqual([before.ino, before.dev]);
		expect([rewritten.mtimeMs, rewritten.ctimeMs]).not.toEqual([
			before.mtimeMs,
			before.ctimeMs
		]);
		const touched = await run({
			limits: { ...defaultLocalizationImportLimits, maxRecordBytes: 1 }
		});
		expect(touched.key).toBe(first.key);
		expect(touched.parsed).toBe(false);
		expect(opened).toEqual([path]);
	});
	it("detects a file changing during its single read and returns typed retry guidance", async () => {
		const file = "during-read.manifest";
		const path = resolve(temporary, file);
		await writeFile(path, utf16(manifest));
		const timestamp = (await stat(path)).mtime;
		const native = LocalizationImportSource.defaultValue();
		let reads = 0;
		const result = await Effect.runPromise(
			importLocalizationFile(request(file, "manifest", { chunkBytes: 7 })).pipe(
				Effect.provideService(LocalizationImportSource, {
					open: async (value) => {
						const handle = await native.open(value);
						return {
							...handle,
							read: async (...args) => {
								const result = await handle.read(...args);
								if (++reads === 1) {
									await writeFile(
										path,
										utf16(manifest.replace("hello", "world"))
									);
									await utimes(
										path,
										timestamp,
										new Date(timestamp.getTime() + 1000)
									);
								}
								return result;
							}
						};
					}
				}),
				Effect.result
			)
		);
		expect(reads).toBeGreaterThan(0);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			expect("code" in result.failure && result.failure.code).toBe("file_changed");
			expect("recovery" in result.failure && result.failure.recovery).toMatch(/retry/iu);
		}
		expect(await readdir(resolve(temporary, "cache/localization-import-staging"))).toEqual([]);
	});
	it("preserves source-equal translations, compact PO extras, key comments and reference ordering", async () => {
		const file = "compact.po";
		await writeFile(
			resolve(temporary, file),
			'#.  Key: key\n#.  note\n#:  /Game/Common/a\n#:  /Game/Common/b\nmsgctxt "a,key"\nmsgid "same"\nmsgstr "same"\n'
		);
		await expectLocalizationImportMatchesParser(request(file, "po", { poFormat: "Unreal" }));
	});

	it("keeps mixed path prefixes and string limits independent in each file", async () => {
		const file = "mixed-paths.po";
		await writeFile(
			resolve(temporary, file),
			'#: /Game/Common/a\nmsgctxt "a,key"\nmsgid "same"\nmsgstr "same"\n\n#: /Elsewhere/b\nmsgctxt "a,key2"\nmsgid "other"\nmsgstr "other"\n\n#: /Game/Common/c\nmsgctxt "a,key3"\nmsgid "third"\nmsgstr "third"\n'
		);
		await expectLocalizationImportMatchesParser(request(file, "po", { poFormat: "Unreal" }));
		const huge = "huge-prefix.manifest";
		await writeFile(
			resolve(temporary, huge),
			utf16(
				JSON.stringify({
					FormatVersion: 1,
					Namespace: "",
					Children: [
						{
							Source: { Text: "x" },
							Keys: [{ Key: "key", Path: "/" + "x".repeat(1024 * 1024) + "/tail" }]
						}
					]
				})
			)
		);
		const result = await Effect.runPromise(
			importLocalizationFile(request(huge, "manifest")).pipe(Effect.result)
		);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure")
			expect("code" in result.failure && result.failure.code).toBe("limit_exceeded");
	});

	it("separates importer options in the content key", async () => {
		await writeFile(
			resolve(temporary, "options.po"),
			'msgctxt "a,key"\nmsgid "b,key"\nmsgstr "translated"\n'
		);
		const unreal = await Effect.runPromise(
			importLocalizationFile(request("options.po", "po", { poFormat: "Unreal" }))
		);
		const crowdin = await Effect.runPromise(
			importLocalizationFile(request("options.po", "po", { poFormat: "Crowdin" }))
		);
		expect(unreal.contentHash).toBe(crowdin.contentHash);
		expect(unreal.key).not.toBe(crowdin.key);
	});
	it.each([
		[
			"syntax.manifest",
			"manifest",
			utf16('{"FormatVersion":1,"Namespace":"",}'),
			"malformed_json"
		],
		[
			"schema.archive",
			"archive",
			utf16('{"FormatVersion":2,"Namespace":"","Children":[{}]}'),
			"invalid_schema"
		],
		[
			"version.manifest",
			"manifest",
			utf16('{"FormatVersion":9,"Namespace":""}'),
			"unsupported_version"
		],
		[
			"null-node.manifest",
			"manifest",
			utf16('{"FormatVersion":1,"Namespace":"","Subnamespaces":[null]}'),
			"invalid_schema"
		],
		["encoding.po", "po", Buffer.from([0xff]), "invalid_encoding"],
		["odd.manifest", "manifest", Buffer.from([255, 254, 65]), "invalid_encoding"],
		["utf16.po", "po", utf16('msgid "x"\nmsgstr "y"\n'), "invalid_encoding"],
		[
			"precedence.manifest",
			"manifest",
			utf16('{"FormatVersion":1,"Namespace":"","Children":[{}]} trailing'),
			"malformed_json"
		],
		[
			"version-first.manifest",
			"manifest",
			utf16('{"FormatVersion":9,"Children":[{}]}'),
			"unsupported_version"
		],
		[
			"bad.po",
			"po",
			Buffer.from('msgid "good"\r\nmsgstr "ok"\r\n\r\nmsgctxt "key"\r\ninvalid syntax\r\n'),
			"malformed_po"
		]
	] as const)(
		"returns typed %s failures with file and position",
		async (file, format, bytes, code) => {
			await writeFile(resolve(temporary, file), bytes);
			const result = await Effect.runPromise(
				importLocalizationFile(request(file, format, { chunkBytes: 1 })).pipe(Effect.result)
			);
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				expect("code" in result.failure && result.failure.code).toBe(code);
				expect(result.failure.message).toContain(file);
				if (code === "malformed_po") expect(result.failure.message).toContain("line 5");
			}
		}
	);
	it.each([
		"maxFileBytes",
		"maxEntries",
		"maxDepth",
		"maxRecordBytes",
		"maxIdentityBytes"
	] as const)("bounds %s independently and cleans staging after failure", async (limit) => {
		const file = `limit-${limit}.manifest`;
		const text = JSON.stringify({
			FormatVersion: 1,
			Namespace: "root",
			Children: [
				{
					Source: { Text: "hello" },
					Keys: [
						{ Key: "a", Path: "p" },
						{ Key: "b", Path: "p" }
					]
				}
			]
		});
		await writeFile(resolve(temporary, file), utf16(text));
		const result = await Effect.runPromise(
			importLocalizationFile(
				request(file, "manifest", {
					limits: { ...defaultLocalizationImportLimits, [limit]: 1 }
				})
			).pipe(Effect.result)
		);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure")
			expect("code" in result.failure && result.failure.code).toBe("limit_exceeded");
		expect(await readdir(resolve(temporary, "cache/localization-import-staging"))).toEqual([]);
	});
	it("preserves current reader defaults and rejects traversal, missing and symlink escapes", async () => {
		expect(defaultLocalizationLimits.maxFileBytes).toBe(320 * 1024 ** 2);
		expect(defaultLocalizationLimits.maxEntries).toBe(1_000_000);
		for (const [file, code] of [
			["../outside.manifest", "unsafe_path"],
			["missing.manifest", "file_missing"]
		]) {
			const result = await Effect.runPromise(
				importLocalizationFile(request(file!, "manifest")).pipe(Effect.result)
			);
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure")
				expect("code" in result.failure && result.failure.code).toBe(code);
		}
		const isolated = resolve(temporary, "isolated");
		await mkdir(isolated);
		await symlink(temporary, resolve(isolated, "escape"), "junction");
		const result = await Effect.runPromise(
			importLocalizationFile({
				...request("escape/reuse.manifest", "manifest"),
				projectRoot: isolated
			}).pipe(Effect.result)
		);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure")
			expect("code" in result.failure && result.failure.code).toBe("unsafe_path");
	});
});
