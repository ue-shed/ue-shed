import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Deferred, Effect, Fiber, Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotStringTableBuilder, SnapshotFormatError } from "./snapshot-format.js";
import { snapshotColumnsSource } from "./snapshot-file.js";
import type { Scope } from "effect";
import {
	SnapshotStore,
	SnapshotStoreError,
	snapshotStoreNodeLayer,
	snapshotStoreDirectory,
	type SnapshotStoreOptions
} from "./snapshot-store.js";

let cacheRoot: string;
beforeEach(async () => {
	await mkdir(resolve("test-results/snapshot-tests"), { recursive: true });
	cacheRoot = await mkdtemp(resolve("test-results/snapshot-tests/cache-"));
});
afterEach(async () => {
	await rm(cacheRoot, { recursive: true, force: true });
});
const options = (): SnapshotStoreOptions => ({
	cacheRoot,
	projectKey: "test-project",
	targetKey: "test-target"
});
function raw(text: string) {
	const builder = snapshotStringTableBuilder();
	builder.intern(text);
	return snapshotColumnsSource([
		...builder.finish(),
		{
			name: "line.source",
			kind: "stringIds",
			values: new Uint32Array([0]),
			domain: "hot",
			stringCount: 1
		}
	]);
}
function run<A, E>(
	program: Effect.Effect<A, E, SnapshotStore | Scope.Scope>,
	configuration = options()
) {
	return Effect.runPromise(
		Effect.scoped(program).pipe(Effect.provide(snapshotStoreNodeLayer(configuration)))
	);
}
function publish(text: string) {
	return Effect.scoped(
		Effect.gen(function* () {
			const store = yield* SnapshotStore;
			const writer = yield* store.writer();
			return yield* writer.publish(raw(text), { source: text });
		})
	);
}
const reader = () =>
	Effect.gen(function* () {
		const store = yield* SnapshotStore;
		const value = yield* store.open();
		return (yield* value.strings("hot", [0]))[0]!;
	});
describe("snapshot store", () => {
	it("publishes a small validated manifest and keeps old readers across retirement", async () => {
		const first = await run(publish("old"));
		await run(
			Effect.gen(function* () {
				const store = yield* SnapshotStore;
				const old = yield* store.open(); // No blocks loaded before retirement.
				const second = yield* publish("new");
				expect(second.previousSnapshot).toBe(first.physicalSnapshot);
				yield* publish("newest");
				const files = yield* Effect.promise(() =>
					readdir(snapshotStoreDirectory(options()))
				);
				expect(files).not.toContain(first.physicalSnapshot);
				expect(files.filter((name) => name.endsWith(".snapshot"))).toHaveLength(2);
				expect(yield* old.strings("hot", [0])).toEqual(["old"]);
				expect((yield* old.domain("hot")).scanSubstring("OLD")).toBe(1);
				expect(yield* reader()).toBe("newest");
			})
		);
	});
	it("rejects the second writer cleanly, then releases the scoped lock", async () => {
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SnapshotStore;
					const writer = yield* store.writer();
					const second = yield* Effect.result(Effect.scoped(store.writer()));
					expect(Result.isFailure(second)).toBe(true);
					if (Result.isFailure(second)) {
						expect(second.failure).toBeInstanceOf(SnapshotStoreError);
						if (!(second.failure instanceof SnapshotStoreError)) throw second.failure;
						expect(second.failure.code).toBe("busy");
					}
					yield* writer.publish(raw("first"), {});
				})
			)
		);
		await run(publish("released"));
	});
	it("does not let an escaped writer publish after its scope closes", async () => {
		const writer = await run(
			Effect.scoped(Effect.flatMap(SnapshotStore, (store) => store.writer()))
		);
		const result = await Effect.runPromise(Effect.result(writer.publish(raw("escaped"), {})));
		expect(Result.isFailure(result)).toBe(true);
	});
	it("closes reader handles and rejects even cached columns after scope release", async () => {
		await run(publish("scoped"));
		const escaped = await run(
			Effect.gen(function* () {
				const store = yield* SnapshotStore;
				const value = yield* store.open();
				yield* value.section("line.source");
				return value;
			})
		);
		const result = await Effect.runPromise(Effect.result(escaped.section("line.source")));
		expect(Result.isFailure(result)).toBe(true);
		const strings = await Effect.runPromise(Effect.result(escaped.strings("hot", [0])));
		expect(Result.isFailure(strings)).toBe(true);
		const domain = await Effect.runPromise(Effect.result(escaped.domain("hot")));
		expect(Result.isFailure(domain)).toBe(true);
	});
	it("quarantines corruption found in a cold section during writer recovery", async () => {
		const value = await run(publish("cold data"));
		const { openSnapshotFile } = await import("./snapshot-file.js");
		const path = join(snapshotStoreDirectory(options()), value.physicalSnapshot);
		const file = await openSnapshotFile(path);
		const offset = file.directory.entries.get("hot.b0")!.offset;
		await file.close();
		const { open } = await import("node:fs/promises");
		const handle = await open(path, "r+");
		try {
			await handle.write(new Uint8Array([255]), 0, 1, offset);
		} finally {
			await handle.close();
		}
		await run(
			Effect.gen(function* () {
				const store = yield* SnapshotStore;
				const value = yield* store.open();
				expect(yield* value.section("line.source")).toEqual(new Uint32Array([0]));
				const result = yield* Effect.result(value.strings("hot", [0]));
				expect(Result.isFailure(result)).toBe(true);
			})
		);
		await run(publish("rebuilt"));
		expect(await run(reader())).toBe("rebuilt");
		expect(
			(await readdir(join(cacheRoot, "game-text-v1"))).some((name) =>
				name.includes("quarantine")
			)
		).toBe(true);
	});
	it("holds the writer lock until an interrupted publication finishes its file mutation", async () => {
		await run(publish("old"));
		const ready = await Effect.runPromise(Deferred.make<void>());
		const proceed = await Effect.runPromise(Deferred.make<void>());
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SnapshotStore;
					const publishing = yield* Effect.forkScoped(publish("candidate"));
					yield* Deferred.await(ready);
					const interrupting = yield* Effect.forkScoped(Fiber.interrupt(publishing));
					const second = yield* Effect.result(Effect.scoped(store.writer()));
					expect(Result.isFailure(second)).toBe(true);
					yield* Deferred.succeed(proceed, undefined);
					yield* Fiber.join(interrupting);
					const writer = yield* store.writer();
					yield* writer.publish(raw("after interruption"), {});
					expect(yield* reader()).toBe("after interruption");
				})
			),
			{
				...options(),
				beforeRename: (kind) =>
					kind === "manifest"
						? Effect.runPromise(
								Effect.gen(function* () {
									yield* Deferred.succeed(ready, undefined);
									yield* Deferred.await(proceed);
								})
							)
						: Promise.resolve()
			}
		);
	});
	it("requires reopening after an uncertain manifest publication", async () => {
		await run(publish("old"));
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SnapshotStore;
					const writer = yield* store.writer();
					const first = yield* Effect.result(writer.publish(raw("candidate"), {}));
					expect(Result.isFailure(first)).toBe(true);
					const next = yield* Effect.result(writer.publish(raw("retry"), {}));
					expect(Result.isFailure(next)).toBe(true);
					if (Result.isFailure(next)) expect(next.failure.message).toContain("uncertain");
				})
			),
			{
				...options(),
				beforeRename: async (kind) => {
					if (kind === "manifest") throw new Error("injected rename failure");
				}
			}
		);
		expect(await run(reader())).toBe("old");
		await run(publish("reopened"));
		expect(await run(reader())).toBe("reopened");
	});
	it.each(["snapshot", "manifest"] as const)(
		"preserves the old snapshot after failure before %s rename",
		async (point) => {
			await run(publish("old"));
			const outcome = await run(Effect.result(publish("interrupted")), {
				...options(),
				beforeRename: async (kind) => {
					if (kind === point) throw new Error("injected failure");
				}
			});
			expect(Result.isFailure(outcome)).toBe(true);
			expect(await run(reader())).toBe("old");
			await run(publish("recovered"));
			expect(await run(reader())).toBe("recovered");
			expect(
				(await readdir(snapshotStoreDirectory(options()))).some((name) =>
					name.endsWith(".tmp")
				)
			).toBe(false);
		}
	);
	it("a killed child leaves the old snapshot readable and its lock recoverable", async () => {
		await run(publish("old"));
		const environment = { ...process.env };
		delete environment.NODE_OPTIONS;
		environment.TSX_DISABLE_CACHE = "1";
		const child = fork(
			fileURLToPath(new URL("./snapshot-store-crash.test-support.ts", import.meta.url)),
			[cacheRoot],
			{
				execArgv: ["--import", "tsx", "--max-old-space-size=256"],
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				env: environment
			}
		);
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr = (stderr + String(chunk)).slice(-4096);
		});
		const closed = new Promise<void>((done) => {
			child.once("close", () => done());
		});
		try {
			await new Promise<void>((done, reject) => {
				child.once("message", () => done());
				child.once("error", reject);
				child.once("exit", () =>
					reject(new Error(`Child exited before checkpoint: ${stderr}`))
				);
			});
			expect(await run(reader())).toBe("old");
			const locked = await run(
				Effect.result(
					Effect.scoped(Effect.flatMap(SnapshotStore, (store) => store.writer()))
				)
			);
			expect(Result.isFailure(locked)).toBe(true);
			if (Result.isFailure(locked) && locked.failure instanceof SnapshotStoreError)
				expect(locked.failure.code).toBe("busy");
		} finally {
			child.kill("SIGKILL");
			await closed;
		}
		expect(await run(reader())).toBe("old");
		await run(publish("after crash"));
		expect(await run(reader())).toBe("after crash");
	}, 10000);
	it.each(["snapshot", "manifest", "missing", "oversized", "path", "name cap"])(
		"readers report %s damage; only writers quarantine and rebuild",
		async (kind) => {
			const value = await run(publish("old"));
			const directory = snapshotStoreDirectory(options());
			const path = join(directory, "manifest.json");
			if (kind === "snapshot")
				await writeFile(join(directory, value.physicalSnapshot), "damaged");
			if (kind === "manifest") await writeFile(path, "{");
			if (kind === "missing") await rm(join(directory, value.physicalSnapshot));
			if (kind === "oversized") await writeFile(path, " ".repeat(1024 * 1024 + 1));
			if (kind === "path")
				await writeFile(
					path,
					JSON.stringify({ ...value, physicalSnapshot: "../escape.snapshot" })
				);
			if (kind === "name cap")
				await writeFile(
					path,
					JSON.stringify({
						...value,
						physicalSnapshot: `snapshot-${"a".repeat(129)}.snapshot`
					})
				);
			const before = await readdir(join(cacheRoot, "game-text-v1"));
			const result = await run(Effect.result(reader()));
			expect(Result.isFailure(result)).toBe(true);
			if (Result.isFailure(result))
				expect(result.failure).toBeInstanceOf(SnapshotFormatError);
			expect(await readdir(join(cacheRoot, "game-text-v1"))).toEqual(before);
			await run(publish("rebuilt"));
			expect(await run(reader())).toBe("rebuilt");
			expect(
				(await readdir(join(cacheRoot, "game-text-v1"))).some((name) =>
					name.includes("quarantine")
				)
			).toBe(true);
		}
	);
	it("retains the on-disk manifest with its input keys", async () => {
		const value = await run(publish("key"));
		expect(
			JSON.parse(
				await readFile(join(snapshotStoreDirectory(options()), "manifest.json"), "utf8")
			)
		).toEqual(value);
		expect(value.inputKeys).toEqual({ source: "key" });
	});
	it("validates the store configuration before acquiring filesystem authority", async () => {
		const result = await run(
			Effect.result(
				reader().pipe(
					Effect.provide(snapshotStoreNodeLayer({ ...options(), targetKey: "" }))
				)
			)
		);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(SnapshotStoreError);
	});
});
