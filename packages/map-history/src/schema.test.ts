import { DateTime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	PerforceFastMapHistory,
	PerforceFastMapHistoryQuery,
	PerforceMapHistory,
	PerforceMapHistoryQuery,
	type PerforceFastMapHistory as PerforceFastMapHistoryType,
	type PerforceFastMapHistoryQuery as PerforceFastMapHistoryQueryType,
	type PerforceMapHistory as PerforceMapHistoryType,
	type PerforceMapHistoryQuery as PerforceMapHistoryQueryType
} from "./schema.js";

const query = {
	limits: {
		maxChangelists: 100,
		maxConcurrency: 4,
		maxDurationMs: 60_000,
		maxMaterializedFiles: 10_000,
		maxPackages: 10_000
	},
	mapPath: "Content/Maps/L_Example.umap",
	projectRoot: "C:/Project",
	range: {
		since: "2026-07-21T00:00:00.000Z",
		until: "2026-07-28T00:00:00.000Z"
	}
};

describe("Map History schemas", () => {
	it("round-trips a bounded Perforce query", () => {
		const decoded = Schema.decodeUnknownSync(PerforceMapHistoryQuery)(query);
		const encoded = Schema.encodeSync(PerforceMapHistoryQuery)(decoded);
		expect(encoded).toEqual(query);
		expect(DateTime.formatIso(decoded.range.since)).toBe(query.range.since);
		expect(DateTime.formatIso(decoded.range.until)).toBe(query.range.until);
		decoded satisfies PerforceMapHistoryQueryType;
	});

	it("round-trips an empty complete history", () => {
		const snapshot = {
			actors: [],
			completeness: "complete" as const,
			diagnostics: [],
			mapPackage: "/Game/Maps/L_Example",
			mapPath: "Content/Maps/L_Example.umap",
			sourceKind: "level" as const,
			summary: {
				failedPackages: 0,
				partialPackages: 0,
				resolvedActors: 0,
				scannedPackages: 1
			}
		};
		const history = {
			baseline: { change: 120, status: "available" },
			completeness: "complete",
			diagnostics: [],
			mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
			query,
			rangeEndSnapshot: snapshot,
			rangeStartSnapshot: snapshot,
			revisions: [],
			schemaVersion: 1
		};
		const decoded = Schema.decodeUnknownSync(PerforceMapHistory)(history);
		const encoded = Schema.encodeSync(PerforceMapHistory)(decoded);
		expect(encoded).toEqual(history);
		decoded satisfies PerforceMapHistoryType;
	});

	it("rejects unbounded query limits", () => {
		expect(() =>
			Schema.decodeUnknownSync(PerforceMapHistoryQuery)({
				...query,
				limits: { ...query.limits, maxChangelists: 0 }
			})
		).toThrow();
	});

	it("rejects a backwards time range", () => {
		expect(() =>
			Schema.decodeUnknownSync(PerforceMapHistoryQuery)({
				...query,
				range: { since: query.range.until, until: query.range.since }
			})
		).toThrow();
	});

	it("round-trips a Fast History actor Investigation Target query", () => {
		const fastQuery = {
			limits: query.limits,
			mapPath: query.mapPath,
			mode: "fast",
			projectRoot: query.projectRoot,
			range: query.range,
			target: {
				identity: {
					actorGuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
					kind: "actor_guid"
				},
				kind: "actor"
			}
		};
		const decoded = Schema.decodeUnknownSync(PerforceFastMapHistoryQuery)(fastQuery);
		const encoded = Schema.encodeSync(PerforceFastMapHistoryQuery)(decoded);
		expect(encoded).toEqual(fastQuery);
		decoded satisfies PerforceFastMapHistoryQueryType;
	});

	it("round-trips a Fast History actor-class Investigation Target query", () => {
		const fastQuery = {
			limits: query.limits,
			mapPath: query.mapPath,
			mode: "fast",
			projectRoot: query.projectRoot,
			range: query.range,
			target: { classPath: "/Script/Game.Npc", kind: "actor_class" }
		};
		const decoded = Schema.decodeUnknownSync(PerforceFastMapHistoryQuery)(fastQuery);
		const encoded = Schema.encodeSync(PerforceFastMapHistoryQuery)(decoded);
		expect(encoded).toEqual(fastQuery);
		decoded satisfies PerforceFastMapHistoryQueryType;
	});

	it("round-trips Fast History targeted coverage without claiming complete map coverage", () => {
		const fastHistory = {
			baseline: { status: "map_not_yet_created" },
			completeness: "complete",
			coverage: {
				acquiredPackages: [
					{
						depotFileSpec: "//Project/Main/Content/Maps/L_Example.*",
						packageName: "/Game/Maps/L_Example",
						role: "selected_map"
					},
					{
						depotFileSpec:
							"//Project/Main/Content/__ExternalActors__/Maps/L_Example/A/Actor.*",
						packageName: "/Game/__ExternalActors__/Maps/L_Example/A/Actor",
						role: "investigation_target_actor"
					}
				],
				claimsCompleteMapCoverage: false,
				claimsHistoricalClassCoverage: false,
				investigationTarget: {
					actorGuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
					actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Actor_1",
					classPath: "/Script/Engine.Actor",
					identity: {
						actorGuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
						kind: "actor_guid"
					},
					kind: "actor",
					packageName: "/Game/__ExternalActors__/Maps/L_Example/A/Actor"
				},
				kind: "targeted"
			},
			diagnostics: [],
			mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
			mode: "fast",
			query: {
				limits: query.limits,
				mapPath: query.mapPath,
				mode: "fast",
				projectRoot: query.projectRoot,
				range: query.range,
				target: {
					identity: {
						actorGuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
						kind: "actor_guid"
					},
					kind: "actor"
				}
			},
			revisions: [],
			schemaVersion: 1
		};
		const decoded = Schema.decodeUnknownSync(PerforceFastMapHistory)(fastHistory);
		const encoded = Schema.encodeSync(PerforceFastMapHistory)(decoded);
		expect(encoded).toEqual(fastHistory);
		expect(decoded.coverage.claimsCompleteMapCoverage).toBe(false);
		expect(decoded.coverage.claimsHistoricalClassCoverage).toBe(false);
		decoded satisfies PerforceFastMapHistoryType;
	});

	it("rejects Fast History coverage that claims complete map coverage", () => {
		expect(() =>
			Schema.decodeUnknownSync(PerforceFastMapHistory)({
				baseline: { status: "map_not_yet_created" },
				completeness: "complete",
				coverage: {
					acquiredPackages: [],
					claimsCompleteMapCoverage: true,
					claimsHistoricalClassCoverage: false,
					investigationTarget: {
						actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Actor_1",
						classPath: "/Script/Engine.Actor",
						identity: {
							actorGuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
							kind: "actor_guid"
						},
						kind: "actor",
						packageName: "/Game/__ExternalActors__/Maps/L_Example/A/Actor"
					},
					kind: "targeted"
				},
				diagnostics: [],
				mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
				mode: "fast",
				query: {
					limits: query.limits,
					mapPath: query.mapPath,
					mode: "fast",
					projectRoot: query.projectRoot,
					range: query.range,
					target: {
						identity: {
							actorGuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
							kind: "actor_guid"
						},
						kind: "actor"
					}
				},
				revisions: [],
				schemaVersion: 1
			})
		).toThrow();
	});
});
