/**
 * Preloaded into every Node process of a traced gate run (`NODE_OPTIONS=--import=…`, set by
 * `pnpm check:time`). Records one span per process from start to exit and makes it the parent of
 * the process's own spans and children, so scripts nest without each one being instrumented.
 */

import { basename } from "node:path";
import { isMainThread } from "node:worker_threads";
import { formatTraceparent, startSpan, traceFile } from "./gate-trace.ts";

if (traceFile() && isMainThread && process.env.UE_SHED_TRACE_PROCESSES !== "0") {
	const name = processName(process.argv.slice(1));
	if (name !== undefined) {
		const span = startSpan(name, { "process.pid": process.pid });
		process.env.TRACEPARENT = formatTraceparent(span.traceId, span.spanId);
		process.on("exit", (code) => {
			span.setAttributes({ "process.exit_code": code });
			span.end(code === 0 ? "ok" : "error");
		});
	}
}

function processName(argv: readonly string[]) {
	const [entry, ...rest] = argv;
	if (entry === undefined) return undefined;
	const file = basename(entry);
	// Vitest workers are covered by the per-file spans from the Vitest reporter.
	if (/[\\/]vitest[\\/]dist[\\/]/.test(entry)) return undefined;
	const label = /^pnpm\.c?js$/.test(file)
		? "pnpm"
		: file === "vitest.mjs"
			? "vitest"
			: `node ${/[\\/]scripts[\\/]/.test(entry) ? `scripts/${file}` : file}`;
	return `${label} ${rest.join(" ")}`.trim().slice(0, 160);
}
