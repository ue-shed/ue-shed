import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";

const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const BoundedString = Schema.String.check(Schema.isMaxLength(4_096));
const NonEmptyBoundedString = Schema.NonEmptyString.check(Schema.isMaxLength(4_096));
const UtcTimestamp = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
);

export const BenchmarkDistribution = Schema.Struct({
	count: PositiveInt,
	maxMs: NonNegativeNumber,
	meanMs: NonNegativeNumber,
	minMs: NonNegativeNumber,
	p50Ms: NonNegativeNumber,
	p95Ms: NonNegativeNumber,
	samplesMs: Schema.Array(NonNegativeNumber).check(Schema.isMinLength(1))
});
export interface BenchmarkDistribution extends Schema.Schema.Type<typeof BenchmarkDistribution> {}

export const BenchmarkIndexObservation = Schema.Struct({
	cacheHits: NonNegativeInt,
	emittedHeaders: NonNegativeInt,
	inputCandidates: NonNegativeInt,
	inventoryFiles: NonNegativeInt,
	packageFiles: NonNegativeInt,
	sidecarFiles: NonNegativeInt
});

export const BenchmarkScenarioSample = Schema.Struct({
	cacheBytes: NonNegativeInt,
	durationMs: NonNegativeNumber,
	failureKind: Schema.optionalKey(NonEmptyBoundedString),
	index: Schema.optionalKey(BenchmarkIndexObservation),
	inputPackages: Schema.optionalKey(NonNegativeInt),
	largestProtocolFrameBytes: NonNegativeInt,
	nodePeakRssBytes: PositiveInt,
	protocolBytes: NonNegativeInt,
	rustPeakRssBytes: Schema.NullOr(PositiveInt)
});
export interface BenchmarkScenarioSample extends Schema.Schema.Type<
	typeof BenchmarkScenarioSample
> {}

export const BenchmarkScenario = Schema.Struct({
	distribution: BenchmarkDistribution,
	failureKinds: Schema.Array(NonEmptyBoundedString),
	notes: NonEmptyBoundedString,
	samples: Schema.Array(BenchmarkScenarioSample).check(Schema.isMinLength(1)),
	status: Schema.Literals(["completed", "failed"])
});
export interface BenchmarkScenario extends Schema.Schema.Type<typeof BenchmarkScenario> {}

export const ProjectIndexBenchmarkEvidence = Schema.Struct({
	schemaVersion: Schema.Literal(2),
	generatedAt: UtcTimestamp,
	configuration: Schema.Struct({
		mutationScenarios: Schema.Literals(["not_requested", "disposable_project"]),
		reader: NonEmptyBoundedString,
		readerBuild: Schema.Literals(["performed", "skipped"]),
		runs: PositiveInt,
		warmups: NonNegativeInt
	}),
	git: Schema.Struct({
		dirty: Schema.Boolean,
		revision: NonEmptyBoundedString
	}),
	machine: Schema.Struct({
		architecture: NonEmptyBoundedString,
		cpuCount: PositiveInt,
		cpuModel: BoundedString,
		memoryBytes: PositiveInt,
		nodeVersion: NonEmptyBoundedString,
		operatingSystem: NonEmptyBoundedString,
		rustVersion: NonEmptyBoundedString
	}),
	scenarios: Schema.Struct({
		"project_index.cold_build": BenchmarkScenario,
		"project_index.one_changed_package": Schema.optionalKey(BenchmarkScenario),
		"project_index.one_deleted_package": Schema.optionalKey(BenchmarkScenario),
		"project_index.warm_noop": BenchmarkScenario
	})
});
export interface ProjectIndexBenchmarkEvidence extends Schema.Schema.Type<
	typeof ProjectIndexBenchmarkEvidence
> {}

function roundMilliseconds(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function percentile(sorted: readonly number[], fraction: number): number {
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
	return sorted[index] ?? 0;
}

export function summarizeDurations(samples: readonly number[]): BenchmarkDistribution {
	if (samples.length === 0)
		throw new Error("A benchmark distribution requires at least one sample.");
	const sorted = [...samples].sort((left, right) => left - right);
	const sum = samples.reduce((total, value) => total + value, 0);
	return {
		count: samples.length,
		maxMs: roundMilliseconds(sorted.at(-1) ?? 0),
		meanMs: roundMilliseconds(sum / samples.length),
		minMs: roundMilliseconds(sorted[0] ?? 0),
		p50Ms: roundMilliseconds(percentile(sorted, 0.5)),
		p95Ms: roundMilliseconds(percentile(sorted, 0.95)),
		samplesMs: samples.map(roundMilliseconds)
	};
}

function assertScenario(name: string, scenario: BenchmarkScenario, runs: number): void {
	if (scenario.samples.length !== runs) {
		throw new Error(`${name} contains ${scenario.samples.length} samples; expected ${runs}.`);
	}
	const expectedDistribution = summarizeDurations(
		scenario.samples.map((sample) => sample.durationMs)
	);
	if (!isDeepStrictEqual(scenario.distribution, expectedDistribution)) {
		throw new Error(`${name} distribution does not match its samples.`);
	}
	const failureKinds = [
		...new Set(
			scenario.samples.flatMap((sample) =>
				sample.failureKind === undefined ? [] : [sample.failureKind]
			)
		)
	];
	if (!isDeepStrictEqual(scenario.failureKinds, failureKinds)) {
		throw new Error(`${name} failureKinds do not match its samples.`);
	}
	const expectedStatus = failureKinds.length === 0 ? "completed" : "failed";
	if (scenario.status !== expectedStatus) {
		throw new Error(`${name} status does not match its samples.`);
	}
	for (const sample of scenario.samples) {
		if (sample.failureKind === undefined && sample.index === undefined) {
			throw new Error(`${name} has a successful sample without aggregate index evidence.`);
		}
		if (sample.failureKind !== undefined && sample.index !== undefined) {
			throw new Error(`${name} has a failed sample containing index evidence.`);
		}
	}
}

function assertNoSensitiveValues(value: unknown, sensitiveValues: readonly string[]): void {
	const serialized = JSON.stringify(value).replaceAll("\\", "/").toLowerCase();
	for (const sensitiveValue of sensitiveValues) {
		const normalized = sensitiveValue.replaceAll("\\", "/").toLowerCase();
		if (normalized.length > 0 && serialized.includes(normalized)) {
			throw new Error(
				"Benchmark evidence contains a supplied project path or asset identity."
			);
		}
	}
}

export function validateProjectIndexBenchmarkEvidence(
	input: unknown,
	sensitiveValues: readonly string[] = []
): ProjectIndexBenchmarkEvidence {
	const evidence = Schema.decodeUnknownSync(ProjectIndexBenchmarkEvidence)(input);
	if (!isDeepStrictEqual(input, evidence)) {
		throw new Error(
			"Benchmark evidence contains fields outside the aggregate evidence contract."
		);
	}
	const scenarios = evidence.scenarios;
	const changed = scenarios["project_index.one_changed_package"];
	const deleted = scenarios["project_index.one_deleted_package"];
	const mutationsExpected = evidence.configuration.mutationScenarios === "disposable_project";
	if (
		(changed !== undefined) !== mutationsExpected ||
		(deleted !== undefined) !== mutationsExpected
	) {
		throw new Error("Mutation scenario evidence does not match the benchmark configuration.");
	}
	for (const [name, scenario] of Object.entries(scenarios)) {
		if (scenario !== undefined) assertScenario(name, scenario, evidence.configuration.runs);
	}
	assertNoSensitiveValues(evidence, sensitiveValues);
	return evidence;
}
