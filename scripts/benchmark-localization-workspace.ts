import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Exit, Schema } from "effect";
import { GameTextRuleDocument } from "../packages/game-text/src/game-text-rules.ts";
import {
	workspaceScaleFixture,
	workspaceScaleRules
} from "../packages/game-text/src/localization-workspace-scale.test-support.ts";
import { localizationQualityWorkspaceOf } from "../packages/game-text/src/localization-workspace.ts";
import { eventLoopGaps } from "./game-text-scale-quality.ts";
import { GameTextIndexRefresh } from "../packages/game-text/src/index-refresh.ts";

// node --import tsx --max-old-space-size=12288 scripts/benchmark-localization-workspace.ts [lines]
const count = Number(process.argv[2] ?? 238_000);
const stallLimit = process.env.UE_SHED_WORKSPACE_STALL_CHECK === "1" ? 250 : Infinity;
const violations: string[] = [];
const sourcePrefix = process.env.UE_SHED_WORKSPACE_SOURCE_PREFIX;
const rules = sourcePrefix
	? Schema.decodeUnknownSync(GameTextRuleDocument)({
			...workspaceScaleRules,
			roles: workspaceScaleRules.roles.map((role) => ({
				...role,
				scopes: role.scopes.map((scope) => ({
					...scope,
					matchers: [
						...scope.matchers,
						{ kind: "property_path", operator: "prefix", value: sourcePrefix }
					]
				}))
			}))
		})
	: workspaceScaleRules;
// An optional module path allows the same harness to measure a saved pre-change implementation.
const build: typeof localizationQualityWorkspaceOf = process.argv[3]
	? (await import(pathToFileURL(resolve(process.argv[3])).href)).localizationQualityWorkspaceOf
	: localizationQualityWorkspaceOf;
if (!Number.isSafeInteger(count) || count < 1) throw new Error("Choose a positive line count.");
const report = (
	stage: string,
	started: number,
	gaps: ReturnType<ReturnType<typeof eventLoopGaps>>
) => {
	if (gaps.stallMaxMs > stallLimit) violations.push(`${stage}: ${gaps.stallMaxMs.toFixed(1)} ms`);
	console.log(
		JSON.stringify({
			stage,
			ms: performance.now() - started,
			...gaps,
			heapMiB: process.memoryUsage().heapUsed / 1024 ** 2
		})
	);
};
// The gap sampler's interval keeps the process alive, so it stops however the stage ends.
const measure = <A>(stage: string, run: () => A) => {
	const stop = eventLoopGaps();
	const started = performance.now();
	let gaps: ReturnType<typeof stop> | undefined;
	try {
		const value = run();
		gaps = stop();
		report(stage, started, gaps);
		return value;
	} finally {
		if (!gaps) stop();
	}
};
// Pages hydrate asynchronously: time the read through to its result, not its construction.
const measureRead = <A, E, R>(stage: string, read: () => Effect.Effect<A, E, R>) =>
	Effect.suspend(() => {
		const stop = eventLoopGaps();
		const started = performance.now();
		return read().pipe(
			Effect.onExit((exit) =>
				Effect.sync(() => {
					const gaps = stop();
					if (Exit.isSuccess(exit)) report(stage, started, gaps);
				})
			)
		);
	});
await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			// The service is only needed after the fixture supplies its isolated layer.
			const { fixture, target } = yield* workspaceScaleFixture(count);
			yield* Effect.gen(function* () {
				const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
				console.log(
					JSON.stringify({
						stage: "prepared",
						lines: result.joined.meta.count,
						cultures: target.cultures.length
					})
				);
				const quality = yield* result.localizationQuality(rules);
				const first = yield* quality.workspace.search({
					target: target.name,
					filter: "all"
				});
				console.log(JSON.stringify({ stage: "scanned", findings: first.total }));
				for (const pass of ["cold", "warm"]) {
					const workspace = measure(`build:${pass}`, () => build(undefined, quality));
					yield* Effect.yieldNow;
					for (const offset of [0, Math.floor(first.total / 2)]) {
						const page = yield* measureRead(`page:${pass}:${offset}`, () =>
							workspace.search({ target: target.name, filter: "all", offset })
						);
						yield* Effect.yieldNow;
						console.log(
							JSON.stringify({
								stage: "result",
								total: page.total,
								counts: page.counts,
								hash: createHash("sha256")
									.update(JSON.stringify(page))
									.digest("hex")
							})
						);
					}
					for (const filter of ["terminology", "placeholder_text"] as const)
						for (const offset of [0, 1000]) {
							const page = yield* measureRead(
								`page:${pass}:${filter}:${offset}`,
								() => workspace.search({ target: target.name, filter, offset })
							);
							console.log(
								JSON.stringify({
									stage: "result",
									total: page.total,
									hash: createHash("sha256")
										.update(JSON.stringify(page))
										.digest("hex")
								})
							);
							yield* Effect.yieldNow;
						}
					for (const culture of target.cultures.slice(0, 2)) {
						yield* measureRead(`page:${pass}:${culture}`, () =>
							workspace.search({ target: target.name, filter: "all", culture })
						);
						yield* Effect.yieldNow;
					}
				}
			}).pipe(Effect.provide(fixture.layer()));
		})
	)
).catch((cause) => {
	console.error(cause);
	process.exitCode = 1;
});
if (violations.length) {
	console.error(`Workspace stall limit exceeded: ${violations.join(", ")}`);
	process.exitCode = 1;
}
