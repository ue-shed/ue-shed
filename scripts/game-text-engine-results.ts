/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get -- Canonical JSON serialization recursively inspects arbitrary schema-validated API answers; these are representation operations, not domain inference. */
import { createHash } from "node:crypto";
import { Schema } from "effect";

const NonNegative = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const EngineRequestMix = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	sources: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
	list: Schema.Struct({
		query: Schema.Literal(""),
		capability: Schema.Literal("all"),
		lens: Schema.Literal("all"),
		withoutNotes: Schema.Literal(false),
		group: Schema.Literal("problem"),
		pageSize: Schema.Literal(50),
		facets: Schema.Struct({
			folder: Schema.Literal(""),
			assets: Schema.Literal(true),
			origins: Schema.Literal(true),
			audiences: Schema.Literal(true),
			assetTypes: Schema.Literal(true),
			cultures: Schema.Literal(true)
		})
	}),
	queries: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
	hosts: Schema.Array(
		Schema.Struct({
			name: Schema.Literals(["workbench", "electroswag"]),
			excludeEditor: Schema.Boolean,
			openGroups: Schema.Literals(["default", "all"])
		})
	).check(Schema.isMinLength(1)),
	selection: Schema.Struct({
		pageSize: Schema.Literal(50),
		causeSearchPages: Schema.Literal(4),
		relatedLines: Schema.Literal(20),
		keySearchPageSize: Schema.Literal(21),
		concurrency: Schema.Literal(4)
	}),
	transportRows: Schema.Tuple([Schema.Literal(50), Schema.Literal(5000), Schema.Literal("all")])
});
export type EngineRequestMix = typeof EngineRequestMix.Type;
export const decodeEngineRequestMix = Schema.decodeUnknownSync(EngineRequestMix, {
	onExcessProperty: "error"
});

export const EngineSample = Schema.Struct({
	id: Schema.NonEmptyString,
	ms: NonNegative,
	sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
	bytes: Count,
	requests: Count,
	metrics: Schema.Record(Schema.String, NonNegative)
});
export type EngineSample = typeof EngineSample.Type;
export const EngineTsTiming = Schema.Struct({
	stage: Schema.String,
	ms: NonNegative,
	sampleId: Schema.optionalKey(Schema.String),
	requestId: Schema.optionalKey(Schema.String),
	action: Schema.optionalKey(Schema.String)
});
export const EngineRustTiming = Schema.Struct({
	requestId: Schema.String,
	ms: Schema.Record(Schema.String, NonNegative)
});

export function decodeEngineRustTiming(input: unknown) {
	const timing = Schema.decodeUnknownSync(EngineRustTiming)(input);
	if ("bulkEncodeAndWrite" in timing.ms)
		throw new Error(
			"The reader has obsolete combined bulk timings; rebuild it with the current benchmark-timings feature."
		);
	return timing;
}

/** Correlate side-channel spans by request ID, excluding setup and overlapping write callbacks. */
export function engineRequestOverhead(
	sampleId: string,
	wallMs: number,
	ts: readonly (typeof EngineTsTiming.Type)[],
	rust: readonly (typeof EngineRustTiming.Type)[]
) {
	const events = ts.filter((event) => event.sampleId === sampleId);
	const ids = new Set(events.flatMap((event) => (event.requestId ? [event.requestId] : [])));
	const native = rust.filter((event) => ids.has(event.requestId));
	const tsSum = (...stages: string[]) =>
		events.reduce((sum, event) => sum + (stages.includes(event.stage) ? event.ms : 0), 0);
	const rustSum = (...stages: string[]) =>
		native.reduce(
			(sum, event) => sum + stages.reduce((sum, stage) => sum + (event.ms[stage] ?? 0), 0),
			0
		);
	const parts = {
		tsEncodeMs: tsSum("tsDomainEncode", "tsClientSchema", "tsFrameEncode"),
		rustDecodeValidateMs: rustSum(
			"frameDecodeValidate",
			"requestValidate",
			"payloadDecodeValidate"
		),
		engineComputeMs: rustSum("engineTotal"),
		rustEncodeMs: rustSum("payloadEncode", "frameEncode", "bulkEncode"),
		bulkWriteMs: rustSum("bulkBufferedWrite", "bulkFlush"),
		tsFrameParseMs: tsSum("tsFrameParse"),
		tsPayloadDecodeMs: tsSum("tsPayloadDecode"),
		tsBulkReadMs: tsSum("tsBulkRead")
	};
	const residual = wallMs - Object.values(parts).reduce((sum, ms) => sum + ms, 0);
	return {
		...parts,
		instrumentedRequests: native.length,
		// Accepted-frame parsing can overlap native compute; retain excess rather than hiding it.
		pipeQueueResidualMs: Math.max(0, residual),
		measurementOverlapMs: Math.max(0, -residual),
		tsWriteCallbackMs: tsSum("tsPipeWriteCallback"),
		rustPipeWriteMs: rustSum("pipeWrite")
	};
}
export const EngineStageResult = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	stage: Schema.NonEmptyString,
	node: Schema.NonEmptyString,
	peakHeapBytes: Count,
	peakRssBytes: Count,
	samples: Schema.Array(EngineSample)
});
export type EngineStageResult = typeof EngineStageResult.Type;
export const EngineBenchmarkResult = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
	node: Schema.NonEmptyString,
	machine: Schema.Struct({
		hostname: Schema.String,
		platform: Schema.String,
		release: Schema.String,
		cpu: Schema.optionalKey(Schema.String),
		logicalProcessors: Count,
		totalMemoryBytes: Count
	}),
	caps: Schema.Struct({
		rayonThreads: Schema.Literal(16),
		cargoJobs: Schema.Literal(8),
		maximumHeapMiB: Count,
		maximumRssBytes: Count,
		maximumStageSeconds: NonNegative
	}),
	mix: EngineRequestMix,
	qualityRules: Schema.Json,
	results: Schema.Array(EngineStageResult),
	statistics: Schema.Record(
		Schema.String,
		Schema.Struct({ n: Count, p50: NonNegative, p95: NonNegative, p99: NonNegative })
	)
});

/** Nearest-rank quantiles; never interpolate a latency that was not observed. */
export function engineStatistics(values: readonly number[]) {
	if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0))
		throw new Error("Statistics need finite, non-negative samples.");
	const sorted = [...values].sort((a, b) => a - b);
	const quantile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
	return { n: sorted.length, p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99) };
}

/** Sort object keys without changing arrays or authored strings, including lone surrogates. */
export function engineAnswerJson(answer: unknown): string {
	const result = JSON.stringify(answer, (_key, value: unknown) => {
		if (value !== null && typeof value === "object" && !Array.isArray(value))
			return Object.fromEntries(
				Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			);
		return value;
	});
	if (result === undefined) throw new Error("An answer must be a JSON value.");
	return result;
}

export function engineAnswerHash(answer: unknown) {
	return engineAnswerDigest(answer).sha256;
}

/** Hash large answers without allocating another whole-result JSON string. */
export function engineAnswerDigest(answer: unknown) {
	const hash = createHash("sha256");
	let bytes = 0;
	const emit = (text: string) => {
		hash.update(text);
		bytes += Buffer.byteLength(text);
	};
	const text = (value: string) => {
		emit('"');
		for (let offset = 0; offset < value.length; ) {
			let end = Math.min(value.length, offset + 16_384);
			// Keep a surrogate pair together when escaping a bounded chunk.
			const last = value.charCodeAt(end - 1);
			if (end < value.length && last >= 0xd800 && last <= 0xdbff) end++;
			emit(JSON.stringify(value.slice(offset, end)).slice(1, -1));
			offset = end;
		}
		emit('"');
	};
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			text(value);
			return;
		}
		if (Array.isArray(value)) {
			emit("[");
			for (let index = 0; index < value.length; index++) {
				if (index) emit(",");
				visit(value[index] === undefined ? null : value[index]);
			}
			emit("]");
		} else if (value !== null && typeof value === "object") {
			emit("{");
			let first = true;
			const keys = Object.keys(
				Object.fromEntries(
					Object.keys(value)
						.sort()
						.map((key) => [key, null])
				)
			);
			for (const key of keys) {
				const item = Reflect.get(value, key);
				if (item === undefined) continue;
				if (!first) emit(",");
				first = false;
				text(key);
				emit(":");
				visit(item);
			}
			emit("}");
		} else {
			const encoded = JSON.stringify(value);
			if (encoded === undefined) throw new Error("An answer must be a JSON value.");
			emit(encoded);
		}
	};
	visit(answer);
	return { sha256: hash.digest("hex"), bytes };
}

/** A different answer stops the whole comparison, including any later spike runs. */
export function assertEngineAnswers(runs: readonly EngineStageResult[]) {
	const hashes = new Map<string, string>();
	const sequences = new Map<string, string>();
	for (const run of runs) {
		const sequence = JSON.stringify(run.samples.map((sample) => sample.id).sort());
		const previous = sequences.get(run.stage);
		if (previous !== undefined && previous !== sequence)
			throw new Error(`STOP: request sequence differs for ${run.stage}.`);
		sequences.set(run.stage, sequence);
		for (const sample of run.samples) {
			const key = `${run.stage}:${sample.id}`;
			const previous = hashes.get(key);
			if (previous !== undefined && previous !== sample.sha256)
				throw new Error(`STOP: answer hash differs for ${key}.`);
			hashes.set(key, sample.sha256);
		}
	}
}
