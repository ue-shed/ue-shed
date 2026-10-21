import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReporterDescription } from "@playwright/test";
import type {
	FullResult,
	Reporter,
	TestCase,
	TestResult,
	TestStep
} from "@playwright/test/reporter";
import { startSpan, traceFile, type Span } from "../../../scripts/gate-trace.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

/** Keep normal output, adding local timing spans only for a traced gate. */
export function gateTraceReporters(): ReporterDescription[] {
	return traceFile() ? [["list"], [fileURLToPath(import.meta.url)]] : [["list"]];
}

/** Uses runner timestamps: no Unreal instrumentation or browser-side tracing is required. */
export default class GateTraceReporter implements Reporter {
	readonly #root = startSpan("playwright e2e");
	#errors = 0;

	onTestEnd(test: TestCase, result: TestResult) {
		const span = startSpan(
			test.titlePath().filter(Boolean).join(" > "),
			{
				"playwright.test_id": test.id,
				"playwright.file": relative(repositoryRoot, test.location.file).replaceAll(
					"\\",
					"/"
				),
				"playwright.line": test.location.line,
				"playwright.project": test.parent.project()?.name ?? "",
				"playwright.worker": result.workerIndex,
				"playwright.parallel_index": result.parallelIndex,
				"playwright.retry": result.retry,
				"playwright.repeat": test.repeatEachIndex,
				"playwright.status": result.status,
				"playwright.expected_status": test.expectedStatus,
				"trace.lane": `playwright ${test.parent.project()?.name ?? ""} worker ${result.workerIndex}`
			},
			{ parent: this.#root, startUs: result.startTime.getTime() * 1000 }
		);
		for (const step of result.steps) this.#step(step, span);
		span.end(
			result.status === "passed" || result.status === "skipped" ? "ok" : "error",
			span.startUs + Math.max(0, result.duration) * 1000
		);
	}

	#step(step: TestStep, parent: Span) {
		const span = startSpan(
			step.title,
			{ "playwright.category": step.category },
			{ parent, startUs: step.startTime.getTime() * 1000 }
		);
		for (const child of step.steps) this.#step(child, span);
		span.end(step.error ? "error" : "ok", span.startUs + Math.max(0, step.duration) * 1000);
	}

	onError() {
		this.#errors += 1;
	}

	onEnd(result: FullResult) {
		this.#root.setAttributes({
			"playwright.status": result.status,
			"playwright.errors": this.#errors
		});
		this.#root.end(result.status === "passed" && this.#errors === 0 ? "ok" : "error");
	}

	printsToStdio() {
		return false;
	}
}
