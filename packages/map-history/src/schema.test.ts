import { DateTime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	PerforceMapHistory,
	PerforceMapHistoryQuery,
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
		const history = {
			baseline: { change: 120, status: "available" },
			completeness: "complete",
			diagnostics: [],
			mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
			query,
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
});
