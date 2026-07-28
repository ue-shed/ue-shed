import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticTableJson } from "@ue-shed/authoring";
import { decodeAuthoringTableSnapshot as decodeAuthoringTableSnapshotEffect } from "@ue-shed/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	AssetReader,
	assetReaderLayer,
	discoverSavedAssets,
	readSavedAsset,
	readSavedTable
} from "./index.js";

const decodeAuthoringTableSnapshot = (input: unknown) =>
	Effect.runSync(decodeAuthoringTableSnapshotEffect(input));

/**
 * The commandlet's editor-side view of one level package. `properties` is what Unreal's own
 * tagged-property serializer emitted for that object, not an inference from property flags.
 */
type LevelEvidence = {
	readonly classes: Record<
		string,
		{
			readonly declaredProperties: readonly {
				readonly name: string;
				readonly serializable: boolean;
			}[];
		}
	>;
	readonly exports: readonly {
		readonly objectPath: string;
		readonly classPath: string;
		readonly properties: readonly { readonly name: string; readonly value: string }[];
	}[];
};

/** The pinned level decode coverage, and the tags the editor only invents after load. */
type LevelDecodeGaps = {
	readonly exports: number;
	readonly classes: number;
	readonly engineWrittenTags: number;
	readonly decodedProperties: number;
	readonly undecodedByClass: Record<string, readonly string[]>;
	readonly postLoadMutatedByClass: Record<string, readonly string[]>;
};

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

	it("decodes every level property tag that is on disk", async () => {
		const evidence = (await json(
			join(evidenceDirectory!, "levels", "L_CameraLoad.json")
		)) as LevelEvidence;
		const expected = (await json(
			join(fixtureRoot, "FixtureExpected", "level-decode-gaps.json")
		)) as LevelDecodeGaps;
		const inspection = await runReader(
			readSavedAsset({
				assetPath: join(fixtureRoot, "Content/Fixture/Cameras/L_CameraLoad.umap")
			})
		);

		// Unreal writes subobject paths with a `:` separator; the parser emits `.` throughout.
		const editorExports = new Map(
			evidence.exports.map((entry) => [entry.objectPath.replaceAll(":", "."), entry])
		);
		// Tags the editor only invents after load, so they cannot be on disk for the parser to read.
		const postLoadMutated = new Map(
			Object.entries(expected.postLoadMutatedByClass).map(([classPath, names]) => [
				classPath,
				new Set(names)
			])
		);

		const decoded = inspection.assets.filter(
			(asset): asset is Extract<typeof asset, { kind: "UObject" }> => asset.kind === "UObject"
		);
		expect(decoded.length, "every level export decodes as a UObject").toBe(
			inspection.assets.length
		);
		expect(decoded.length).toBe(expected.exports);
		expect(new Set(decoded.map((asset) => asset.class_path)).size).toBe(expected.classes);

		const undecoded = new Map<string, Set<string>>();
		let engineWrittenTags = 0;
		let decodedProperties = 0;
		const unexpected: string[] = [];
		for (const asset of decoded) {
			const editor = editorExports.get(asset.object_path);
			expect(
				editor,
				`${asset.object_path} is missing from the commandlet evidence`
			).toBeDefined();
			const written = new Set(editor!.properties.map((property) => property.name));
			const ours = new Set(asset.properties.map((property) => property.name));
			engineWrittenTags += written.size;
			decodedProperties += ours.size;
			for (const name of ours) {
				if (!written.has(name)) unexpected.push(`${asset.class_path}.${name}`);
			}
			const mutated = postLoadMutated.get(asset.class_path) ?? new Set<string>();
			for (const name of written) {
				if (ours.has(name) || mutated.has(name)) continue;
				const names = undecoded.get(asset.class_path) ?? new Set<string>();
				names.add(name);
				undecoded.set(asset.class_path, names);
			}
		}

		// The parser must never invent a property Unreal did not serialize.
		expect([...new Set(unexpected)]).toEqual([]);
		expect({ engineWrittenTags, decodedProperties }).toEqual({
			engineWrittenTags: expected.engineWrittenTags,
			decodedProperties: expected.decodedProperties
		});
		// Every tag actually on disk decodes. Anything here is a real parser gap.
		expect(
			Object.fromEntries(
				[...undecoded]
					.map(([classPath, names]) => [classPath, [...names].toSorted()])
					.toSorted()
			)
		).toEqual(expected.undecodedByClass);
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
