import { it as effectIt } from "@effect/vitest";
import { MapHistoryContractError, parseMapHistoryQuery } from "./schema.js";
import { Effect } from "effect";
import { DateTime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	PerforceFastMapHistory,
	PerforceMapHistoryQuery,
	type PerforceFastMapHistory as PerforceFastMapHistoryType,
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
			schemaVersion: 2
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
				schemaVersion: 2
			})
		).toThrow();
	});
});

effectIt.effect(
	"fails a value outside the contract with a domain error that keeps the schema issue",
	() =>
		Effect.gen(function* () {
			// A peer from another version sends a value this side does not know.
			const error = yield* Effect.flip(
				parseMapHistoryQuery(JSON.parse('{ "unexpected": true }'))
			);
			expect(error).toBeInstanceOf(MapHistoryContractError);
			expect(error).toMatchObject({
				code: "invalid_contract",
				message: "The map history query does not match the map history contract.",
				retrySafe: false
			});
			expect(error.cause).toBeDefined();
		})
);
