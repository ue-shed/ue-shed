import { GameTextIndexBuilderLive } from "../packages/game-text/dist/entry-index.js";
import { AssetReader, AssetReaderLive } from "../packages/unreal-assets/dist/index.js";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { Context, Effect, Exit, Layer, Schema, Scope, Stream, type Tracer } from "effect";
import {
	GameTextIndexError,
	GameTextIndexRefresh,
	GameTextIndexSource,
	GameTextRuleDocument,
	STARTER_CHECK_RULES,
	gameTextIndexRefreshLayer,
	textQualityQuery,
	type GameTextIndexRefreshResult
} from "../packages/game-text/dist/index.js";
import { PackageTextStored } from "../packages/game-text/dist/package-text-columns.js";
import { packageTextShard } from "../packages/game-text/dist/package-text-layer.js";
import { LocalizationEvidenceNodeLive } from "../packages/localization/dist/index.js";
import { packageTextJsonLines } from "./retained-package-lines.ts";
import { packageTextSnapshotBatches } from "../packages/game-text/src/package-text-native.ts";
import { readGeneratedPackageInventory } from "./package-text-generated.ts";

/** Interval of the stall probe. A gap well above it means the event loop was blocked. */
export const stallIntervalMs = 10;

/** Retained package records stand in for the native reader; refresh and queries are production. */
export function retainedPackageSource(records: string) {
	const readFailure = (cause: unknown) =>
		new GameTextIndexError({
			nextStep: "escalate",
			retrySafe: false,
			code: "index_failed",
			operation: "read",
			message: "The generated project's package records could not be read.",
			recovery: "Convert the generated project's package records again.",
			cause
		});
	return Layer.succeed(
		GameTextIndexSource,
		GameTextIndexSource.of({
			inventory: () =>
				Effect.tryPromise({
					try: () => readGeneratedPackageInventory(records),
					catch: readFailure
				}),
			stage: (root, _entries, staging) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const reader = yield* AssetReader,
							stage = reader.stageProjectTextPackages;
						if (!stage || !staging.snapshots)
							return Stream.fail(
								readFailure(new Error("Reader snapshots are required."))
							);
						const snapshots = staging.snapshots;
						return Stream.fromIterable(
							packageTextSnapshotBatches(snapshots.shards)
						).pipe(
							Stream.flatMap((shards) =>
								stage({
									projectRoot: root,
									paths: [],
									staging: {
										directory: staging.directory,
										groups: [],
										snapshots: {
											...snapshots,
											shards,
											recordFiles: shards.map((shard) =>
												join(records, `package-text.${shard.group}.ndjson`)
											)
										}
									}
								}).pipe(
									Stream.filter((event) => event.event === "text_package_staged"),
									Stream.map((event) => ({
										path: relative(root, event.path).replaceAll("\\", "/"),
										file: join(staging.directory, `${event.group}.snapshot`)
									})),
									Stream.mapError(readFailure)
								)
							)
						);
					})
				).pipe(Stream.provide(AssetReaderLive), Stream.mapError(readFailure)),
			read: (_root, entries) =>
				Stream.fromAsyncIterable(
					(async function* () {
						const wanted = new Set(entries.map((entry) => entry.path));
						const decode = Schema.decodeUnknownSync(
							Schema.fromJsonString(PackageTextStored)
						);
						for (const shard of new Set(
							entries.map((entry) => packageTextShard(entry.path))
						))
							for await (const line of packageTextJsonLines(
								join(records, `package-text.${shard}.ndjson`)
							)) {
								const record = decode(line);
								if (!wanted.has(record.path)) continue;
								if (record.evidence.event === "not_gatherable")
									throw new Error("The index requested an excluded package.");
								yield record.evidence;
							}
					})(),
					readFailure
				)
		})
	);
}

/** Runs `effect` with `tracer` when one records the run's stages. */
const traced = <A, E>(effect: Effect.Effect<A, E>, tracer: Tracer.Tracer | undefined) =>
	tracer ? Effect.withTracer(effect, tracer) : effect;

/** Opens (or builds, in an empty cache) the generated target's index the way hosts do. */
export async function openScaleIndex(
	project: string,
	cache: string,
	records: string,
	tracer?: Tracer.Tracer
) {
	const scope = await Effect.runPromise(Scope.make());
	try {
		const context = await Effect.runPromise(
			Layer.buildWithScope(
				gameTextIndexRefreshLayer(cache).pipe(
					Layer.provide(retainedPackageSource(records)),
					Layer.provide(GameTextIndexBuilderLive.pipe(Layer.provide(AssetReaderLive))),
					Layer.provide(LocalizationEvidenceNodeLive)
				),
				scope
			)
		);
		const result = await Effect.runPromise(
			traced(
				Context.get(context, GameTextIndexRefresh)
					.refresh({ projectRoot: project, targetName: "Generated" })
					.pipe(Effect.provideService(Scope.Scope, scope)),
				tracer
			)
		);
		return {
			result,
			lines: result.joined.meta.count,
			close: () => Effect.runPromise(Scope.close(scope, Exit.void))
		};
	} catch (cause) {
		await Effect.runPromise(Scope.close(scope, Exit.void));
		throw cause;
	}
}

/** Gaps between ticks of a short interval timer while work runs on the same event loop. */
export function eventLoopGaps(intervalMs = stallIntervalMs) {
	const gaps: number[] = [],
		ends: number[] = [];
	const started = performance.now();
	let last = started;
	const tick = () => {
		const now = performance.now();
		gaps.push(now - last);
		ends.push(now - started);
		last = now;
	};
	const timer = setInterval(tick, intervalMs);
	return () => {
		clearInterval(timer);
		// The work can end inside a stall; its open gap counts too.
		tick();
		const sorted = Float64Array.from(gaps).sort();
		const at = (quantile: number) =>
			sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]!;
		// The three longest gaps and when they ended tell setup stalls from page stalls.
		const longest = Object.fromEntries(
			Array.from(gaps.keys())
				.sort((a, b) => gaps[b]! - gaps[a]!)
				.slice(0, 3)
				.flatMap((index, rank) => [
					[`stallTop${rank + 1}Ms`, gaps[index]!],
					[`stallTop${rank + 1}EndSeconds`, ends[index]! / 1000]
				])
		);
		return {
			stallIntervalMs: intervalMs,
			stallSamples: sorted.length,
			stallP50Ms: at(0.5),
			stallP95Ms: at(0.95),
			stallMaxMs: sorted.at(-1)!,
			stallsOver100Ms: sorted.filter((gap) => gap > 100).length,
			...longest
		};
	};
}

/**
 * Runs the opened index's localization quality scan with Workbench's options and the starter's
 * checks; without a rules file nothing would run.
 */
export async function scaleQuality(result: GameTextIndexRefreshResult, tracer?: Tracer.Tracer) {
	if (!result.localizationQuality)
		throw new Error("The opened index does not offer localization quality.");
	const stalls = eventLoopGaps();
	try {
		const quality = await Effect.runPromise(
			traced(
				result.localizationQuality(STARTER_CHECK_RULES, { review: result.review.file }),
				tracer
			)
		);
		const measured = stalls();
		// Findings by check, from the first page's counts.
		const page = await Effect.runPromise(
			quality.workspace.search({ target: result.localization.target, filter: "all" })
		);
		const byCheck: Record<string, number> = {};
		for (const [filter, count] of Object.entries(page.counts))
			if (filter !== "all" && count) byCheck[`findings.${filter}`] = count;
		return { quality, findings: page.counts.all, ...measured, ...byCheck };
	} catch (cause) {
		stalls();
		throw cause;
	}
}

/**
 * Source rules over the generated project's evidence. Every generated source holds each of the
 * generator's eight words, so the terminology rules match in every line their roles select.
 */
export const scaleSourceRules = Schema.decodeUnknownSync(GameTextRuleDocument)({
	schemaVersion: 1,
	roles: [
		{
			id: "labels",
			scopes: [
				{
					matchers: [
						{
							kind: "class_path",
							operator: "exact",
							value: "/Script/Engine.DataAsset"
						},
						{ kind: "property_path", operator: "prefix", value: "Label" }
					]
				}
			]
		},
		{
			id: "cells",
			scopes: [
				{
					matchers: [
						{ kind: "location_kind", value: "data_table_cell" },
						{ kind: "row", operator: "prefix", value: "Mirava" }
					]
				}
			]
		},
		{
			id: "entries",
			scopes: [
				{ matchers: [{ kind: "string_table_entry", operator: "prefix", value: "Taluma" }] }
			]
		},
		{
			id: "editor",
			scopes: [
				{ matchers: [{ kind: "property_path", operator: "prefix", value: "NodeTitle" }] }
			]
		},
		{
			id: "l10n",
			scopes: [
				{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/L10N/" }] }
			]
		}
	],
	rules: [
		{
			kind: "character_budget",
			id: "labels.limit",
			role: "labels",
			maximumCharacters: 130,
			recovery: "Shorten the label."
		},
		{
			kind: "character_budget",
			id: "cells.limit",
			role: "cells",
			maximumCharacters: 100,
			recovery: "Shorten the cell."
		},
		{
			kind: "terminology",
			id: "entries.terms",
			role: "entries",
			caseSensitive: true,
			terms: [{ kind: "preferred", term: "Taluma", alternatives: ["taluma"] }],
			recovery: "Capitalize the name."
		},
		{
			kind: "terminology",
			id: "editor.terms",
			role: "editor",
			caseSensitive: false,
			terms: [{ kind: "forbidden", term: "nimblet" }],
			recovery: "Remove the placeholder."
		},
		{
			kind: "terminology",
			id: "l10n.terms",
			role: "l10n",
			caseSensitive: false,
			terms: [{ kind: "preferred", term: "Solune", alternatives: ["solune", "lumeko"] }],
			recovery: "Use the preferred name."
		}
	]
});

/**
 * Source rules over the opened index, as a host evaluates them: `indexed` scans the index in
 * pages; `memory` evaluates the index's corpus in memory, the path hosts used before.
 */
export async function scaleSourceQuality(
	result: GameTextIndexRefreshResult,
	mode: "indexed" | "memory"
) {
	if (mode === "indexed" && !result.sourceQuality)
		throw new Error("The opened index does not offer source quality.");
	const stalls = eventLoopGaps();
	try {
		const indexed = await Effect.runPromise(result.sourceQuality(scaleSourceRules));
		const query =
			mode === "indexed"
				? indexed
				: textQualityQuery(await Effect.runPromise(indexed.export("all")));
		const measured = stalls();
		const summary = query.summary();
		// A first page and its last finding's focus, as a host shows them.
		const pageStarted = performance.now();
		const pageResult = query.search({ filter: "all", pageSize: 50 });
		const page = Effect.isEffect(pageResult) ? await Effect.runPromise(pageResult) : pageResult;
		const pageMs = performance.now() - pageStarted;
		const focusStarted = performance.now();
		const last = page.findings.at(-1);
		if (last) {
			const focused = query.focus({ id: last.id, pageSize: 50 });
			if (Effect.isEffect(focused)) await Effect.runPromise(focused);
		}
		const focusMs = performance.now() - focusStarted;
		return {
			query,
			findings: summary.findingCount,
			characterBudget: summary.characterBudgetCount,
			terminology: summary.terminologyCount,
			...Object.fromEntries(
				summary.roles.map((role) => [`units.${role.role}`, role.matchedTextUnits])
			),
			firstPageMs: pageMs,
			focusMs,
			...measured
		};
	} catch (cause) {
		stalls();
		throw cause;
	}
}
