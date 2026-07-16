import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { CliRuntime, executeCommand } from "./application.js";
import { CliCommand } from "./command.js";

it.effect("acquires and finalizes the CLI runtime exactly once", () =>
	Effect.gen(function* () {
		const acquired = yield* Ref.make(0);
		const finalized = yield* Ref.make(0);
		const output = yield* Ref.make("");
		const layer = Layer.effect(
			CliRuntime,
			Effect.acquireRelease(
				Ref.update(acquired, (count) => count + 1).pipe(
					Effect.as(
						CliRuntime.of({
							print: (value) => Ref.update(output, (current) => current + value),
							setExitCode: () => Effect.void
						})
					)
				),
				() => Ref.update(finalized, (count) => count + 1)
			)
		);

		yield* Effect.scoped(
			executeCommand(CliCommand.cases.Help.make({})).pipe(Effect.provide(layer))
		);

		expect(yield* Ref.get(acquired)).toBe(1);
		expect(yield* Ref.get(finalized)).toBe(1);
		expect(yield* Ref.get(output)).toContain("UE Shed");
	})
);
