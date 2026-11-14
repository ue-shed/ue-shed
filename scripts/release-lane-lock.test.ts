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

void test("a killed run's lease fails every later run until a person deletes it", () => {
	const { path, dispose } = lane();
	try {
		const exited = spawnSync(process.execPath, ["-e", ""]).pid;
		writeFileSync(
			`${path}.lock`,
			JSON.stringify({ pid: exited, startedAt: "2026-01-01T00:00:00.000Z" })
		);
		assert.throws(
			() => acquireLaneLease(path),
			new RegExp(`no longer running \\(pid ${exited}.*delete .*\\.lock`)
		);
		assert.equal(holderPid(path), exited);
		rmSync(`${path}.lock`);
		acquireLaneLease(path).release();
	} finally {
		dispose();
	}
});

const module = new URL("./release-lane-lock.ts", import.meta.url).href;

/** A run in its own process: it tries for the lane, reports, and keeps any lease until killed. */
function contender(path: string, script = "") {
	return spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const { acquireLaneLease } = await import(${JSON.stringify(module)});
			let outcome = "held";
			try { acquireLaneLease(${JSON.stringify(path)}); } catch { outcome = "busy"; }
			${script}
			process.stdout.write(outcome + "\\n");
			setInterval(() => {}, 1000);`
		],
		{ stdio: ["ignore", "pipe", "inherit"] }
	);
}

async function outcomeOf(child: ReturnType<typeof contender>): Promise<string> {
	child.stdout.setEncoding("utf8");
	const [chunk] = await once(child.stdout, "data");
	return String(chunk).split("\n")[0]?.trim() ?? "";
}

void test(
	"runs racing for the lane get it once, and a killed run's lease admits none",
	{ timeout: 60_000 },
	async () => {
		const { path, dispose } = lane();
		const children: Array<ReturnType<typeof contender>> = [];
		try {
			const racers = Array.from({ length: 4 }, () => contender(path));
			children.push(...racers);
			const outcomes = await Promise.all(racers.map(outcomeOf));
			assert.deepEqual(outcomes.toSorted(), ["busy", "busy", "busy", "held"]);
			for (const child of racers) child.kill("SIGKILL");
			await Promise.all(racers.map((child) => child.exitCode ?? once(child, "exit")));
			// The holder is gone, but recovering its lease is a person's decision, not a racer's.
			const recovering = Array.from({ length: 4 }, () => contender(path));
			children.push(...recovering);
			assert.deepEqual(await Promise.all(recovering.map(outcomeOf)), [
				"busy",
				"busy",
				"busy",
				"busy"
			]);
		} finally {
			for (const child of children) child.kill("SIGKILL");
			dispose();
		}
	}
);

void test(
	"a killed run whose lane work outlives it keeps the lane",
	{ timeout: 60_000 },
	async () => {
		const { path, dispose } = lane();
		// The holder starts lane work in its own process, as its gate steps do, then is killed.
		// Detached, so on Windows too it outlives the holder, as a shell's descendants on POSIX do.
		const holder = contender(
			path,
			`const { spawn } = await import("node:child_process");
		const work = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
		work.unref();
		process.stdout.write(work.pid + "\\n");`
		);
		let work: number | undefined;
		try {
			work = Number(await outcomeOf(holder));
			holder.kill("SIGKILL");
			await once(holder, "exit");
			process.kill(work, 0);
			assert.throws(() => acquireLaneLease(path), /no longer running.*may still be running/);
		} finally {
			holder.kill("SIGKILL");
			if (work !== undefined && Number.isInteger(work))
				try {
					process.kill(work, "SIGKILL");
				} catch {
					// Already stopped.
				}
			dispose();
		}
	}
);

void test("releasing removes only this run's lease", () => {
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
