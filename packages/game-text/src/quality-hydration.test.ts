import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { hydrateQualityRead, type QualityRead } from "./quality-hydration.js";

function* labels(): QualityRead<string, string> {
	const first = yield [0, 1];
	const second = yield [2];
	return [...first, ...second].join(",");
}

const items = ["a", "b", "c"];

describe("hydrateQualityRead", () => {
	it("reads again each time the same effect runs", async () => {
		const read = hydrateQualityRead(labels, (positions) =>
			Effect.succeed(positions.map((position) => items[position] ?? ""))
		);
		expect(await Effect.runPromise(read)).toBe("a,b,c");
		expect(await Effect.runPromise(read)).toBe("a,b,c");
	});

	it("starts over when a retry follows a failed hydration", async () => {
		let calls = 0;
		const read = hydrateQualityRead(labels, (positions) =>
			Effect.suspend(() =>
				++calls === 2
					? Effect.fail("transient")
					: Effect.succeed(positions.map((position) => items[position] ?? ""))
			)
		);
		expect(await Effect.runPromise(Effect.retry(read, { times: 1 }))).toBe("a,b,c");
		expect(calls).toBe(4);
	});
});
