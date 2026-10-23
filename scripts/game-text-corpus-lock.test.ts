import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { withCorpusUnrealLock } from "./game-text-corpus-lock.ts";

test("the corpus lease serializes jobs and records its owner", async () => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-corpus-lock-"));
	const path = join(root, "unreal.lock");
	const order: string[] = [];
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		const first = withCorpusUnrealLock(
			async () => {
				order.push("first");
				assert.ok((await readFile(path, "utf8")).includes(`pid ${process.pid}`));
				await held;
				order.push("released");
			},
			{ path }
		);
		while (!order.length) await setTimeout(1);
		const second = withCorpusUnrealLock(
			() => {
				order.push("second");
			},
			{ path, pollMs: 5 }
		);
		await setTimeout(20);
		assert.deepEqual(order, ["first"]);
		release();
		await Promise.all([first, second]);
		assert.deepEqual(order, ["first", "released", "second"]);
		await assert.rejects(readFile(path), { code: "ENOENT" });
	} finally {
		release();
		await rm(root, { recursive: true, force: true });
	}
});

test("a failed corpus operation releases its lease", async () => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-corpus-lock-failure-"));
	const path = join(root, "unreal.lock");
	try {
		await assert.rejects(
			withCorpusUnrealLock(
				() => {
					throw new Error("scan failed");
				},
				{ path }
			),
			/scan failed/u
		);
		assert.equal(await withCorpusUnrealLock(() => "next job", { path }), "next job");
		await assert.rejects(readFile(path), { code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
