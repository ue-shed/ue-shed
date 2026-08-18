import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import {
	makePerforceHistorySourceTestLayer,
	type PerforceHistorySourceApi,
	type PerforceSubmittedChange
} from "./perforce.js";
import { MapHistoryRange } from "./schema.js";
import { selectSubmittedChanges } from "./submitted-change-selection.js";

function range() {
	return Schema.decodeUnknownSync(MapHistoryRange)({
		since: "2026-07-21T00:00:00.000Z",
		until: "2026-07-28T00:00:00.000Z"
	});
}

function change(changeNumber: number, submittedAt?: string): PerforceSubmittedChange {
	return {
		change: changeNumber,
		...(submittedAt === undefined ? undefined : { submittedAt })
	};
}

function source(
	pages: ReadonlyMap<
		number | undefined,
		{
			readonly hasMore: boolean;
			readonly items: readonly PerforceSubmittedChange[];
			readonly nextBeforeChange: number | null;
		}
	>
): PerforceHistorySourceApi {
	return {
		describeChangelist: () =>
			Effect.die("The submitted-change selection test must not describe changelists."),
		listDepotFilesAtChange: () =>
			Effect.die("The submitted-change selection test must not inventory depot files."),
		listSubmittedChangelists: (options) =>
			Effect.succeed(
				pages.get(options.beforeChange) ?? {
					hasMore: false,
					items: [],
					nextBeforeChange: null
				}
			),
		materializeDepotFiles: () =>
			Effect.die("The submitted-change selection test must not materialize files."),
		resolveLocalPath: () =>
			Effect.die("The submitted-change selection test must not resolve local Perforce paths.")
	};
}

function provide(sourceApi: PerforceHistorySourceApi) {
	return Layer.provide(makePerforceHistorySourceTestLayer(sourceApi), Layer.empty);
}

describe("selectSubmittedChanges", () => {
	it.effect(
		"deduplicates a combined map scope and returns an ascending range plus baseline",
		() => {
			const selection = selectSubmittedChanges({
				fileSpecs: [
					"//Project/Main/Content/Maps/L_Example.umap",
					"//Project/Main/Content/__ExternalActors__/Maps/L_Example/..."
				],
				maxChangelists: 5,
				range: range()
			});
			const layer = provide(
				source(
					new Map([
						[
							undefined,
							{
								hasMore: true,
								items: [
									change(120, "2026-07-29T00:00:00.000Z"),
									change(118, "2026-07-27T00:00:00.000Z"),
									change(117, "2026-07-26T00:00:00.000Z"),
									change(117, "2026-07-26T00:00:00.000Z")
								],
								nextBeforeChange: 116
							}
						],
						[
							116,
							{
								hasMore: false,
								items: [
									change(115, "2026-07-22T00:00:00.000Z"),
									change(114, "2026-07-20T00:00:00.000Z")
								],
								nextBeforeChange: null
							}
						]
					])
				)
			);

			return Effect.gen(function* () {
				const result = yield* selection;
				expect(result.baseline?.change).toBe(114);
				expect(result.revisions.map((entry) => entry.change)).toEqual([115, 117, 118]);
			}).pipe(Effect.provide(layer));
		}
	);

	it.effect("fails instead of silently truncating a range at its changelist limit", () => {
		const selection = selectSubmittedChanges({
			fileSpecs: ["//Project/Main/Content/Maps/L_Example.umap"],
			maxChangelists: 1,
			range: range()
		});
		const layer = provide(
			source(
				new Map([
					[
						undefined,
						{
							hasMore: false,
							items: [
								change(118, "2026-07-27T00:00:00.000Z"),
								change(117, "2026-07-26T00:00:00.000Z")
							],
							nextBeforeChange: null
						}
					]
				])
			)
		);

		return Effect.gen(function* () {
			const error = yield* Effect.flip(selection);
			expect(error.kind).toBe("resource_limit");
		}).pipe(Effect.provide(layer));
	});

	it.effect("rejects missing Perforce submission timestamps", () => {
		const selection = selectSubmittedChanges({
			fileSpecs: ["//Project/Main/Content/Maps/L_Example.umap"],
			maxChangelists: 1,
			range: range()
		});
		const layer = provide(
			source(
				new Map([
					[undefined, { hasMore: false, items: [change(118)], nextBeforeChange: null }]
				])
			)
		);

		return Effect.gen(function* () {
			const error = yield* Effect.flip(selection);
			expect(error.kind).toBe("perforce_command");
		}).pipe(Effect.provide(layer));
	});

	it.effect("rejects an unbounded pagination response", () => {
		const selection = selectSubmittedChanges({
			fileSpecs: ["//Project/Main/Content/Maps/L_Example.umap"],
			maxChangelists: 1,
			range: range()
		});
		const layer = provide(
			source(
				new Map([
					[
						undefined,
						{
							hasMore: true,
							items: [change(120, "2026-07-29T00:00:00.000Z")],
							nextBeforeChange: null
						}
					]
				])
			)
		);

		return Effect.gen(function* () {
			const error = yield* Effect.flip(selection);
			expect(error.kind).toBe("perforce_command");
		}).pipe(Effect.provide(layer));
	});
});
