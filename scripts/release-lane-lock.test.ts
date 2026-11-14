import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { acquireLaneLease, decodeLaneHolder } from "./release-lane-lock.ts";

function lane() {
	const directory = mkdtempSync(join(tmpdir(), "ue-shed-lane-lock-"));
	return {
		path: join(directory, "ue-shed-unreal"),
		dispose: () => rmSync(directory, { recursive: true, force: true })
	};
}

const holderPid = (path: string): number =>
	decodeLaneHolder(readFileSync(`${path}.lock`, "utf8")).pid;

void test("a second run fails while the lane is leased, and leases it once released", () => {
	const { path, dispose } = lane();
	try {
		const first = acquireLaneLease(path);
		assert.throws(
			() => acquireLaneLease(path),
			new RegExp(`in use by another release:prepare \\(pid ${process.pid}`)
		);
		first.release();
		assert.equal(existsSync(`${path}.lock`), false);
		acquireLaneLease(path).release();
	} finally {
		dispose();
	}
});

void test("a lease left by a run that is no longer running is taken over", () => {
	const { path, dispose } = lane();
	try {
		const exited = spawnSync(process.execPath, ["-e", ""]).pid;
		writeFileSync(
			`${path}.lock`,
			JSON.stringify({ pid: exited, startedAt: "2026-01-01T00:00:00.000Z" })
		);
		const lease = acquireLaneLease(path);
		assert.equal(holderPid(path), process.pid);
		lease.release();
	} finally {
		dispose();
	}
});

void test("a run in another process holds the lane until it ends", async () => {
	const { path, dispose } = lane();
	const module = new URL("./release-lane-lock.ts", import.meta.url).href;
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const { acquireLaneLease } = await import(${JSON.stringify(module)});
			acquireLaneLease(${JSON.stringify(path)});
			process.stdout.write("held\\n");
			setInterval(() => {}, 1000);`
		],
		{ stdio: ["ignore", "pipe", "inherit"] }
	);
	try {
		child.stdout.setEncoding("utf8");
		assert.deepEqual(
			(await once(child.stdout, "data")).map((chunk) => String(chunk).trim()),
			["held"]
		);
		assert.throws(() => acquireLaneLease(path), new RegExp(`pid ${child.pid}`));
		// Killed mid-run, as a cancelled release would be: its lease no longer blocks the lane.
		child.kill("SIGKILL");
		await once(child, "exit");
		const lease = acquireLaneLease(path);
		assert.equal(holderPid(path), process.pid);
		lease.release();
	} finally {
		child.kill("SIGKILL");
		dispose();
	}
});

void test("releasing leaves a lease another run has taken since", () => {
	const { path, dispose } = lane();
	try {
		const lease = acquireLaneLease(path);
		const other = { pid: process.pid + 1, startedAt: new Date().toISOString() };
		writeFileSync(`${path}.lock`, JSON.stringify(other));
		lease.release();
		assert.equal(holderPid(path), other.pid);
	} finally {
		dispose();
	}
});
