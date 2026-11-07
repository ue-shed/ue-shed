import { Cache, Effect } from "effect";
import { expect, it } from "vitest";
import { runJoinedQuery } from "./joined-query-node.js";
it("keeps large synchronous cache lookups synchronous beyond the scheduler yield budget", () => {
    let lookups = 0;
    const cache = runJoinedQuery(Cache.make({
        capacity: 1,
        lookup: (key) => Effect.gen(function* () {
            lookups++;
            let total = 0;
            for (let index = 0; index < 5000; index++)
                total += yield* Effect.sync(() => key.length);
            return total;
        })
    }));
    expect(runJoinedQuery(Cache.get(cache, "text"))).toBe(20000);
    expect(runJoinedQuery(Cache.get(cache, "text"))).toBe(20000);
    expect(lookups).toBe(1);
});
it("still rejects asynchronous work at the synchronous query boundary", () => {
    expect(() => runJoinedQuery(Effect.promise(() => Promise.resolve(1)))).toThrow(/asynchronous Effect/);
});
