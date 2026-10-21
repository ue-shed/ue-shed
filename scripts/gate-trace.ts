/**
 * Records spans for local gate runs. `pnpm check:time` sets `UE_SHED_TRACE_FILE` and a W3C
 * `TRACEPARENT`; every script that records a span appends one JSON line to that file and passes its
 * own span to child processes through `TRACEPARENT`, so the spans from every process form one tree.
 * Without `UE_SHED_TRACE_FILE` every function here is a no-op.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

/** Attribute values; `undefined` attributes are left out of the record. */
export type SpanAttributeValue = string | number | boolean | undefined;
export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;
export type SpanStatus = "ok" | "error";

export interface SpanRecord {
	readonly traceId: string;
	readonly spanId: string;
	/** Absent on the root span. */
	readonly parentSpanId: string | undefined;
	readonly name: string;
	/** Microseconds since the Unix epoch. */
	readonly startUs: number;
	readonly endUs: number;
	readonly status: SpanStatus;
	readonly attributes: SpanAttributes;
}

export interface Span {
	readonly traceId: string;
	readonly spanId: string;
	readonly startUs: number;
	setAttributes(attributes: SpanAttributes): void;
	/** Copies `environment` with this span as the parent of spans in the child process. */
	environment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
	end(status?: SpanStatus, endUs?: number): void;
}

const traceparent = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export function traceFile() {
	return process.env.UE_SHED_TRACE_FILE || undefined;
}

export function nowUs() {
	return Math.round((performance.timeOrigin + performance.now()) * 1000);
}

export function newSpanId() {
	return randomBytes(8).toString("hex");
}

export function newTraceId() {
	return randomBytes(16).toString("hex");
}

export function formatTraceparent(traceId: string, spanId: string) {
	return `00-${traceId}-${spanId}-01`;
}

function parseTraceparent(value: string | undefined) {
	const match = traceparent.exec(value ?? "");
	return match ? { traceId: match[1]!, spanId: match[2]! } : undefined;
}

export function writeSpan(record: SpanRecord) {
	const file = traceFile();
	if (file) appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/** Starts a span under the current `TRACEPARENT` (or `parent`) without changing the environment. */
export function startSpan(
	name: string,
	attributes: SpanAttributes = {},
	options: {
		readonly parent?: Span;
		readonly startUs?: number;
		/** A W3C traceparent captured earlier, for a span recorded after its work began. */
		readonly traceparent?: string | undefined;
	} = {}
): Span {
	const parent =
		options.parent ?? parseTraceparent(options.traceparent ?? process.env.TRACEPARENT);
	const traceId = parent?.traceId ?? newTraceId();
	const spanId = newSpanId();
	const startUs = options.startUs ?? nowUs();
	const spanAttributes = new Map(Object.entries(attributes));
	let ended = false;
	return {
		traceId,
		spanId,
		startUs,
		setAttributes(more) {
			for (const [key, value] of Object.entries(more)) spanAttributes.set(key, value);
		},
		environment(environment) {
			return { ...environment, TRACEPARENT: formatTraceparent(traceId, spanId) };
		},
		end(status = "ok", endUs = nowUs()) {
			if (ended) return;
			ended = true;
			writeSpan({
				traceId,
				spanId,
				parentSpanId: parent?.spanId,
				name,
				startUs,
				endUs,
				status,
				attributes: Object.fromEntries(spanAttributes)
			});
		}
	};
}

interface ExplicitProcessSpans {
	depth: number;
}

const explicitProcessSpansKey = Symbol.for("ue-shed.gate-trace.explicit-process-spans");

/**
 * Kept on `globalThis` rather than in this module: the preload and the script it traces can load
 * different copies of this file (a clean-pack worktree runs its own `scripts`), and both must see
 * the same count.
 */
function explicitProcessSpans(): ExplicitProcessSpans {
	// SAFETY: only this function reads or writes the property behind this registered symbol, and it
	// always stores an ExplicitProcessSpans there.
	const registry = globalThis as typeof globalThis & {
		[explicitProcessSpansKey]?: ExplicitProcessSpans;
	};
	registry[explicitProcessSpansKey] ??= { depth: 0 };
	return registry[explicitProcessSpansKey];
}

/**
 * Runs `run` while a caller records its own span for the processes it spawns, so the automatic
 * subprocess spans from `trace-process.ts` do not record the same process twice.
 */
export function withExplicitProcessSpan<T>(run: () => T): T {
	const state = explicitProcessSpans();
	state.depth += 1;
	try {
		return run();
	} finally {
		state.depth -= 1;
	}
}

export function insideExplicitProcessSpan() {
	return explicitProcessSpans().depth > 0;
}

function enter(span: Span) {
	const previous = process.env.TRACEPARENT;
	process.env.TRACEPARENT = formatTraceparent(span.traceId, span.spanId);
	return () => {
		if (previous === undefined) delete process.env.TRACEPARENT;
		else process.env.TRACEPARENT = previous;
	};
}

/**
 * Runs `run` inside a span. While it runs, `process.env.TRACEPARENT` names the span, so child
 * processes that inherit `process.env` nest their spans under it. A thrown error, or `status`
 * returning "error", marks the span as failed.
 */
export function withSpan<T>(
	name: string,
	attributes: SpanAttributes,
	run: (span: Span) => T,
	status: (result: T) => SpanStatus = () => "ok"
): T {
	const span = startSpan(name, attributes);
	const leave = enter(span);
	let outcome: SpanStatus = "error";
	try {
		const result = run(span);
		outcome = status(result);
		return result;
	} finally {
		leave();
		span.end(outcome);
	}
}

export interface Stages {
	/** Ends the current stage and starts `name`; child processes nest under it until the next. */
	start(name: string, attributes?: SpanAttributes): Span;
	/** Ends the current stage, if any. */
	end(status?: SpanStatus): void;
}

/**
 * Spans for the consecutive stages of a long script without wrapping its body in callbacks. A
 * stage still open when the process exits ends there, failed if the process failed.
 */
export function stageSpans(): Stages {
	let current: { readonly span: Span; readonly leave: () => void } | undefined;
	const finish = (status: SpanStatus) => {
		if (current === undefined) return;
		current.leave();
		current.span.end(status);
		current = undefined;
	};
	if (traceFile()) {
		process.once("exit", (code) => finish(code === 0 ? "ok" : "error"));
	}
	return {
		start(name, attributes = {}) {
			finish("ok");
			const span = startSpan(name, attributes);
			current = { span, leave: enter(span) };
			return span;
		},
		end(status = "ok") {
			finish(status);
		}
	};
}

/** `withSpan` for async work; the span stays the parent until the promise settles. */
export async function withSpanAsync<T>(
	name: string,
	attributes: SpanAttributes,
	run: (span: Span) => Promise<T>
): Promise<T> {
	const span = startSpan(name, attributes);
	const leave = enter(span);
	let outcome: SpanStatus = "error";
	try {
		const result = await run(span);
		outcome = "ok";
		return result;
	} finally {
		leave();
		span.end(outcome);
	}
}
