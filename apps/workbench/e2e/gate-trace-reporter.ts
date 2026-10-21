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
	readonly #root = startSpan("playwright e2e", {}, { startUs: Date.now() * 1000 });
	#errors = 0;
	#lastEndUs = 0;

	onTestEnd(test: TestCase, result: TestResult) {
		// result.duration omits beforeAll and fixtures with separate timeout slots.
		// The end callback follows their teardown, so use its wall time instead.
		// Match Playwright's Date-based step clock rather than performance.timeOrigin.
		// Worker clock rounding can put its last step a millisecond past this callback.
		const endUs = result.steps.reduce(
			(end, step) =>
				Math.max(end, (step.startTime.getTime() + Math.max(0, step.duration)) * 1000),
			Date.now() * 1000
		);
		this.#lastEndUs = Math.max(this.#lastEndUs, endUs);
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
				"playwright.reported_duration_ms": result.duration,
				"trace.lane": `playwright ${test.parent.project()?.name ?? ""} worker ${result.workerIndex}`
			},
			{ parent: this.#root, startUs: result.startTime.getTime() * 1000 }
		);
		for (const [index, step] of result.steps.entries()) {
			// The next lifecycle hook starts after an interrupted body has stopped.
			// Pending body steps must not absorb the subsequent teardown time.
			const nextHook = result.steps.slice(index + 1).find((step) => step.category === "hook");
			this.#step(step, span, nextHook ? nextHook.startTime.getTime() * 1000 : endUs);
		}
		span.end(result.status === "passed" || result.status === "skipped" ? "ok" : "error", endUs);
	}

	#step(step: TestStep, parent: Span, parentEndUs: number) {
		const incomplete = step.duration < 0;
		const span = startSpan(
			step.title,
			{ "playwright.category": step.category, "playwright.incomplete": incomplete },
			{ parent, startUs: step.startTime.getTime() * 1000 }
		);
		// Unfinished children stop with their enclosing step, before later teardown.
		const endUs = Math.max(
			span.startUs,
			incomplete ? parentEndUs : span.startUs + step.duration * 1000
		);
		for (const child of step.steps) this.#step(child, span, endUs);
		span.end(step.error || incomplete ? "error" : "ok", endUs);
	}

	onError() {
		this.#errors += 1;
	}

	onEnd(result: FullResult) {
		this.#root.setAttributes({
			"playwright.status": result.status,
			"playwright.errors": this.#errors
		});
		this.#root.end(
			result.status === "passed" && this.#errors === 0 ? "ok" : "error",
			Math.max(Date.now() * 1000, this.#lastEndUs)
		);
	}

	printsToStdio() {
		return false;
	}
}
