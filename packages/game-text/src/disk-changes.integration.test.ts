import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { LocalizationTargetName } from "@ue-shed/localization/browser";
import { assetReaderLayer } from "@ue-shed/unreal-assets";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { GameTextIndexRefresh, gameTextIndexRefreshLayer } from "./index-refresh.js";
import { gameTextIndexSourceNodeLayer } from "./index-source-node.js";
import { GameTextIndexSteps } from "./index-steps.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();
const PACKAGE = "Content/Fixture/Localization/DA_Localization.uasset";
const PO = "Content/Localization/FixtureGame/de/FixtureGame.po";

/** Moves a file's modification time a minute ahead, as saving the same bytes again does. */
const touch = async (path: string) => {
	const file = join(fixture.root, path);
	const { mtime } = await stat(file);
	const later = new Date(mtime.getTime() + 60_000);
	await utimes(file, later, later);
};

describe.skipIf(!executable)("what on disk differs from the index", () => {
	it("lists a saved package and a localization file touched after a scan, until the next scan", async () => {
		if (!executable) throw new Error("Native reader required");
		const cacheRoot = await mkdtemp(join(tmpdir(), "ue-shed-disk-changes-"));
		const target = LocalizationTargetName.make("FixtureGame");
		try {
			const outcome = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const indexes = yield* GameTextIndexRefresh;
						const steps = yield* GameTextIndexSteps;
						const check = steps.diskChanges({
							projectRoot: fixture.root,
							target,
							limit: 1000
						});
						const before = yield* check;
						yield* Effect.scoped(
							indexes.refresh({ projectRoot: fixture.root, targetName: target })
						);
						const scanned = yield* check;
						yield* Effect.promise(() => touch(PACKAGE));
						yield* Effect.promise(() => touch(PO));
						const touched = yield* check;
						const named = yield* steps.diskChanges({
							projectRoot: fixture.root,
							target,
							paths: [
								PACKAGE,
								PO,
								"Content/Fixture/Localization/DT_Localization.uasset"
							],
							limit: 1
						});
						yield* Effect.scoped(
							indexes.refresh({ projectRoot: fixture.root, targetName: target })
						);
						const rescanned = yield* check;
						return { before, scanned, touched, named, rescanned };
					})
				).pipe(
					Effect.provide(
						gameTextIndexRefreshLayer(cacheRoot).pipe(
							Layer.provide(gameTextIndexSourceNodeLayer(cacheRoot)),
							Layer.provide(
								nativeIndexBuilderLayer({
									executable,
									timeoutMs: 60_000,
									catalogTimeoutMs: 120_000
								})
							),
							Layer.provide(LocalizationEvidenceNodeLive)
						)
					),
					Effect.provide(assetReaderLayer({ executable }))
				)
			);
			const none = { added: 0, changed: 0, removed: 0 };
			expect(outcome.before).toEqual({ status: "not_indexed" });
			expect(outcome.scanned).toEqual({
				status: "ready",
				counts: { packages: none, localization: none },
				items: []
			});
			expect(outcome.touched).toEqual({
				status: "ready",
				counts: {
					packages: { ...none, changed: 1 },
					localization: { ...none, changed: 1 }
				},
				items: [
					{ kind: "package", change: "changed", path: PACKAGE },
					{ kind: "localization", change: "changed", path: PO }
				]
			});
			// Named paths check only those; a page lists one and points at the next.
			expect(outcome.named).toEqual({
				status: "ready",
				counts: {
					packages: { ...none, changed: 1 },
					localization: { ...none, changed: 1 }
				},
				items: [{ kind: "package", change: "changed", path: PACKAGE }],
				nextCursor: PACKAGE
			});
			expect(outcome.rescanned).toEqual(outcome.scanned);
		} finally {
			await rm(cacheRoot, { recursive: true, force: true });
		}
	}, 240_000);
});
