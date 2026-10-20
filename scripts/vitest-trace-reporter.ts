/**
 * Vitest reporter for traced gate runs (`pnpm check:time`). Records a span per test file, split
 * into setup (pool, environment and setup files), import and test phases, and a span per test.
 * `scripts/test.ts` adds it only when `UE_SHED_TRACE_FILE` is set.
 */

import { relative, resolve } from "node:path";
import { experimental_getRunnerTask, type Reporter, type TestModule } from "vitest/node";
import { newSpanId, nowUs, startSpan, writeSpan, type SpanRecord } from "./gate-trace.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

export default class VitestTraceReporter implements Reporter {
	readonly #root = startSpan("vitest test files");

	onTestModuleEnd(testModule: TestModule) {
		const endUs = nowUs();
		const diagnostic = testModule.diagnostic();
		const runStartMs = experimental_getRunnerTask(testModule).result?.startTime;
		const tests = [...testModule.children.allTests()];
		const testEndUs = Math.max(
			0,
			...tests.map((test) => {
				const result = test.diagnostic();
				return result ? Math.round((result.startTime + result.duration) * 1000) : 0;
			})
		);
		const fileEndUs = Math.max(endUs, testEndUs);
		const testsStartUs =
			runStartMs === undefined ? fileEndUs - diagnostic.duration * 1000 : runStartMs * 1000;
		const importUs = diagnostic.collectDuration * 1000;
		const setupUs =
			(diagnostic.prepareDuration +
				diagnostic.environmentSetupDuration +
				diagnostic.setupDuration) *
			1000;
		const importStartUs = testsStartUs - importUs;
		const fileStartUs = Math.round(importStartUs - setupUs);
		const file = relative(repositoryRoot, testModule.moduleId).replaceAll("\\", "/");
		const fileSpanId = newSpanId();
		const base = { traceId: this.#root.traceId, status: "ok" as const };
		const records: SpanRecord[] = [
			{
				...base,
				spanId: fileSpanId,
				parentSpanId: this.#root.spanId,
				name: file,
				startUs: fileStartUs,
				endUs: fileEndUs,
				status: testModule.ok() ? "ok" : "error",
				attributes: {
					"vitest.project": testModule.project.name,
					"vitest.worker": diagnostic.concurrencyId,
					"vitest.tests": tests.length,
					"vitest.setup_ms": Math.round(setupUs / 1000),
					"vitest.environment_ms": Math.round(diagnostic.environmentSetupDuration),
					"vitest.import_ms": Math.round(diagnostic.collectDuration),
					"vitest.test_ms": Math.round(diagnostic.duration),
					"trace.lane": `${testModule.project.name} worker ${diagnostic.concurrencyId}`
				}
			},
			{
				...base,
				spanId: newSpanId(),
				parentSpanId: fileSpanId,
				name: "setup",
				startUs: fileStartUs,
				endUs: Math.round(importStartUs),
				attributes: {}
			},
			{
				...base,
				spanId: newSpanId(),
				parentSpanId: fileSpanId,
				name: "import",
				startUs: Math.round(importStartUs),
				endUs: Math.round(testsStartUs),
				attributes: {}
			}
		];
		for (const test of tests) {
			const result = test.diagnostic();
			if (!result) continue;
			const startUs = Math.round(result.startTime * 1000);
			records.push({
				...base,
				spanId: newSpanId(),
				parentSpanId: fileSpanId,
				name: test.fullName.slice(0, 200),
				startUs: Math.max(startUs, Math.round(testsStartUs)),
				endUs: Math.min(Math.round(startUs + result.duration * 1000), fileEndUs),
				status: test.result().state === "failed" ? "error" : "ok",
				attributes: {
					"vitest.state": test.result().state,
					"vitest.retries": result.retryCount > 0 ? result.retryCount : undefined,
					"vitest.slow": result.slow || undefined
				}
			});
		}
		for (const record of records) writeSpan(record);
	}

	onTestRunEnd() {
		this.#root.end();
	}
}
