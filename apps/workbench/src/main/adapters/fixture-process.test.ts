import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { FixtureProcess, fixtureProcessLayer } from "./fixture-process.js";

it.live("retains build diagnostics from stdout as well as stderr before reporting failure", () =>
	Effect.gen(function* () {
		const launcher = yield* FixtureProcess;
		const result = yield* launcher.launch({
			executable: process.execPath,
			cwd: process.cwd(),
			args: [
				"-e",
				"process.stdout.write('Build refused: existing engine files would change.\\n'); process.stderr.write('Build.bat exited with 5.\\n'); process.exitCode = 5;"
			]
		});
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.message).toContain("existing engine files would change");
			expect(result.message).toContain("Build.bat exited with 5");
		}
	}).pipe(Effect.provide(fixtureProcessLayer({})), Effect.scoped)
);
