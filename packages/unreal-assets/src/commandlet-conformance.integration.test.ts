import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticTableJson } from "@ue-shed/authoring";
import { decodeAuthoringTableSnapshot as decodeAuthoringTableSnapshotEffect } from "@ue-shed/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AssetReader, assetReaderLayer, discoverSavedAssets, readSavedTable } from "./index.js";

const decodeAuthoringTableSnapshot = (input: unknown) =>
	Effect.runSync(decodeAuthoringTableSnapshotEffect(input));

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const evidenceDirectory = process.env.UE_SHED_UNREAL_EVIDENCE_DIR;
const fixtureRoot = fileURLToPath(new URL("../../../fixtures/unreal-project", import.meta.url));
const expectedTargets = join(fixtureRoot, "FixtureExpected", "parser-targets");
const runReader = <A, E>(effect: Effect.Effect<A, E, AssetReader>) =>
	Effect.runPromise(effect.pipe(Effect.provide(assetReaderLayer({ executable: executable! }))));

async function json(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function filesBelow(root: string, directory = root): Promise<readonly string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map((entry) => {
			const path = join(directory, entry.name);
			return entry.isDirectory() ? filesBelow(root, path) : [relative(root, path)];
		})
	);
	return files.flat().toSorted();
}

describe.skipIf(!executable || !evidenceDirectory)("Unreal commandlet UAsset conformance", () => {
	it("matches DataTable and CompositeDataTable semantics decoded from saved packages", async () => {
		const assets = (await runReader(discoverSavedAssets(fixtureRoot))).filter((assetPath) =>
			assetPath.includes("Authoring")
		);
		const kinds = new Set<string>();
		for (const assetPath of assets) {
			const name = basename(assetPath, ".uasset");
			const saved = await runReader(readSavedTable({ assetPath }));
			const unreal = decodeAuthoringTableSnapshot(
				await json(join(evidenceDirectory!, "authoring", `${name}.json`))
			);
			kinds.add(saved.table.kind);
			expect(JSON.parse(semanticTableJson(saved)), name).toEqual(
				JSON.parse(semanticTableJson(unreal))
			);
		}
		expect(kinds).toEqual(new Set(["data_table", "composite_data_table"]));
	});

	it("keeps the parser target shapes synchronized with real Unreal evidence", async () => {
		const actualTargets = join(evidenceDirectory!, "parser-targets");
		const expectedFiles = await filesBelow(expectedTargets);
		expect(await filesBelow(actualTargets)).toEqual(expectedFiles);
		for (const file of expectedFiles) {
			expect(await json(join(actualTargets, file)), file).toEqual(
				await json(join(expectedTargets, file))
			);
		}
	});
});
