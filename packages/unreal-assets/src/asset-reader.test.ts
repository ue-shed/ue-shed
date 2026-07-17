import { it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { expect } from "vitest";
import { AssetReaderError, discoverSavedAssets, makeAssetReaderTestLayer } from "./index.js";

const unexpected = (operation: string) => Effect.die(new Error(`Unexpected ${operation} call`));

it.effect("routes saved-asset discovery through the AssetReader service", () =>
	Effect.gen(function* () {
		const requestedRoots = yield* Ref.make<readonly string[]>([]);
		const layer = makeAssetReaderTestLayer({
			catalogProgress: () => unexpected("catalogProgress"),
			discoverAssets: Effect.fn("AssetReader.Test.discoverAssets")(function* (
				projectRoot: string
			) {
				yield* Ref.update(requestedRoots, (roots) => [...roots, projectRoot]);
				return [`${projectRoot}/Content/DT_Test.uasset`];
			}),
			discoverTables: () => unexpected("discoverTables"),
			readAsset: () => unexpected("readAsset"),
			readTable: () => unexpected("readTable"),
			source: () => Effect.succeed("configured")
		});

		const assets = yield* discoverSavedAssets("C:/Fixture").pipe(Effect.provide(layer));
		expect(assets).toEqual(["C:/Fixture/Content/DT_Test.uasset"]);
		expect(yield* Ref.get(requestedRoots)).toEqual(["C:/Fixture"]);
	})
);

it.effect("preserves typed discovery failures from a test layer", () =>
	Effect.gen(function* () {
		const failure = new AssetReaderError({
			kind: "discovery",
			message: "Content is unavailable",
			operation: "discovery",
			path: "C:/Fixture/Content",
			retrySafe: true
		});
		const layer = makeAssetReaderTestLayer({
			catalogProgress: () => unexpected("catalogProgress"),
			discoverAssets: () => Effect.fail(failure),
			discoverTables: () => unexpected("discoverTables"),
			readAsset: () => unexpected("readAsset"),
			readTable: () => unexpected("readTable"),
			source: () => Effect.succeed("configured")
		});

		const error = yield* discoverSavedAssets("C:/Fixture").pipe(
			Effect.flip,
			Effect.provide(layer)
		);
		expect(error).toBe(failure);
	})
);
