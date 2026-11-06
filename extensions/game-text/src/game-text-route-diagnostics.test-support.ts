import { afterEach, beforeEach, onTestFailed } from "vitest";
import { indexedReportDiagnostics } from "../../../packages/game-text/src/indexed-reports.test-support.js";

/** Records the last browser event and native timings on CI failure, preserving test deadlines. */
export function installGameTextRouteDiagnostics(): void {
	if (process.env.CI !== "true") return;
	let action: { event: string; target: string | undefined; started: number } | undefined;
	const events = ["click", "keydown", "input"];
	const record = (event: Event) => {
		action = {
			event: event.type,
			target:
				event.target instanceof Element ? event.target.outerHTML.slice(0, 300) : undefined,
			started: performance.now()
		};
	};
	afterEach(() => {
		for (const event of events) document.removeEventListener(event, record, true);
	});
	beforeEach((context) => {
		action = undefined;
		for (const event of events) document.addEventListener(event, record, true);
		const started = performance.now();
		const firstReport = indexedReportDiagnostics().length;
		onTestFailed(() => {
			console.error("GAME_TEXT_TIMEOUT_DIAGNOSTIC", {
				test: context.task.name,
				elapsedMs: performance.now() - started,
				action,
				reports: indexedReportDiagnostics().slice(firstReport)
			});
		});
	});
}
