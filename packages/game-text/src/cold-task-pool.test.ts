import { describe, expect, it } from "vitest";
import { Deferred, Effect } from "effect";
import { runColdTasks } from "./cold-task-pool.js";

describe("cold task memory reservations", () => {
	it("starts the largest file together with smaller work that fits", async () => {
		const gates = Array.from({ length: 3 }, () => Effect.runSync(Deferred.make<number>()));
		const firstWave = Effect.runSync(Deferred.make<void>());
		const started: number[] = [];
		const pending = runColdTasks(
			[
				{ row: 0, bytes: 10 },
				{ row: 1, bytes: 8 },
				{ row: 2, bytes: 2 }
			],
			12,
			2,
			(row) => {
				started.push(row);
				if (started.length === 2) Effect.runSync(Deferred.succeed(firstWave, undefined));
				return Effect.runPromise(Deferred.await(gates[row]!));
			}
		);
		await Effect.runPromise(Deferred.await(firstWave));
		expect(started).toEqual([0, 2]);
		Effect.runSync(Deferred.succeed(gates[2]!, 20));
		Effect.runSync(Deferred.succeed(gates[0]!, 0));
		Effect.runSync(Deferred.succeed(gates[1]!, 10));
		expect(await pending).toEqual({ results: [0, 10, 20], workerCount: 2 });
	});
	it("runs an oversized task alone and respects the CPU bound", async () => {
		let active = 0;
		const started: number[] = [];
		const result = await runColdTasks(
			[
				{ row: 0, bytes: 100 },
				{ row: 1, bytes: 1 },
				{ row: 2, bytes: 1 }
			],
			10,
			1,
			async (row) => {
				active++;
				expect(active).toBe(1);
				started.push(row);
				await Promise.resolve();
				active--;
				return row;
			}
		);
		expect(started).toEqual([1, 2, 0]);
		expect(result.workerCount).toBe(1);
	});
	it("stops scheduling after a failure", async () => {
		const started: number[] = [];
		await expect(
			runColdTasks(
				[
					{ row: 0, bytes: 2 },
					{ row: 1, bytes: 1 }
				],
				10,
				1,
				async (row) => {
					started.push(row);
					throw new Error("parse failed");
				}
			)
		).rejects.toThrow("parse failed");
		expect(started).toEqual([0]);
	});
});
