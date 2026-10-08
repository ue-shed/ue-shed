import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFiles, LocalFilesLive } from "./local-files.js";

it.effect("exclusive writes create once and leave existing bytes untouched", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const directory = yield* Effect.acquireRelease(
				Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-baseline-"))),
				(directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
			);
			const files = yield* LocalFiles;
			const path = join(directory, "baseline.json");
			yield* files.writeFile(path, new TextEncoder().encode("first"), { exclusive: true });
			const result = yield* files
				.writeFile(path, new TextEncoder().encode("second"), { exclusive: true })
				.pipe(Effect.result);
			expect(result._tag).toBe("Failure");
			expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe("first");
		})
	).pipe(Effect.provide(LocalFilesLive))
);
