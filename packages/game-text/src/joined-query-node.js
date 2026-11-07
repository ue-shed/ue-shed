import { Effect, Scheduler } from "effect";
/**
 * Node adapter for the synchronous TextCorpusQuery contract. Input effects need no services and
 * use only synchronousJoinedTarget's pinned handles, owned by the caller's SharedIndex scope.
 * Yielding is disabled so a synchronous cache lookup cannot yield into a child fiber.
 */
export const runJoinedQuery = (effect) => Effect.runSync(effect.pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)));
