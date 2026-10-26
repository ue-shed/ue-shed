import { Effect } from "effect";
import { nativeGameTextEngineClientLayer } from "../packages/unreal-assets/dist/index.js";
import type { GameTextContract } from "../packages/protocol/dist/index.js";
import { effectiveRuleDocument } from "../packages/game-text/src/rules/effective.ts";
import { STARTER_CHECK_RULES } from "../packages/game-text/src/starter-rules.ts";
import { SharedIndex, sharedIndexNodeLayer } from "../packages/game-text/src/shared-index.ts";
import { openNativeTextQuery } from "../packages/game-text/src/native-query.ts";
import type { TextCorpusSearchRequest } from "../packages/game-text/src/schema.ts";
import type { joinStoreOptions } from "./columnar-join.test-support.ts";
import type { NativeLineFacts } from "./columnar-join-fuzz.test-support.ts";

/** Read the stored lines back through the production typed client and process boundary. */
export function nativeEngineLines(executable: string) {
	return (
		configuration: ReturnType<typeof joinStoreOptions>,
		request: TextCorpusSearchRequest
	): Promise<NativeLineFacts> =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const root = yield* Effect.gen(function* () {
						return yield* (yield* SharedIndex).inspect();
					}).pipe(Effect.provide(sharedIndexNodeLayer(configuration)));
					const query = yield* openNativeTextQuery({
						configuration: { ...configuration, sharedProject: false },
						generation: root.generation,
						joinedKey: root.active.joined ?? "missing-test-join"
					});
					return {
						lines: yield* query.readLocalizationLines(),
						exported: yield* query.selectLocalizationLines(request, [
							"identity",
							"source",
							"marks"
						]),
						page: yield* query.search(request)
					};
				})
			).pipe(Effect.provide(nativeGameTextEngineClientLayer({ executable })))
		);
}

type NativeTextQuery = Effect.Success<ReturnType<typeof openNativeTextQuery>>;
/** A findings page as a query returns it, without its timing. */
type QueriedFindingsPage = Omit<
	Effect.Success<ReturnType<NativeTextQuery["findingsQuery"]>>,
	"stages"
>;

/** What a findings layer reads as: its summary, its findings in each order, and its diagnostics. */
export interface NativeFindingsRead {
	readonly evaluation: Omit<GameTextContract.FindingsEvaluation, "profile">;
	readonly pages: Readonly<Record<string, readonly QueriedFindingsPage[]>>;
}

/**
 * Evaluate every starter check through the production client and read the layer back in pages.
 * `full` evaluates every row, as `UE_SHED_GAME_TEXT_FULL_EVALUATION` asks of the engine process.
 */
export function nativeEngineFindings(executable: string) {
	return async (
		configuration: ReturnType<typeof joinStoreOptions>,
		full = false
	): Promise<NativeFindingsRead & { readonly incremental: boolean }> => {
		// Full evaluates every row; otherwise the closure has no size limit, so small corpora
		// evaluate incrementally too.
		const name = full
			? "UE_SHED_GAME_TEXT_FULL_EVALUATION"
			: "UE_SHED_GAME_TEXT_UNLIMITED_CLOSURE";
		process.env[name] = "1";
		try {
			return await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const root = yield* Effect.gen(function* () {
							return yield* (yield* SharedIndex).inspect();
						}).pipe(Effect.provide(sharedIndexNodeLayer(configuration)));
						const query = yield* openNativeTextQuery({
							configuration: { ...configuration, sharedProject: false },
							generation: root.generation,
							joinedKey: root.active.joined ?? "missing-test-join"
						});
						const { profile, ...evaluation } = yield* query.findingsEvaluate(
							effectiveRuleDocument(STARTER_CHECK_RULES, {})
						);
						const size = 500;
						const pages: Record<string, QueriedFindingsPage[]> = {};
						for (const [view, order] of [
							["report", "report"],
							["workspace", "line"],
							["workspace", "source"]
						] as const) {
							const rows: QueriedFindingsPage[] = [];
							for (let offset = 0; ; offset += size) {
								const { stages: _stages, ...page } = yield* query.findingsQuery({
									key: evaluation.key,
									view,
									order,
									offset,
									limit: size,
									...(offset === 0 ? { counts: true } : undefined),
									diagnostics: { offset, limit: size }
								});
								rows.push(page);
								if (
									page.findings.length < size &&
									(page.diagnostics?.rows.length ?? 0) < size
								)
									break;
							}
							pages[`${view}.${order}`] = rows;
						}
						const stages = "stages" in profile ? profile.stages : {};
						const subStages = "subStages" in profile ? profile.subStages : {};
						return {
							evaluation,
							pages,
							// A subject evaluated fewer rows than it has: its closure chose them.
							incremental: ["line", "line_culture"].some(
								(subject) =>
									(stages[`${subject}.closure`]?.rows ?? Infinity) <
									(subStages[`${subject}.closure.select`]?.rows ?? 0)
							)
						};
					})
				).pipe(Effect.provide(nativeGameTextEngineClientLayer({ executable })))
			);
		} finally {
			delete process.env[name];
		}
	};
}
