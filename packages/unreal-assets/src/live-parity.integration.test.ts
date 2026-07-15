import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintTable } from "@ue-shed/authoring";
import { decodeAuthoringTableSnapshot as decodeAuthoringTableSnapshotEffect } from "@ue-shed/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AssetReader, assetReaderLayer, discoverSavedAssets, readSavedTable } from "./index.js";

const decodeAuthoringTableSnapshot = (input: unknown) =>
	Effect.runSync(decodeAuthoringTableSnapshotEffect(input));

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const liveDirectory = process.env.UE_SHED_LIVE_SNAPSHOT_DIR;
const fixtureRoot = fileURLToPath(new URL("../../../fixtures/unreal-project", import.meta.url));
const runReader = <A, E>(effect: Effect.Effect<A, E, AssetReader>) =>
	Effect.runPromise(effect.pipe(Effect.provide(assetReaderLayer({ executable: executable! }))));

describe.skipIf(!executable || !liveDirectory)("saved and live authoring parity", () => {
	it("produces the same semantic fingerprint for every fixture table", async () => {
		const assets = (await runReader(discoverSavedAssets(fixtureRoot))).filter((assetPath) =>
			assetPath.includes("Authoring")
		);
		for (const assetPath of assets) {
			const name = basename(assetPath, ".uasset");
			const saved = await runReader(readSavedTable({ assetPath }));
			const live = decodeAuthoringTableSnapshot(
				JSON.parse(await readFile(join(liveDirectory!, `${name}.json`), "utf8"))
			);
			expect(fingerprintTable(live), name).toBe(fingerprintTable(saved));
		}
	});
});
