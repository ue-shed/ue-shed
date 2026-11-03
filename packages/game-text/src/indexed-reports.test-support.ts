/// <reference types="node" />
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { Schema } from "effect";
import { afterAll, TestRunner } from "vitest";
import type { LocalizationTargetEvidence } from "@ue-shed/localization";
import {
	LocalizationQualityReport,
	type LocalizationCheckOptions
} from "./localization-quality-schema.js";
import { TextQualityReport } from "./quality-schema.js";
import type { GameTextRuleDocument } from "./game-text-rules.js";
import { TextCorpus } from "./schema.js";

// One persistent index per immutable suite fixture, shared by every rule document and test.
// The synchronous bridge keeps presentation fixtures usable at module initialization. A reusable
// worker retains compiled modules; every request rebuilds its input and runs the scoped index path.
const directory = mkdtempSync(join(tmpdir(), "ue-shed-report-suite-"));
const reports = new Map<string, unknown>();
const timings: Array<{ kind: string; started: number; durationMs?: number }> = [];
export const indexedReportDiagnostics = () => timings.slice();
// Collection has no current test. Use the same finite budget as native-backed route fixtures.
export const INDEXED_REPORT_FIXTURE_TIMEOUT_MS = 20_000;
let worker: Worker | undefined;
const terminations: Array<Promise<number>> = [];
const Reply = Schema.Struct({
	stdout: Schema.optionalKey(Schema.String),
	stderr: Schema.optionalKey(Schema.String)
});
afterAll(async () => {
	if (worker) terminations.push(worker.terminate());
	await Promise.all(terminations);
	rmSync(directory, { recursive: true, force: true });
});

function reportInWorker(input: string): string {
	worker ??= new Worker(
		resolve("packages/game-text/src/indexed-report-worker.test-support.mjs"),
		{
			execArgv: [],
			env: { ...process.env, UE_SHED_TELEMETRY_MODE: "disabled" }
		}
	);
	const { port1, port2 } = new MessageChannel();
	const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
	const completion = new Int32Array(state);
	try {
		worker.postMessage({ input, reply: port2, state }, [port2]);
		// Caller-thread error/exit listeners cannot run while Atomics.wait blocks this thread.
		// Bound collection and disabled/invalid test deadlines as well as active test requests.
		const timeout = TestRunner.getCurrentTest()?.timeout;
		const waitMs =
			timeout !== undefined && Number.isFinite(timeout) && timeout > 0
				? timeout
				: INDEXED_REPORT_FIXTURE_TIMEOUT_MS;
		if (Atomics.wait(completion, 0, 0, waitMs) === "timed-out") {
			terminations.push(worker.terminate());
			worker = undefined;
			throw new Error(
				`The indexed report worker did not respond within ${waitMs} ms; it may have exited.`
			);
		}
		const reply = receiveMessageOnPort(port1);
		if (!reply) throw new Error("The indexed report worker completed without a response.");
		const result = Schema.decodeUnknownSync(Reply)(reply.message);
		if (result.stderr !== undefined)
			throw new Error(`Indexed report fixture failed: ${result.stderr}`);
		if (result.stdout === undefined)
			throw new Error("The indexed report worker omitted its output.");
		return result.stdout;
	} finally {
		port1.close();
	}
}

export function indexedTestReports(corpus: TextCorpus, evidence?: LocalizationTargetEvidence) {
	const fixture = createHash("sha256")
		.update(JSON.stringify([corpus, evidence]))
		.digest("hex");
	function read<S extends Schema.Codec<unknown, unknown>>(
		kind: "source" | "localization" | "corpus",
		schema: S,
		document?: GameTextRuleDocument,
		options?: LocalizationCheckOptions
	): S["Type"] {
		const key = JSON.stringify([fixture, kind, document, options]);
		if (!reports.has(key)) {
			const timing: (typeof timings)[number] = {
				kind,
				started: performance.now()
			};
			timings.push(timing);
			const result = reportInWorker(
				JSON.stringify({
					directory: join(directory, fixture),
					corpus,
					evidence,
					kind,
					document,
					options
				})
			);
			timing.durationMs = performance.now() - timing.started;
			reports.set(key, Schema.decodeSync(Schema.fromJsonString(schema))(result));
		}
		return Schema.decodeUnknownSync(schema)(reports.get(key));
	}
	return {
		corpus: () => read("corpus", TextCorpus),
		source: (document: GameTextRuleDocument) => read("source", TextQualityReport, document),
		localization: (document?: GameTextRuleDocument, options?: LocalizationCheckOptions) =>
			read("localization", LocalizationQualityReport, document, options)
	};
}
