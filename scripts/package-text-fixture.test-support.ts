import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
	assetReaderLayer,
	scanSavedProject,
	SavedAssetTextExtractionEvent,
	SavedAssetPackageTextEvent
} from "../packages/unreal-assets/dist/index.js";
import { PackageTextInventoryEntry } from "../packages/game-text/src/package-text-layer.ts";
import { committedPackagePaths, measureNativeText } from "./package-text-reader.test-support.ts";

const FixtureEvidence = Schema.Struct({
	inventory: Schema.Array(PackageTextInventoryEntry),
	events: Schema.Array(SavedAssetTextExtractionEvent),
	packageEvents: Schema.Array(SavedAssetPackageTextEvent)
});
const decodeFixtureEvidence = Schema.decodeSync(FixtureEvidence);
const FixtureEvidenceJson = Schema.fromJsonString(FixtureEvidence);
const decodeFixtureEvidenceJson = Schema.decodeSync(FixtureEvidenceJson);

/** Read-only evidence is reusable; writable indexes remain private to each test. */
export async function packageTextFixtureEvidence(executable: string, project: string) {
	const key = createHash("sha256")
		.update(JSON.stringify([executable, resolve(project)]))
		.digest("hex");
	return loadFixtureEvidence(executable, project, key);
}

async function loadFixtureEvidence(executable: string, project: string, key: string) {
	// The test wrapper creates and removes this directory for every invocation.
	const directory = process.env.UE_SHED_PACKAGE_TEXT_FIXTURE_CACHE;
	const file = directory ? join(directory, `${key}.json`) : undefined;
	if (file) {
		try {
			return decodeFixtureEvidenceJson(await readFile(file, "utf8"));
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
				throw error;
		}
	}
	const projectRoot = resolve(project);
	const paths = committedPackagePaths(project);
	const scan = await Effect.runPromise(
		scanSavedProject({
			projectRoot,
			paths,
			depth: "header",
			headerData: true,
			inventory: true
		}).pipe(Effect.provide(assetReaderLayer({ executable })))
	);
	if (scan.failures.length)
		throw new Error(`Fixture header scan failed: ${JSON.stringify(scan.failures)}`);
	const inventory = scan.assets
		.map((asset) => {
			if (asset.depth !== "header" || !asset.header.package.header_data)
				throw new Error("Missing fixture header evidence");
			const signature = scan.inventory?.find((entry) => entry.path === asset.header.path);
			if (!signature) throw new Error("Missing fixture signature inventory");
			return {
				path: asset.header.path,
				signature: JSON.stringify([signature.size, signature.modifiedMs]),
				headerData: asset.header.package.header_data
			};
		})
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const legacy = measureNativeText(executable, project, false, paths);
	const compact = measureNativeText(executable, project, true, paths);
	const evidence = decodeFixtureEvidence({
		inventory,
		events: legacy.events.filter((event) => event.event !== "text_package_record"),
		packageEvents: compact.events.filter(
			(event) => event.event === "text_package_record" || event.event === "error"
		)
	});
	if (file) {
		// Parallel workers may produce the same evidence; publish only complete files.
		const temporary = `${file}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify(evidence));
		await rename(temporary, file);
	}
	return evidence;
}
