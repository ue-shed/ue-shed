import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { formatTraceparent, newSpanId, newTraceId } from "./gate-trace.ts";
import { chromeTrace, readSpans } from "./time-gate.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const require = createRequire(join(repositoryRoot, "apps/workbench/package.json"));
const playwright = require.resolve("@playwright/test/cli");
const playwrightTest = require.resolve("@playwright/test");
const reporter = resolve(repositoryRoot, "apps/workbench/e2e/gate-trace-reporter.ts");

test("normal Playwright runs keep only the list reporter", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const { gateTraceReporters } = await import(${JSON.stringify(pathToFileURL(reporter).href)}); console.log(JSON.stringify(gateTraceReporters()));`
		],
		{
			env: { ...process.env, UE_SHED_TRACE_FILE: "" },
			encoding: "utf8",
			windowsHide: true
		}
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), '[["list"]]');
});

test("real Playwright runs join gate traces with retries, skips, parallel workers and nested steps", () => {
	const root = mkdtempSync(join(tmpdir(), "ue-shed-playwright-trace-"));
	try {
		const spansFile = join(root, "spans.jsonl");
		const config = join(root, "playwright.config.ts");
		const traceId = newTraceId();
		const parentSpanId = newSpanId();
		// The spec named-imports CommonJS @playwright/test. Without this, a `"type": "module"`
		// package.json above the temp directory would make Playwright load it as ESM and fail.
		writeFileSync(join(root, "package.json"), '{ "type": "commonjs" }\n');
		writeFileSync(
			config,
			`export default { testDir: ${JSON.stringify(root)}, testMatch: "*.spec.ts", fullyParallel: true, workers: 2, retries: 1, timeout: 2000, outputDir: ${JSON.stringify(join(root, "results"))}, reporter: [[${JSON.stringify(reporter)}]], projects: [{name: "trace-regression"}] };`
		);
		writeFileSync(
			join(root, "journey.spec.ts"),
			`import { test as base, expect } from ${JSON.stringify(playwrightTest)};
const test = base.extend({ journey: async ({}, use) => {
 await base.step("launch owned application", async () => {});
 await use("ready");
 await base.step("clean up owned application", async () => {});
} });
test("passes with nested steps", async ({ journey }) => {
 await test.step("capture scenario", async () => {
  await test.step("wait for our host", async () => new Promise(r => setTimeout(r, 50)));
  expect(journey).toBe("ready");
 });
});
test("retries the failed attempt", async ({}, info) => { expect(info.retry).toBe(1); });
test.skip("explicitly skipped", async () => {});
test("expected failure", async () => { test.fail(); expect(1).toBe(2); });
const interrupted = base.extend({ cleanup: [async ({}, use) => {
 await use();
 await base.step("cleanup after timeout", async () => new Promise(r => setTimeout(r, 300)));
}, { auto: true, timeout: 5000 }] });
interrupted("times out", async () => {
 interrupted.setTimeout(200);
 await interrupted.step("pending outer wait", async () => {
  await interrupted.step("pending host wait", async () => new Promise(() => {}));
 });
});
test("runs in parallel", async () => { await new Promise(r => setTimeout(r, 100)); });
const lifecycle = base.extend({ resource: [async ({}, use) => {
 await base.step("separate fixture setup", async () => new Promise(r => setTimeout(r, 400)));
 await use("ready");
 await base.step("separate fixture teardown", async () => new Promise(r => setTimeout(r, 300)));
}, { timeout: 5000 }] });
lifecycle.describe("separate timeout slots", () => {
 lifecycle.beforeAll(async () => {
  await base.step("prepare suite", async () => new Promise(r => setTimeout(r, 600)));
 });
 lifecycle("includes lifecycle wall time", async ({ resource }) => {
  expect(resource).toBe("ready");
  await new Promise(r => setTimeout(r, 100));
 });
});`
		);
		const result = spawnSync(process.execPath, [playwright, "test", "--config", config], {
			cwd: repositoryRoot,
			env: {
				...process.env,
				UE_SHED_TRACE_FILE: spansFile,
				TRACEPARENT: formatTraceparent(traceId, parentSpanId)
			},
			encoding: "utf8",
			windowsHide: true
		});
		assert.equal(result.status, 1, result.stdout + result.stderr);
		const spans = readSpans(spansFile);
		const run = spans.find((span) => span.name === "playwright e2e");
		assert.ok(run, result.stdout + result.stderr);
		assert.equal(run.traceId, traceId);
		// A preload may add process ancestors; the inherited trace must still be preserved.
		const byId = new Map(spans.map((span) => [span.spanId, span]));
		let ancestor = run.parentSpanId;
		while (ancestor !== undefined && byId.has(ancestor)) {
			ancestor = byId.get(ancestor)?.parentSpanId;
		}
		assert.equal(ancestor, parentSpanId);
		assert.equal(run.status, "error");
		const attempts = spans.filter(
			(span) => span.attributes["playwright.test_id"] !== undefined
		);
		assert.equal(attempts.length, 9);
		assert.ok(attempts.every((span) => span.parentSpanId === run.spanId));
		assert.ok(
			attempts.every((span) => span.attributes["playwright.project"] === "trace-regression")
		);
		assert.ok(new Set(attempts.map((span) => span.attributes["playwright.worker"])).size > 1);
		assert.ok(attempts.some((span) => span.attributes["playwright.status"] === "skipped"));
		assert.ok(
			attempts.some(
				(span) =>
					span.attributes["playwright.status"] === "timedOut" && span.status === "error"
			)
		);
		assert.ok(
			attempts.some(
				(span) => span.attributes["playwright.retry"] === 1 && span.status === "ok"
			)
		);
		assert.ok(
			attempts.some((span) => span.attributes["playwright.expected_status"] === "failed")
		);
		const capture = spans.find((span) => span.name === "capture scenario");
		const wait = spans.find((span) => span.name === "wait for our host");
		assert.ok(capture && wait);
		assert.equal(wait.parentSpanId, capture.spanId);
		assert.ok(wait.endUs - wait.startUs >= 40_000);
		assert.ok(spans.some((span) => span.name === "launch owned application"));
		assert.ok(spans.some((span) => span.name === "clean up owned application"));
		assert.ok(spans.some((span) => span.attributes["playwright.category"] === "expect"));
		const lifecycle = attempts.find((span) =>
			span.name.endsWith("includes lifecycle wall time")
		);
		assert.ok(lifecycle);
		const lifecycleMs = (lifecycle.endUs - lifecycle.startUs) / 1000;
		assert.ok(lifecycleMs >= 1300, `Lifecycle work took only ${lifecycleMs}ms`);
		assert.ok(
			lifecycleMs - Number(lifecycle.attributes["playwright.reported_duration_ms"]) >= 1100,
			"The lifecycle interval must include work charged to separate timeout slots"
		);
		const pending = spans.filter((span) => span.name === "pending host wait");
		assert.equal(pending.length, 2);
		for (const wait of pending) {
			assert.equal(wait.status, "error");
			assert.equal(wait.attributes["playwright.incomplete"], true);
			assert.ok(wait.endUs - wait.startUs >= 100_000);
			const outer = byId.get(wait.parentSpanId!);
			assert.ok(outer);
			assert.equal(outer.status, "error");
			assert.equal(outer.attributes["playwright.incomplete"], true);
			assert.equal(wait.endUs, outer.endUs);
			const attempt = byId.get(outer.parentSpanId!);
			assert.ok(attempt);
			const afterHooks = spans.find(
				(span) => span.name === "After Hooks" && span.parentSpanId === attempt.spanId
			);
			assert.ok(afterHooks);
			assert.equal(wait.endUs, afterHooks.startUs);
			assert.ok(
				attempt.endUs - wait.endUs >= 250_000,
				"Pending waits must end before cleanup rather than count its extra time"
			);
		}
		assert.equal(spans.filter((span) => span.name === "cleanup after timeout").length, 2);
		for (const span of spans) {
			const parent = byId.get(span.parentSpanId ?? "");
			if (!parent) continue;
			assert.ok(span.startUs >= parent.startUs, `${span.name} starts before its parent`);
			assert.ok(
				span.endUs <= parent.endUs,
				`${span.name} ends ${span.endUs - parent.endUs}us after ${parent.name}`
			);
		}
		assert.ok(spans.every((span) => span.endUs >= span.startUs));
		const trace = chromeTrace(spans, run.startUs);
		assert.ok(trace.traceEvents.some((event) => event.name === "capture scenario"));
		assert.ok(readFileSync(spansFile, "utf8").length > 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
