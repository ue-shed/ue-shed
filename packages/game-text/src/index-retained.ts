import { Effect, Exit, RcRef, Ref, Scope } from "effect";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import {
	GameTextIndexRefresh,
	type GameTextIndexRefreshRequest,
	type GameTextIndexRefreshResult
} from "./index-refresh.js";

/**
 * Index model with explicit host and operation pins. Borrow it in each operation's scope before
 * lazy reads; retain transfers publication ownership while outstanding users keep the old
 * generation alive.
 */
export interface RetainedGameTextIndexResult extends GameTextIndexRefreshResult {
	/** The opened model's revision; a retained legacy adapter's model gets its own. */
	readonly revision: string;
	/** Pin this generation in the calling operation's scope before using its lazy projections. */
	readonly borrow: Effect.Effect<void, never, Scope.Scope>;
	/** Call after publishing this model; outstanding users of the previous model keep their pins. */
	readonly retain: Effect.Effect<void>;
}

let retainedModels = 0;

/**
 * Preparation belongs to the operation; publication transfers a pin to the host.
 * release({ background: true }) detaches ownership immediately and finalizes in the host scope;
 * the default release waits for finalization. Existing operation pins remain valid in either case.
 */
export const makeRetainedGameTextIndexWith = Effect.fn("GameTextIndex.retain")(function* (
	prepare: (
		request: GameTextIndexRefreshRequest
	) => ReturnType<typeof GameTextIndexRefresh.Service.refresh>
) {
	const acquire = prepare;
	const reportProgress = yield* GameTextIndexProgressReporter;
	const hostScope = yield* Effect.scope;
	const current = yield* Ref.make<
		{ readonly owner: Scope.Closeable; readonly retired: Ref.Ref<boolean> } | undefined
	>(undefined);
	const release = Effect.fn("GameTextIndex.release")(
		(options: { readonly background?: boolean } = {}) =>
			Effect.gen(function* () {
				const previous = yield* Ref.getAndSet(current, undefined);
				if (previous) {
					yield* Ref.set(previous.retired, true);
					const close = Scope.close(previous.owner, Exit.void);
					if (options.background) yield* close.pipe(Effect.forkIn(hostScope));
					else yield* close;
				}
			}).pipe(Effect.uninterruptible)
	);
	yield* Effect.addFinalizer(() => release());
	const refresh = Effect.fn("GameTextIndex.retainedRefresh")(
		(request: GameTextIndexRefreshRequest) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const lifetime = yield* Scope.fork(hostScope);
					const retired = yield* Ref.make(false);
					const resource = yield* RcRef.make({
						acquire: Effect.gen(function* () {
							if (yield* Ref.get(retired)) return yield* Effect.interrupt;
							yield* Effect.addFinalizer(() =>
								Ref.set(retired, true).pipe(
									Effect.andThen(Scope.close(lifetime, Exit.void))
								)
							);
							return yield* acquire(request).pipe(
								Effect.provideService(GameTextIndexProgressReporter, (progress) => {
									if (!Ref.getUnsafe(retired)) reportProgress(progress);
								})
							);
						})
					}).pipe(Effect.provideService(Scope.Scope, lifetime));
					const result = yield* restore(RcRef.get(resource)).pipe(
						Effect.onError(() => Scope.close(lifetime, Exit.void))
					);
					let retained = false;
					yield* Effect.addFinalizer(() =>
						retained ? Effect.void : Ref.set(retired, true)
					);
					const borrow = Effect.gen(function* () {
						if (yield* Ref.get(retired)) return yield* Effect.interrupt;
						// Preparation has succeeded; a live pin reuses it and a retired pin interrupts.
						yield* RcRef.get(resource).pipe(Effect.orDie);
					});
					const retain = Effect.uninterruptible(
						Effect.gen(function* () {
							if (retained) return;
							const owner = yield* Scope.make();
							yield* borrow.pipe(
								Effect.provideService(Scope.Scope, owner),
								Effect.onError(() => Scope.close(owner, Exit.void))
							);
							retained = true;
							const previous = yield* Ref.getAndSet(current, { owner, retired });
							if (previous) {
								yield* Ref.set(previous.retired, true);
								// Publication owns the new model now. Retire the old scope in the host
								// scope so finalizers cannot hold the publication lock indefinitely.
								yield* Scope.close(previous.owner, Exit.void).pipe(
									Effect.forkIn(hostScope)
								);
							}
						})
					);
					return {
						project: result.project,
						queryRevision: result.queryRevision,
						revision: result.revision ?? `retained:${++retainedModels}`,
						get joined() {
							return result.joined;
						},
						localizationQuality: result.localizationQuality,
						prepareLocalizationCheck: result.prepareLocalizationCheck,
						localizationCheck: result.localizationCheck,
						sourceQuality: result.sourceQuality,
						get imported() {
							return result.imported;
						},
						get packages() {
							return result.packages;
						},
						get join() {
							return result.join;
						},
						query: result.query,
						summary: result.summary,
						get localization() {
							return result.localization;
						},
						get corpus() {
							return result.corpus;
						},
						get localizationJoin() {
							return result.localizationJoin;
						},
						get evidence() {
							return result.evidence;
						},
						get review() {
							return result.review;
						},
						borrow,
						retain,
						search: Effect.fn("GameTextIndex.retainedSearch")(
							(request: Parameters<GameTextIndexRefreshResult["search"]>[0]) =>
								borrow.pipe(Effect.andThen(result.search(request))),
							Effect.scoped
						),
						searchRows: Effect.fn("GameTextIndex.retainedSearchRows")(
							(request: Parameters<GameTextIndexRefreshResult["searchRows"]>[0]) =>
								borrow.pipe(Effect.andThen(result.searchRows(request))),
							Effect.scoped
						)
					} satisfies RetainedGameTextIndexResult;
				})
			)
	);
	return { refresh, release };
});

/** Compatibility retainer for the convenience refresh service. */
export const makeRetainedGameTextIndex = Effect.fn("GameTextIndex.retainedRefresh")(function* () {
	const service = yield* GameTextIndexRefresh;
	return yield* makeRetainedGameTextIndexWith(service.refresh);
});
