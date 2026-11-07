/// <reference types="node" />
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { Schema } from "effect";
import { afterAll, TestRunner } from "vitest";
import { LocalizationQualityReport } from "./localization-quality-schema.js";
import { TextQualityReport } from "./quality-schema.js";
import { TextCorpus } from "./schema.js";
import { createIndexedReportDirectory } from "./indexed-report-directory.test-support.js";
// One persistent index per immutable suite fixture, shared by every rule document and test.
// The synchronous bridge keeps presentation fixtures usable at module initialization. A reusable
// worker retains loaded modules; every request rebuilds its input and runs the scoped index path.
const directory = createIndexedReportDirectory();
const reports = new Map();
const timings = [];
export const indexedReportDiagnostics = () => timings.slice();
// Collection has no current test. Use the same finite budget as native-backed route fixtures.
export const INDEXED_REPORT_FIXTURE_TIMEOUT_MS = 20_000;
let worker;
let generation = 0;
const terminations = [];
const Reply = Schema.Struct({
    stdout: Schema.optionalKey(Schema.String),
    stderr: Schema.optionalKey(Schema.String)
});
const decodeReply = Schema.decodeUnknownSync(Reply);
afterAll(async () => {
    if (worker)
        terminations.push(worker.terminate());
    await Promise.all(terminations);
    rmSync(directory, { recursive: true, force: true });
});
function reportInWorker(input, timing) {
    if (!worker) {
        const environment = {
            ...process.env,
            UE_SHED_TELEMETRY_MODE: "disabled"
        };
        if (process.platform === "linux")
            environment.TMPDIR = directory;
        worker = new Worker(resolve("packages/game-text/src/indexed-report-worker.test-support.mjs"), {
            execArgv: [],
            env: environment
        });
    }
    const { port1, port2 } = new MessageChannel();
    const state = new SharedArrayBuffer(16 + 8192);
    const completion = new Int32Array(state);
    try {
        worker.postMessage({ input, reply: port2, state }, [port2]);
        // Caller-thread error/exit listeners cannot run while Atomics.wait blocks this thread.
        // Bound collection and disabled/invalid test deadlines as well as active test requests.
        const timeout = TestRunner.getCurrentTest()?.timeout;
        const waitMs = timeout !== undefined && Number.isFinite(timeout) && timeout > 0
            ? timeout
            : INDEXED_REPORT_FIXTURE_TIMEOUT_MS;
        if (Atomics.wait(completion, 0, 0, waitMs) === "timed-out") {
            terminations.push(worker.terminate());
            worker = undefined;
            // Abrupt worker termination cannot run snapshot finalizers. Never reuse its locks.
            generation++;
            throw new Error(`The indexed report worker did not respond within ${waitMs} ms; it may have exited. ` +
                `Stage ${Atomics.load(completion, 1)}, module loading ${Atomics.load(completion, 2)} ms.`);
        }
        const reply = receiveMessageOnPort(port1);
        if (!reply)
            throw new Error("The indexed report worker completed without a response.");
        const result = decodeReply(reply.message);
        if (result.stderr !== undefined)
            throw new Error(`Indexed report fixture failed: ${result.stderr}`);
        if (result.stdout === undefined)
            throw new Error("The indexed report worker omitted its output.");
        return result.stdout;
    }
    finally {
        const stage = Atomics.load(completion, 1);
        timing.workerStage = stage === 1 ? "loading modules" : stage === 2 ? "report" : "starting";
        timing.moduleLoadMs = Atomics.load(completion, 2);
        timing.reportTrace = new TextDecoder().decode(new Uint8Array(state, 16, Atomics.load(completion, 3)));
        timing.durationMs = performance.now() - timing.started;
        port1.close();
    }
}
export function indexedTestReports(corpus, evidence) {
    const fixture = createHash("sha256")
        .update(JSON.stringify([corpus, evidence]))
        .digest("hex");
    function read(kind, schema, document, options) {
        const key = JSON.stringify([fixture, kind, document, options]);
        if (!reports.has(key)) {
            const timing = {
                kind,
                started: performance.now(),
                temporaryDirectory: directory
            };
            timings.push(timing);
            const result = reportInWorker(JSON.stringify({
                directory: join(directory, `worker-${generation}`, fixture),
                corpus,
                evidence,
                kind,
                document,
                options
            }), timing);
            reports.set(key, Schema.decodeSync(Schema.fromJsonString(schema))(result));
        }
        return Schema.decodeUnknownSync(schema)(reports.get(key));
    }
    return {
        corpus: () => read("corpus", TextCorpus),
        source: (document) => read("source", TextQualityReport, document),
        localization: (document, options) => read("localization", LocalizationQualityReport, document, options)
    };
}
