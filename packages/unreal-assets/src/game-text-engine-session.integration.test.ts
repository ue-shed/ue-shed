import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { answerJson, type EngineProbe, GameTextEngineSession } from "./game-text-engine-session.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

/** The tests' engine is the debug build the gate compiles, which answers probes. */
const probe = (kind: EngineProbe["probe"], bulk = false): EngineProbe => ({
	action: "probe",
	probe: kind,
	bulk
});

const withSession = <A, E>(use: (session: GameTextEngineSession) => Effect.Effect<A, E>) =>
	Effect.runPromise(
		Effect.acquireUseRelease(
			Effect.sync(() => new GameTextEngineSession(executable!)),
			use,
			(session) => Effect.promise(() => session.close())
		)
	);

describe.skipIf(!executable)("the Game Text engine's failure paths", () => {
	it("fails only the request that panicked", async () => {
		await withSession((session) =>
			Effect.gen(function* () {
				yield* session.call({ action: "capabilities" });
				const generation = session.generation;
				expect(yield* Effect.flip(session.call(probe("panic")))).toMatchObject({
					kind: "process",
					code: "internal"
				});
				expect(answerJson(yield* session.call({ action: "capabilities" }))).toBeDefined();
				expect(session.generation).toBe(generation);
			})
		);
	});

	it("stops a cancelled request in the engine and keeps the process", async () => {
		await withSession((session) =>
			Effect.gen(function* () {
				yield* session.call({ action: "capabilities" });
				const generation = session.generation;
				const held = yield* Effect.forkChild(session.call(probe("hold", true)));
				yield* Effect.sleep("20 millis");
				yield* Fiber.interrupt(held);
				// The engine answers a keystroke at once, and well inside the stuck-session wait the
				// held request ends; a restart would change the generation.
				yield* session.call({ action: "capabilities" });
				yield* Effect.sleep("2500 millis");
				yield* session.call({ action: "capabilities" });
				expect(session.generation).toBe(generation);
			})
		);
	}, 10_000);

	it("credits each batch it gathers, so an answer streams past the engine's window", async () => {
		await withSession((session) =>
			Effect.gen(function* () {
				const answer = yield* session.call({
					action: "probe",
					probe: "stream",
					bulk: true,
					batches: 20
				});
				expect(answer.batches).toHaveLength(20);
				expect(answer.batches.map((batch) => batch.row(0))).toEqual(
					Array.from({ length: 20 }, () => ({ packageFile: "Probe", status: "complete" }))
				);
				expect(answer.profile.batches).toBe(20);
			})
		);
	});

	it("fails what was in flight when the engine dies, and starts a new one", async () => {
		await withSession((session) =>
			Effect.gen(function* () {
				yield* session.call({ action: "capabilities" });
				const generation = session.generation!;
				const held = yield* Effect.forkChild(session.call(probe("hold", true)));
				yield* Effect.sleep("20 millis");
				yield* Effect.flip(session.call(probe("abort")));
				expect(yield* Effect.flip(Fiber.join(held))).toMatchObject({
					kind: "process",
					code: "engine_unavailable"
				});
				yield* session.call({ action: "capabilities" });
				expect(session.generation).toBe(generation + 1);
			})
		);
	});
});
