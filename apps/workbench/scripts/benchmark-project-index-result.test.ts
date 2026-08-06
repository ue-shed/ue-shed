import { describe, expect, it } from "vitest";
import {
	summarizeDurations,
	validateProjectIndexBenchmarkEvidence
} from "./benchmark-project-index-result.js";

function sample(durationMs: number) {
	return {
		cacheBytes: 128,
		durationMs,
		index: {
			changedPackages: 1,
			emittedHeaders: 1,
			generation: 1,
			inputCandidates: 0,
			mapCount: 0,
			packageCount: 1,
			queryPages: 5,
			removedPackages: 0
		},
		largestProtocolFrameBytes: 64,
		nodePeakRssBytes: 1024,
		protocolBytes: 256,
		rustPeakRssBytes: null,
		timings: {
			foldingMs: 1,
			native: {
				committingMs: 1,
				comparingMs: 2,
				committedEvidenceRows: 1,
				durationMs: 5,
				enumeratingMs: 1,
				evidenceWriteMs: 1,
				headerReads: 1,
				headerProcessingExcludingEvidenceWritesMs: 0,
				removedEvidenceRows: 0,
				readingHeadersMs: 1,
				stagedEvidenceRows: 1
			},
			queryMs: 3,
			refreshMs: 6
		}
	};
}

function scenario() {
	const samples = [sample(10), sample(20)];
	return {
		distribution: summarizeDurations(samples.map((entry) => entry.durationMs)),
		failureKinds: [],
		notes: "Aggregate fixture evidence.",
		samples,
		status: "completed" as const
	};
}

function evidence() {
	return {
		schemaVersion: 4 as const,
		generatedAt: "2026-08-04T00:00:00.000Z",
		configuration: {
			mutationScenarios: "not_requested" as const,
			reader: "uasset.exe",
			readerBuild: "performed" as const,
			runs: 2,
			warmups: 1
		},
		git: { dirty: true, revision: "abcdef" },
		machine: {
			architecture: "x64",
			cpuCount: 1,
			cpuModel: "Fixture CPU",
			memoryBytes: 1024,
			nodeVersion: "v26",
			operatingSystem: "fixture",
			rustVersion: "rustc fixture"
		},
		scenarios: {
			"project_index.cold_build": scenario(),
			"project_index.warm_noop": scenario()
		}
	};
}

describe("project-index benchmark evidence", () => {
	it("accepts coherent aggregate evidence", () => {
		expect(validateProjectIndexBenchmarkEvidence(evidence())).toEqual(evidence());
	});

	it("rejects unknown fields and supplied paths", () => {
		const withPath = { ...evidence(), projectRoot: "C:/Studio/SecretProject" };
		expect(() => validateProjectIndexBenchmarkEvidence(withPath)).toThrow("outside");

		const leakedInNotes = evidence();
		leakedInNotes.scenarios["project_index.cold_build"].notes =
			"Measured C:/Studio/SecretProject";
		expect(() =>
			validateProjectIndexBenchmarkEvidence(leakedInNotes, ["C:/Studio/SecretProject"])
		).toThrow("project path");
	});

	it("rejects drift between samples, summaries, and mutation configuration", () => {
		const drifted = evidence();
		drifted.scenarios["project_index.cold_build"] = {
			...drifted.scenarios["project_index.cold_build"],
			distribution: {
				...drifted.scenarios["project_index.cold_build"].distribution,
				meanMs: 999
			}
		};
		expect(() => validateProjectIndexBenchmarkEvidence(drifted)).toThrow("distribution");

		const original = evidence();
		const missingMutations = {
			...original,
			configuration: {
				...original.configuration,
				mutationScenarios: "disposable_project" as const
			}
		};
		expect(() => validateProjectIndexBenchmarkEvidence(missingMutations)).toThrow(
			"Mutation scenario"
		);
	});
});
