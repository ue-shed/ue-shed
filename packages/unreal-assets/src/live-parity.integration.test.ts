import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintTable } from "@ue-shed/authoring";
import { decodeAuthoringTableSnapshot } from "@ue-shed/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { discoverSavedAssets, readSavedTable } from "./index.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const liveDirectory = process.env.UE_SHED_LIVE_SNAPSHOT_DIR;
const fixtureRoot = fileURLToPath(new URL("../../../fixtures/unreal-project", import.meta.url));

describe.skipIf(!executable || !liveDirectory)("saved and live authoring parity", () => {
	it("produces the same semantic fingerprint for every fixture table", async () => {
		const assets = (await Effect.runPromise(discoverSavedAssets(fixtureRoot))).filter(
			(assetPath) => assetPath.includes("Authoring")
		);
		for (const assetPath of assets) {
			const name = basename(assetPath, ".uasset");
			const saved = await Effect.runPromise(
				readSavedTable({ assetPath, executable: executable! })
			);
			const live = decodeAuthoringTableSnapshot(
				JSON.parse(await readFile(join(liveDirectory!, `${name}.json`), "utf8"))
			);
			expect(fingerprintTable(live), name).toBe(fingerprintTable(saved));
		}
	});
});
