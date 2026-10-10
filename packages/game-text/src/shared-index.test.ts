import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { encodeStringBlock, decodeStringBlock } from "./snapshot-format.js";
import { maximumSharedSegments } from "./shared-string-file.js";
import { snapshotColumnsSource } from "./snapshot-file.js";
import {
	SharedIndex,
	sharedIndexNodeLayer,
	sharedIndexDirectory,
	retireSharedIndexFiles
} from "./shared-index.js";
import type { SnapshotStoreOptions } from "./snapshot-store.js";

const temporary: string[] = [];
afterEach(async () => {
	for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function setup(extras: Partial<SnapshotStoreOptions> = {}) {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-shared-"));
	temporary.push(root);
	const options = { cacheRoot: root, projectKey: "invented", targetKey: "text", ...extras };
	return {
		options,
		run: <A, E>(effect: Effect.Effect<A, E, SharedIndex>) =>
			Effect.runPromise(effect.pipe(Effect.provide(sharedIndexNodeLayer(options))))
	};
}
function source(values: string[], domain = "source") {
	return snapshotColumnsSource([
		{
			name: `${domain}.b0`,
			kind: "strings",
			domain,
			stringCount: values.length,
			values: encodeStringBlock(values)
		},
		{ name: `${domain}.starts`, kind: "u32", values: Uint32Array.of(0) },
		{
			name: "entry.source",
			kind: "stringIds",
			domain,
			stringCount: values.length,
			values: Uint32Array.from(values, (_, id) => id)
		}
	]);
}

describe("shared project string index", () => {
	it("uses segment ranks, probes multiple segments and returns exact folder ranges", async () => {
		const { run } = await setup();
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					yield* writer.publish(
						"a",
						"a",
						source(["/Game/B/2", "/Game/A/1", "/Game/A/2", "é"])
					);
					yield* writer.publish("b", "b", source(["/Game/A/1", "/Game/A/3", "😀"]));
					const index = yield* store.open(),
						a = yield* index.layer("a");
					expect(Array.from(yield* a.section("entry.source"))).toEqual([2, 0, 1, 3]);
					const ranges = yield* index.range("/Game/A/");
					const ids = ranges.flatMap(({ start, end }) =>
						Array.from({ length: end - start }, (_, row) => start + row)
					);
					expect((yield* index.strings(ids)).sort()).toEqual([
						"/Game/A/1",
						"/Game/A/2",
						"/Game/A/3"
					]);
					const generation = index.manifest.generation;
					yield* writer.compact(true);
					expect(writer.manifest().segments).toHaveLength(1);
					expect(writer.manifest().generation).not.toBe(generation);
					expect(yield* index.strings([0, 1, 2, 3])).toEqual([
						"/Game/A/1",
						"/Game/A/2",
						"/Game/B/2",
						"é"
					]);
					const compacted = yield* store.open(),
						b = yield* compacted.layer("b");
					expect(
						yield* b.strings("source", Array.from(yield* b.section("entry.source")))
					).toEqual(["/Game/A/1", "/Game/A/3", "😀"]);
					const domains = yield* compacted.domain("source");
					for (const domain of domains) {
						const block = decodeStringBlock(
							domain.bytes.subarray(domain.blockOffsets[0], domain.blockOffsets[1])
						);
						expect(block.string(0)).toBe(domain.string(0));
					}
				})
			)
		);
	});
	it("compacts at the segment ceiling before another publication", async () => {
		const { run } = await setup();
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer(),
						generation = writer.manifest().generation;
					for (let i = 0; i <= maximumSharedSegments; i++) {
						yield* writer.publish(`file-${i}`, `key-${i}`, source([`value-${i}`]));
						expect(writer.manifest().segments.length).toBeLessThanOrEqual(
							maximumSharedSegments
						);
					}
					expect(writer.manifest().generation).not.toBe(generation);
					expect(writer.manifest().segments).toHaveLength(2);
					const index = yield* store.open(),
						layer = yield* index.layer("file-0");
					expect(
						yield* layer.strings(
							"source",
							Array.from(yield* layer.section("entry.source"))
						)
					).toEqual(["value-0"]);
				})
			)
		);
	}, 30000);
	it("reuses a prior file mapping and probes only changed strings", async () => {
		const { run } = await setup();
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const writer = yield* (yield* SharedIndex).writer();
					yield* writer.publish("same-path", "v1", source(["alpha", "beta", "gamma"]));
					const before = writer.metrics();
					yield* writer.publish("same-path", "v2", source(["gamma", "beta!", "alpha"]));
					expect(writer.metrics().lookupStrings - before.lookupStrings).toBe(1);
					expect(writer.metrics().reusedStrings - before.reusedStrings).toBe(2);
					const store = yield* SharedIndex,
						index = yield* store.open(),
						layer = yield* index.layer("same-path");
					expect(
						yield* layer.strings(
							"source",
							Array.from(yield* layer.section("entry.source"))
						)
					).toEqual(["gamma", "beta!", "alpha"]);
					const reused = writer.metrics();
					yield* writer.publish("same-path", "v3", source(["alpha", "beta!", "gamma"]));
					expect(writer.metrics().lookupStrings - reused.lookupStrings).toBe(0);
					expect(writer.metrics().reusedStrings - reused.reusedStrings).toBe(3);
				})
			)
		);
	});
	it("keeps three-letter, numeric-region and script cultures in lazy ownership domains", async () => {
		const { run } = await setup();
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					for (const culture of ["fil", "es-419", "sr-Latn-RS"]) {
						yield* writer.publish(
							`localization/${culture}/text.po`,
							culture,
							source([`${culture} text`], "translation")
						);
						const index = yield* store.open();
						const owned = yield* index.domain(`culture.${culture}`);
						expect(
							owned.flatMap((domain) =>
								Array.from({ length: domain.count }, (_, id) => domain.string(id))
							)
						).toEqual([`${culture} text`]);
					}
				})
			)
		);
	});
	it("bounds resident writer heap after publishing multiple string segments", async () => {
		const { options } = await setup();
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--expose-gc",
				"--max-old-space-size=512",
				fileURLToPath(new URL("./shared-string-memory.test-support.ts", import.meta.url)),
				options.cacheRoot
			],
			{ stdio: ["ignore", "pipe", "pipe"] }
		);
		let output = "",
			errors = "";
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			errors += String(chunk);
		});
		const watchdog = setTimeout(() => child.kill("SIGKILL"), 15000);
		try {
			await new Promise<void>((done, fail) => {
				child.once("error", fail);
				child.once("close", (code) => (code === 0 ? done() : fail(new Error(errors))));
			});
			const result = JSON.parse(output);
			expect(result.strings).toBe(500000);
			expect(result.segments).toBeGreaterThan(1);
			expect(result.retainedGrowth).toBeLessThan(64 * 1024 ** 2);
		} finally {
			clearTimeout(watchdog);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	}, 20000);
	it("validates a file cache entry alone and rebuilds a missing entry with the same content key", async () => {
		const { run, options } = await setup();
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					const manifest = yield* writer.publish(
						"manifest",
						"manifest",
						source(["identity"])
					);
					const po = yield* writer.publish("po", "content", source(["translation"]));
					yield* Effect.promise(() =>
						rm(join(sharedIndexDirectory(options), manifest.file))
					);
					expect(yield* store.cached("content")).toEqual(po);
					yield* Effect.promise(() => rm(join(sharedIndexDirectory(options), po.file)));
					expect((yield* store.cached("content").pipe(Effect.result))._tag).toBe(
						"Failure"
					);
					const rebuilt = yield* writer.publish("po", "content", source(["translation"]));
					expect(rebuilt.file).not.toBe(po.file);
					expect(yield* store.cached("content")).toEqual(rebuilt);
				})
			)
		);
	});
	it("keeps distinct strings whose content hashes have the same 32-bit prefix", async () => {
		const hashes = new Map<number, string>();
		let pair: string[] | undefined;
		for (let i = 0; i < 300000 && !pair; i++) {
			const value = `collision-${i}`,
				hash = createHash("sha256").update(value).digest().readUInt32LE(0);
			const old = hashes.get(hash);
			if (old) pair = [old, value];
			else hashes.set(hash, value);
		}
		if (!pair) throw new Error("Deterministic collision absent");
		const values = pair;
		const { run } = await setup();
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					yield* writer.publish("a", "first", source([values[0]!]));
					yield* writer.publish("b", "second", source(values));
					expect(
						writer.manifest().segments.reduce((n, segment) => n + segment.count, 0)
					).toBe(2);
					const index = yield* store.open(),
						layer = yield* index.layer("b");
					expect(
						yield* index.strings(Array.from(yield* layer.section("entry.source")))
					).toEqual(values);
				})
			)
		);
	});
	it("automatically compacts when obsolete bytes exceed the size and ratio thresholds", async () => {
		const { run } = await setup();
		const values = Array.from(
			{ length: 10 },
			(_, index) => `${index}${"invented".repeat(128000)}`
		);
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					yield* writer.publish("po", "old", source(values));
					const generation = writer.manifest().generation;
					const before = writer.metrics();
					yield* writer.publish("po", "new", source(["replacement"]));
					expect(writer.manifest().generation).not.toBe(generation);
					expect(writer.metrics().readBytes).toBeGreaterThan(before.readBytes);
					expect(writer.metrics().appendedBytes).toBeGreaterThan(before.appendedBytes);
					expect(
						writer.manifest().segments.reduce((n, segment) => n + segment.count, 0)
					).toBe(1);
				})
			)
		);
	});
	it("does not compact strings still referenced by another layer when the upper bound crosses", async () => {
		const { run } = await setup();
		const values = Array.from(
			{ length: 10 },
			(_, index) => `${index}${"invented".repeat(128000)}`
		);
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					yield* writer.publish("archive", "archive", source(values));
					yield* writer.publish("po", "po", source(values));
					const generation = writer.manifest().generation;
					yield* writer.publish("po", "replacement", source(["replacement"]));
					expect(writer.manifest().generation).toBe(generation);
					expect(writer.manifest().garbageUpperBytes).toBe(0);
					expect((yield* writer.compact()).compacted).toBe(false);
				})
			)
		);
	});
	it("recovers after a process dies at the compaction manifest boundary", async () => {
		const { run, options } = await setup();
		const generation = await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					yield* writer.publish("po", "a", source(["original"]));
					return writer.manifest().generation;
				})
			)
		);
		const child = fork(
			fileURLToPath(new URL("./shared-index-crash.test-support.ts", import.meta.url)),
			[options.cacheRoot],
			{ execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] }
		);
		try {
			await new Promise<void>((done, fail) => {
				child.once("message", () => done());
				child.once("error", fail);
				child.once("exit", (code) =>
					fail(new Error(`Compaction child exited early: ${code}`))
				);
			});
			await new Promise<void>((done) => {
				child.once("exit", () => done());
				child.kill("SIGKILL");
			});
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex;
					expect((yield* store.inspect()).generation).toBe(generation);
					const writer = yield* store.writer();
					expect((yield* writer.compact(true)).compacted).toBe(true);
				})
			)
		);
	});
	it("deduplicates across files and domains and publishes stable append-only IDs", async () => {
		const { run } = await setup();
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					yield* writer.publish("manifest", "a", source(["", "same", "first"]));
					const before = writer.manifest().segments;
					yield* writer.publish(
						"po",
						"b",
						source(["same", "new", "same", ""], "translation")
					);
					expect(writer.manifest().segments.slice(0, before.length)).toEqual(before);
					expect(writer.manifest().segments.reduce((n, s) => n + s.count, 0)).toBe(4);
					const index = yield* store.open();
					const a = yield* index.layer("manifest"),
						b = yield* index.layer("po");
					const aid = yield* a.section("entry.source"),
						bid = yield* b.section("entry.source");
					expect(aid[1]).toBe(bid[0]);
					expect(yield* index.strings(Array.from(bid))).toEqual([
						"same",
						"new",
						"same",
						""
					]);
				})
			)
		);
	});
	it("keeps old layers and unopened strings readable after compaction and retirement", async () => {
		const { run, options } = await setup();
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					yield* writer.publish("po", "old", source(["unused", "survives"]));
					const old = yield* store.open();
					yield* writer.publish("po", "new", source(["survives", "fresh"]));
					const before = writer.manifest().generation;
					const result = yield* writer.compact(true);
					expect(result.deadBytes).toBe(Buffer.byteLength("unused"));
					expect(writer.manifest().generation).not.toBe(before);
					expect(Object.keys(writer.manifest().layers)).toEqual(["new"]);
					yield* retireSharedIndexFiles(sharedIndexDirectory(options), writer.manifest());
					const oldLayer = yield* old.layer("po"),
						ids = yield* oldLayer.section("entry.source");
					expect(yield* old.strings(Array.from(ids))).toEqual(["unused", "survives"]);
					const current = yield* store.open(),
						layer = yield* current.layer("po");
					expect(
						yield* current.strings(Array.from(yield* layer.section("entry.source")))
					).toEqual(["survives", "fresh"]);
				})
			)
		);
	});
	it("an interrupted compaction leaves the prior generation visible and can be retried", async () => {
		let interrupt = false;
		const { run } = await setup({
			beforeRename: async (kind) => {
				if (interrupt && kind === "manifest") throw new Error("interrupted compaction");
			}
		});
		const generation = await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					yield* writer.publish("po", "a", source(["one", "two"]));
					return writer.manifest().generation;
				})
			)
		);
		interrupt = true;
		const failed = await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					return yield* writer.compact(true).pipe(Effect.result);
				})
			)
		);
		expect(failed._tag).toBe("Failure");
		interrupt = false;
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex;
					expect((yield* store.inspect()).generation).toBe(generation);
					const writer = yield* store.writer();
					expect((yield* writer.compact(true)).compacted).toBe(true);
				})
			)
		);
	});
	it("reuses a content key independently of the manifest layer and rejects concurrent writers", async () => {
		const { run } = await setup();
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					yield* writer.publish(
						"manifest",
						"manifest-old",
						source(["original manifest"])
					);
					yield* writer.publish("po", "hash", source(["standalone"]));
					const po = yield* store.cached("hash");
					yield* writer.publish("manifest", "manifest-new", source(["changed manifest"]));
					expect(yield* store.cached("hash")).toEqual(po);
					const before = writer.metrics().appendedBytes;
					const record = yield* writer.publish("other-po", "hash", { columns: [] });
					expect(record.key).toBe("hash");
					expect(writer.metrics().appendedBytes).toBe(before);
					expect((yield* store.writer().pipe(Effect.result))._tag).toBe("Failure");
					expect((yield* writer.compact()).compacted).toBe(false);
				})
			)
		);
	});
	it("uses a bounded sparse index on reopening and appends only the changed string", async () => {
		const { run } = await setup();
		const values = Array.from({ length: 20000 }, (_, i) => `invented-${i}`);
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					yield* writer.publish("po", "a", source(values));
				})
			)
		);
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					yield* writer.publish("po", "b", source([values[113]!, "changed"]));
					expect(writer.manifest().segments.at(-1)?.count).toBe(1);
					expect(writer.metrics().indexReadBytes).toBeLessThan(20000 * 8);
				})
			)
		);
	});
	it("rejects corrupt segment blocks and use after reader scope closes", async () => {
		const { run, options } = await setup();
		const { manifest, escaped } = await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					yield* writer.publish("po", "a", source(["hello"]));
					const escaped = yield* store.open();
					return { manifest: writer.manifest(), escaped };
				})
			)
		);
		expect((await Effect.runPromise(escaped.strings([0]).pipe(Effect.result)))._tag).toBe(
			"Failure"
		);
		const path = join(sharedIndexDirectory(options), manifest.segments[0]!.file);
		const bytes = await readFile(path);
		bytes[bytes.length - 4]! ^= 1;
		await writeFile(path, bytes);
		const failed = await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex,
						writer = yield* store.writer();
					return yield* writer.publish("po", "b", source(["hello"])).pipe(Effect.result);
				})
			)
		);
		expect(failed._tag).toBe("Failure");
	});
});
