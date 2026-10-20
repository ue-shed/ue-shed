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

function currentParent() {
	const match = traceparent.exec(process.env.TRACEPARENT ?? "");
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
	options: { readonly parent?: Span; readonly startUs?: number } = {}
): Span {
	const parent = options.parent ?? currentParent();
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
