import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { cargoAttributes } from "./process-trace.ts";
import { readSpans } from "./time-gate.ts";
import { describeSubprocess, parentedEnvironment } from "./trace-process.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const preload = pathToFileURL(join(repositoryRoot, "scripts", "trace-process.ts")).href;

test("subprocess names look through cmd shims and skip Node, pnpm and build services", () => {
	assert.deepEqual(describeSubprocess("git", ["worktree", "add", "x"]), {
		name: "git worktree add x",
		tool: "git"
	});
	assert.deepEqual(
		describeSubprocess("C:\\Windows\\system32\\cmd.exe", [
			"/d",
			"/s",
			"/c",
			"tar",
			"-tzf",
			"a"
		]),
		{ name: "tar -tzf a", tool: "tar" }
	);
	assert.deepEqual(describeSubprocess("cargo build --release", [], true), {
		name: "cargo build --release",
		tool: "cargo"
	});
	assert.deepEqual(describeSubprocess("/bin/sh", ["-c", "git --version"]), {
		name: "git --version",
		tool: "git"
	});
	assert.equal(describeSubprocess(process.execPath, ["script.ts"]), undefined);
	assert.equal(describeSubprocess("cmd.exe", ["/d", "/s", "/c", "pnpm.cmd", "pack"]), undefined);
	// pnpm runs package scripts as one command-line argument, sometimes quoted verbatim.
	assert.equal(
		describeSubprocess("C:\\WINDOWS\\system32\\cmd.exe", [
			"/d",
			"/s",
			"/c",
			"node scripts/pack-public-packages.ts --output out/releases/npm"
		]),
		undefined
	);
	assert.deepEqual(describeSubprocess("cmd.exe", ['/d /s /c "tar -tzf a.tgz"']), {
		name: "tar -tzf a.tgz",
		tool: "tar"
	});
	assert.deepEqual(
		describeSubprocess('"C:\\Program Files\\Epic Games\\UE_5.7\\Build.bat" Fixture', [], true),
		{ name: "Build.bat Fixture", tool: "Build.bat" }
	);
	assert.equal(describeSubprocess("C:\\tools\\esbuild.exe", ["--service=0.25"]), undefined);
});

test("Cargo attributes separate compiling from the rest of the run", () => {
	const output = [
		"   Compiling serde v1.0.228",
		"   Compiling uasset-io v0.20.0 (C:\\repo\\crates\\uasset-io)",
		"    Finished `release` profile [optimized] target(s) in 1m 02s",
		"    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.25s",
		"     Running unittests src\\lib.rs"
	].join("\n");
	assert.deepEqual(cargoAttributes(output), {
		"cargo.compiled_crates": 2,
		"cargo.profiles": "release test",
		"cargo.build_ms": 62_250
	});
	assert.deepEqual(cargoAttributes(""), {});
});

test("traced Node processes record spans for their non-Node subprocesses exactly once", () => {
	const root = mkdtempSync(join(tmpdir(), "ue-shed-trace-process-"));
	try {
		const spansFile = join(root, "spans.jsonl");
		const script = join(root, "spawner.ts");
		const processTrace = pathToFileURL(
			join(repositoryRoot, "scripts", "process-trace.ts")
		).href;
		writeFileSync(
			script,
			[
				`import { exec, execFile, execFileSync, spawn, spawnSync } from "node:child_process";`,
				`import { promisify } from "node:util";`,
				`import { traceProcess } from ${JSON.stringify(processTrace)};`,
				`spawnSync("git", ["--version"]);`,
				`execFileSync("git", ["--version"]);`,
				`traceProcess("git", ["rev-parse", "--git-dir"], () => spawnSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" }));`,
				`spawnSync(process.execPath, ["--version"]);`,
				`await new Promise((done) => spawn("git", ["--version"]).on("exit", done));`,
				// Node's execFile and exec use its internal spawn, not the patched export.
				`const { stdout } = await promisify(execFile)("git", ["--version"]);`,
				`if (!stdout.startsWith("git version")) throw new Error("promisify(execFile) changed");`,
				`await new Promise((done) => exec("git --version", done));`
			].join("\n")
		);
		const result = spawnSync(process.execPath, [script], {
			cwd: repositoryRoot,
			env: {
				...process.env,
				NODE_OPTIONS: `--import=${preload}`,
				TRACEPARENT: "",
				UE_SHED_TRACE_FILE: spansFile
			},
			encoding: "utf8",
			windowsHide: true
		});
		assert.equal(result.status, 0, result.stderr);
		const spans = readSpans(spansFile);
		const processSpan = spans.find((span) => span.name.startsWith("node "));
		assert.ok(processSpan, "the Node process records its own span");
		const children = spans.filter((span) => span.parentSpanId === processSpan.spanId);
		assert.deepEqual(children.map((span) => span.name).toSorted(), [
			"git --version",
			"git --version",
			"git --version",
			"git --version",
			"git --version",
			"git rev-parse --git-dir"
		]);
		const automatic = children.filter((span) => span.attributes["trace.subprocess"] === true);
		assert.equal(automatic.length, 5, "the explicitly traced call is not recorded twice");
		for (const span of children) {
			assert.equal(span.status, "ok");
			assert.ok(span.endUs >= span.startUs);
		}
		assert.equal(automatic.at(-1)!.attributes["process.exit_code"], 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("explicit spans from another copy of the tracing modules still suppress automatic ones", () => {
	// A clean-pack worktree runs its own copy of scripts/ under the preload from this checkout.
	const root = mkdtempSync(join(tmpdir(), "ue-shed-trace-copy-"));
	try {
		const copy = join(root, "scripts");
		mkdirSync(copy);
		for (const file of ["gate-trace.ts", "process-trace.ts"]) {
			copyFileSync(join(repositoryRoot, "scripts", file), join(copy, file));
		}
		const spansFile = join(root, "spans.jsonl");
		const script = join(root, "spawner.ts");
		writeFileSync(
			script,
			[
				`import { spawnSync } from "node:child_process";`,
				`import { traceProcess } from ${JSON.stringify(pathToFileURL(join(copy, "process-trace.ts")).href)};`,
				`traceProcess("git", ["--version"], () => spawnSync("git", ["--version"]));`
			].join("\n")
		);
		const result = spawnSync(process.execPath, [script], {
			cwd: repositoryRoot,
			env: {
				...process.env,
				NODE_OPTIONS: `--import=${preload}`,
				TRACEPARENT: "",
				UE_SHED_TRACE_FILE: spansFile
			},
			encoding: "utf8",
			windowsHide: true
		});
		assert.equal(result.status, 0, result.stderr);
		const git = readSpans(spansFile).filter((span) => span.name === "git --version");
		assert.equal(git.length, 1);
		assert.equal(git[0]!.attributes["trace.subprocess"], undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("children join the innermost active span even through an environment copied before it", () => {
	const traceId = "a".repeat(32);
	const stale = `00-${traceId}-${"1".repeat(16)}-01`;
	const current = `00-${traceId}-${"2".repeat(16)}-01`;
	const otherTrace = `00-${"b".repeat(32)}-${"3".repeat(16)}-01`;
	assert.equal(
		parentedEnvironment({ TRACEPARENT: stale }, undefined, current)?.TRACEPARENT,
		current
	);
	assert.equal(
		parentedEnvironment({ TRACEPARENT: otherTrace }, undefined, current)?.TRACEPARENT,
		otherTrace
	);
	assert.equal(parentedEnvironment(undefined, undefined, current), undefined);

	const root = mkdtempSync(join(tmpdir(), "ue-shed-trace-stale-"));
	try {
		const spansFile = join(root, "spans.jsonl");
		const script = join(root, "stale.ts");
		const gateTrace = pathToFileURL(join(repositoryRoot, "scripts", "gate-trace.ts")).href;
		const child = join(root, "child.ts");
		writeFileSync(child, "");
		writeFileSync(
			script,
			[
				`import { spawnSync } from "node:child_process";`,
				`import { withSpan } from ${JSON.stringify(gateTrace)};`,
				`const copied = { ...process.env };`,
				`withSpan("stage", {}, () => spawnSync(process.execPath, [${JSON.stringify(child)}], { env: copied }));`
			].join("\n")
		);
		const result = spawnSync(process.execPath, [script], {
			cwd: repositoryRoot,
			env: {
				...process.env,
				NODE_OPTIONS: `--import=${preload}`,
				TRACEPARENT: "",
				UE_SHED_TRACE_FILE: spansFile
			},
			encoding: "utf8",
			windowsHide: true
		});
		assert.equal(result.status, 0, result.stderr);
		assert.ok(!result.stderr.includes("DEP0190"), result.stderr);
		const spans = readSpans(spansFile);
		const stage = spans.find((span) => span.name === "stage");
		const childSpan = spans.find((span) => span.name === "node child.ts");
		assert.ok(stage, "the stage records a span");
		assert.ok(
			childSpan,
			`the child records a span: ${spans.map((span) => span.name).join(", ")}`
		);
		assert.equal(childSpan.parentSpanId, stage.spanId);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
