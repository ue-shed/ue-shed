import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Schema } from "effect";
import {
	assertEngineAnswers,
	decodeEngineRequestMix,
	engineAnswerHash,
	engineAnswerDigest,
	engineAnswerJson,
	engineStatistics,
	engineRequestOverhead,
	decodeEngineRustTiming,
	EngineStageResult,
	EngineBenchmarkResult
} from "./game-text-engine-results.ts";

const mix: unknown = JSON.parse(
	readFileSync(new URL("./game-text-engine-mix.json", import.meta.url), "utf8")
);
test("native timing decoding refuses combined spans that would be mislabelled as pipe time", () => {
	assert.equal(
		decodeEngineRustTiming({ requestId: "r", ms: { bulkEncode: 5 } }).ms.bulkEncode,
		5
	);
	assert.throws(
		() => decodeEngineRustTiming({ requestId: "r", ms: { bulkEncodeAndWrite: 5 } }),
		/obsolete/u
	);
	assert.throws(() => decodeEngineRustTiming({ requestId: "r", ms: { engineTotal: -1 } }));
});
test("overhead correlates requests, excludes setup and keeps write callbacks separate", () => {
	const result = engineRequestOverhead(
		"small:0",
		20,
		[
			{ stage: "tsFrameEncode", ms: 1, sampleId: "small:0", requestId: "r" },
			{ stage: "tsFrameParse", ms: 2, sampleId: "small:0", requestId: "r" },
			{ stage: "tsPayloadDecode", ms: 3, sampleId: "small:0" },
			{ stage: "tsPipeWriteCallback", ms: 10, sampleId: "small:0" },
			{ stage: "tsFrameEncode", ms: 1000, requestId: "setup" }
		],
		[
			{ requestId: "r", ms: { engineTotal: 5, payloadEncode: 2, pipeWrite: 10 } },
			{ requestId: "setup", ms: { engineTotal: 1000 } }
		]
	);
	assert.equal(result.engineComputeMs, 5);
	assert.equal(result.pipeQueueResidualMs, 7);
	assert.equal(result.tsWriteCallbackMs, 10);
	assert.equal(result.rustPipeWriteMs, 10);
	assert.equal(
		engineRequestOverhead("x", 1, [{ stage: "tsFrameEncode", ms: 2, sampleId: "x" }], [])
			.measurementOverlapMs,
		1
	);
});
test("the replay data decodes and preserves host fan-out bounds", () => {
	const decoded = decodeEngineRequestMix(mix);
	assert.equal(decoded.selection.relatedLines, 20);
	assert.deepEqual(decoded.transportRows, [50, 5000, "all"]);
	assert(decoded.queries.some((query) => /\P{ASCII}/u.test(query)));
	assert.throws(() => decodeEngineRequestMix({ ...decoded, unknown: true }));
	assert.throws(() => decodeEngineRequestMix({ ...decoded, sources: [] }));
	assert.throws(() => decodeEngineRequestMix({ ...decoded, transportRows: [50, 5001, "all"] }));
});
test("nearest-rank statistics handle outliers, duplicates and invalid input", () => {
	assert.deepEqual(engineStatistics([50, 1, 2]), { n: 3, p50: 2, p95: 50, p99: 50 });
	assert.deepEqual(engineStatistics([7]), { n: 1, p50: 7, p95: 7, p99: 7 });
	assert.equal(engineStatistics(Array.from({ length: 100 }, (_, i) => i + 1)).p95, 95);
	for (const invalid of [[], [-1], [NaN], [Infinity]])
		assert.throws(() => engineStatistics(invalid));
});
test("answer hashing ignores key insertion order, preserves row order and UTF-16", () => {
	assert.equal(
		engineAnswerHash({ b: 2, a: [{ y: 1, x: 2 }] }),
		engineAnswerHash({ a: [{ x: 2, y: 1 }], b: 2 })
	);
	assert.notEqual(engineAnswerHash([1, 2]), engineAnswerHash([2, 1]));
	assert.notEqual(engineAnswerHash("\ud800"), engineAnswerHash("\ufffd"));
});
test("streamed answer digests match canonical JSON across escaped UTF-16 chunk boundaries", () => {
	for (const value of [
		null,
		[],
		{ "20": "twenty", "3": "three" },
		{ a: [undefined, "x"], absent: undefined },
		"x".repeat(16383) + '😀\ud800\\\n"\udfff',
		"x".repeat(16384) + "😀"
	]) {
		const json = engineAnswerJson(value);
		assert.deepEqual(engineAnswerDigest(value), {
			sha256: createHash("sha256").update(json).digest("hex"),
			bytes: Buffer.byteLength(json)
		});
	}
});
test("result schema rejects invalid measurements and mismatches stop comparisons", () => {
	const decode = Schema.decodeUnknownSync(EngineStageResult);
	const result = decode({
		schemaVersion: 1,
		stage: "open",
		node: "v26.12.0",
		peakHeapBytes: 1,
		peakRssBytes: 2,
		samples: [
			{ id: "page", ms: 1, sha256: engineAnswerHash([]), bytes: 2, requests: 1, metrics: {} }
		]
	});
	assertEngineAnswers([result, result]);
	assert.throws(() => assertEngineAnswers([result, { ...result, samples: [] }]), /STOP/u);
	assert.throws(
		() =>
			assertEngineAnswers([
				result,
				{ ...result, samples: [{ ...result.samples[0]!, sha256: engineAnswerHash([1]) }] }
			]),
		/STOP/u
	);
	assert.throws(() => decode({ ...result, peakHeapBytes: -1 }));
	assert.throws(() => decode({ ...result, samples: [{ ...result.samples[0], ms: Infinity }] }));
	const report = {
		schemaVersion: 1,
		commit: "a".repeat(40),
		node: "v26.12.0",
		machine: {
			hostname: "fixture",
			platform: "win32",
			release: "test",
			logicalProcessors: 32,
			totalMemoryBytes: 64 * 1024 ** 3
		},
		caps: {
			rayonThreads: 16,
			cargoJobs: 8,
			maximumHeapMiB: 16384,
			maximumRssBytes: 20_000_000_000,
			maximumStageSeconds: 1200
		},
		mix,
		qualityRules: {},
		results: [result],
		statistics: { page: engineStatistics([1, 2, 3]) }
	};
	const decodeReport = Schema.decodeUnknownSync(EngineBenchmarkResult);
	assert.equal(decodeReport(report).results.length, 1);
	assert.throws(() => decodeReport({ ...report, commit: "invalid" }));
	assert.throws(() => decodeReport({ ...report, caps: { ...report.caps, rayonThreads: 32 } }));
});
