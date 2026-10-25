/** Compare two locally built caches without printing their input identities. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Json } from "effect/Schema";
import { openSnapshotFile } from "../packages/game-text/src/snapshot-file.ts";

interface LayerRecord {
	key: string;
	file: string;
	storeGeneration: string;
	bytes: number;
	[key: string]: Json;
}
interface Root {
	generation: string;
	active: Record<string, string>;
	layers: Record<string, LayerRecord>;
	segments: { file: string; [key: string]: Json }[];
	[key: string]: Json;
}
interface Manifest {
	physicalSnapshot: string;
	previousSnapshot: string | null;
	inputKeys: { generation: string };
	[key: string]: Json;
}
interface GraphState {
	version: number;
	generation: string;
	revision: string;
	base: string;
	moves: Record<string, number>;
}
function normalizedKey(key: string) {
	return key.startsWith("joined-native-v8:") ? "joined-native-v8:<generation-derived>" : key;
}
async function manifests(directory: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...(await manifests(path)));
		else if (entry.name === "manifest.json") found.push(path);
	}
	return found;
}
async function readRoot(path: string) {
	const snapshot = await openSnapshotFile(path);
	try {
		// SAFETY: index.meta is the native store root in the locally built cache above.
		const root = JSON.parse(
			new TextDecoder().decode(await snapshot.load("index.meta"))
		) as Root;
		if (snapshot.directory.entries.size !== 1) throw new Error("Unexpected root sections.");
		return root;
	} finally {
		await snapshot.close();
	}
}
async function cache(directory: string) {
	const paths = await manifests(join(directory, "game-text-v2"));
	if (paths.length !== 1) throw new Error("Expected exactly one shared-store manifest.");
	// SAFETY: only locally built native-store caches are accepted by this verification script.
	const manifest = JSON.parse(await readFile(paths[0]!, "utf8")) as Manifest;
	const directoryPath = dirname(paths[0]!);
	const root = await readRoot(join(directoryPath, manifest.physicalSnapshot));
	if (root.generation !== manifest.inputKeys.generation)
		throw new Error("Inconsistent generation.");
	const previous = manifest.previousSnapshot
		? await readRoot(join(directoryPath, manifest.previousSnapshot))
		: null;
	return { directory: directoryPath, manifest, root, previous };
}
function normalizedRecord(record: LayerRecord) {
	const { file: _file, storeGeneration: _generation, bytes: _bytes, ...kept } = record;
	return { ...kept, key: normalizedKey(kept.key) };
}
function normalizedRoot(root: Root) {
	const { generation: _generation, active, layers, segments, ...kept } = root;
	const keys = Object.keys(layers).map(normalizedKey);
	if (new Set(keys).size !== keys.length) throw new Error("Ambiguous normalized layer keys.");
	return {
		...kept,
		active: Object.fromEntries(
			Object.entries(active).map(([name, key]) => [name, normalizedKey(key)])
		),
		layers: Object.fromEntries(
			Object.entries(layers).map(([key, record]) => [
				normalizedKey(key),
				normalizedRecord(record)
			])
		),
		segments: segments.map(({ file: _file, ...segment }) => segment)
	};
}
function normalizedManifest(manifest: Manifest) {
	const {
		physicalSnapshot: _physical,
		previousSnapshot: _previous,
		inputKeys,
		...kept
	} = manifest;
	const { generation: _generation, ...keys } = inputKeys;
	return { ...kept, inputKeys: keys };
}
const differingFiles: string[] = [];
const metadataOnlyFiles: string[] = [];
let rawEqualFiles = 0;
let sections = 0;
function wholeFileMatches(left: string, right: string) {
	const cmp = spawnSync(process.env.CMP_EXECUTABLE ?? "cmp", ["-s", left, right]);
	if (cmp.error || (cmp.status !== 0 && cmp.status !== 1)) throw new Error("cmp unavailable.");
	if (cmp.status === 0) rawEqualFiles++;
	return cmp.status === 0;
}
async function graph(directory: string) {
	const files = (await readdir(directory)).filter(
		(name) => name.startsWith("dependencies-") && name.endsWith(".json")
	);
	if (files.length !== 1) throw new Error("Expected exactly one dependency graph.");
	// SAFETY: the dependency graph envelope is written by the same native store as the snapshots.
	const envelope = JSON.parse(await readFile(join(directory, files[0]!), "utf8")) as {
		state: GraphState;
		checksum: string;
	};
	const { version, generation, revision, base, moves } = envelope.state;
	const checksum = createHash("sha256")
		.update(JSON.stringify({ version, generation, revision, base, moves }))
		.digest("hex");
	if (checksum !== envelope.checksum) throw new Error("Dependency graph checksum invalid.");
	return { file: files[0]!, base, state: { version, revision: normalizedKey(revision), moves } };
}
async function compareLayer(left: string, right: string) {
	if (wholeFileMatches(left, right)) return;
	const a = await openSnapshotFile(left);
	const b = await openSnapshotFile(right);
	const handles = [await open(left, "r"), await open(right, "r")];
	try {
		if (
			a.directory.version !== b.directory.version ||
			!isDeepStrictEqual([...a.directory.entries.keys()], [...b.directory.entries.keys()])
		)
			throw new Error("Snapshot directory differs.");
		for (const [name, entry] of a.directory.entries) {
			const other = b.directory.entries.get(name)!;
			if (name === "shared.meta") {
				// SAFETY: this is the native layer record in the locally built store.
				const one = JSON.parse(new TextDecoder().decode(await a.load(name))) as LayerRecord;
				// SAFETY: the second cache has the same native layer-record schema.
				const two = JSON.parse(new TextDecoder().decode(await b.load(name))) as LayerRecord;
				if (!isDeepStrictEqual(normalizedRecord(one), normalizedRecord(two)))
					throw new Error("Layer metadata differs.");
				continue;
			}
			if (name === "join.meta" || name === "graph.meta") {
				// SAFETY: these native metadata sections are JSON objects with one generation field.
				const one = JSON.parse(new TextDecoder().decode(await a.load(name))) as {
					generation: string;
					[key: string]: Json;
				};
				// SAFETY: the second cache uses the same native metadata section format.
				const two = JSON.parse(new TextDecoder().decode(await b.load(name))) as {
					generation: string;
					[key: string]: Json;
				};
				const { generation: _aGeneration, ...aMetadata } = one;
				const { generation: _bGeneration, ...bMetadata } = two;
				if (!isDeepStrictEqual(aMetadata, bMetadata))
					throw new Error("Joined metadata differs.");
				continue;
			}
			const { offset: _aOffset, ...aDescriptor } = entry;
			const { offset: _bOffset, ...bDescriptor } = other;
			if (!isDeepStrictEqual(aDescriptor, bDescriptor))
				throw new Error("Data section descriptor differs.");
			const one = Buffer.alloc(entry.storedLength);
			const two = Buffer.alloc(other.storedLength);
			for (const [index, bytes, position] of [
				[0, one, entry.offset],
				[1, two, other.offset]
			] as const) {
				let offset = 0;
				while (offset < bytes.length) {
					const result = await handles[index]!.read(
						bytes,
						offset,
						bytes.length - offset,
						position + offset
					);
					if (!result.bytesRead) throw new Error("Truncated section.");
					offset += result.bytesRead;
				}
			}
			if (!one.equals(two)) throw new Error("Stored data section bytes differ.");
			sections++;
		}
		metadataOnlyFiles.push(`${left} <> ${right}`);
	} catch (cause) {
		differingFiles.push(`${left} <> ${right}`);
		throw cause;
	} finally {
		await a.close();
		await b.close();
		await Promise.all(handles.map((handle) => handle.close()));
	}
}
try {
	if (process.argv.length !== 4) throw new Error("Provide baseline and changed cache roots.");
	const baseline = await cache(process.argv[2]!);
	const changed = await cache(process.argv[3]!);
	if (
		!isDeepStrictEqual(
			normalizedManifest(baseline.manifest),
			normalizedManifest(changed.manifest)
		)
	)
		throw new Error("Manifest identity or version differs.");
	if (!isDeepStrictEqual(normalizedRoot(baseline.root), normalizedRoot(changed.root)))
		throw new Error("Root metadata differs after explicit exclusions.");
	if (
		!isDeepStrictEqual(
			baseline.previous ? normalizedRoot(baseline.previous) : null,
			changed.previous ? normalizedRoot(changed.previous) : null
		)
	)
		throw new Error("Previous root differs.");
	const aGraph = await graph(baseline.directory);
	const bGraph = await graph(changed.directory);
	if (aGraph.file !== bGraph.file || !isDeepStrictEqual(aGraph.state, bGraph.state))
		throw new Error("Dependency graph state differs.");
	for (const [leftName, rightName] of [
		["manifest.json", "manifest.json"],
		[baseline.manifest.physicalSnapshot, changed.manifest.physicalSnapshot],
		[baseline.manifest.previousSnapshot, changed.manifest.previousSnapshot],
		[aGraph.file, bGraph.file]
	]) {
		if (!leftName || !rightName) continue;
		const left = join(baseline.directory, leftName),
			right = join(changed.directory, rightName);
		if (!wholeFileMatches(left, right)) metadataOnlyFiles.push(`${left} <> ${right}`);
	}
	await compareLayer(join(baseline.directory, aGraph.base), join(changed.directory, bGraph.base));
	const categories: Record<string, number> = {};
	const changedLayers = new Map(
		Object.entries(changed.root.layers).map(([key, record]) => [normalizedKey(key), record])
	);
	for (const [key, record] of Object.entries(baseline.root.layers)) {
		const names = Object.entries(baseline.root.active)
			.filter(([, active]) => active === key)
			.map(([name]) => name);
		const category = names.some((name) => name.startsWith("package-text."))
			? "package"
			: names.some(
						(name) =>
							name.endsWith(".joined") ||
							name.endsWith(".joined-base") ||
							name === "joined"
				  )
				? "joined"
				: "localization-and-metadata";
		categories[category] = (categories[category] ?? 0) + 1;
		await compareLayer(
			join(baseline.directory, record.file),
			join(changed.directory, changedLayers.get(normalizedKey(key))!.file)
		);
	}
	for (let index = 0; index < baseline.root.segments.length; index++) {
		await compareLayer(
			join(baseline.directory, baseline.root.segments[index]!.file),
			join(changed.directory, changed.root.segments[index]!.file)
		);
	}
	for (const [built, dependency] of [
		[baseline, aGraph],
		[changed, bGraph]
	] as const) {
		const accounted = new Set([
			"manifest.json",
			built.manifest.physicalSnapshot,
			built.manifest.previousSnapshot,
			dependency.file,
			dependency.base,
			...Object.values(built.root.layers).map((record) => record.file),
			...built.root.segments.map((segment) => segment.file)
		]);
		const extra = (await readdir(built.directory)).filter((name) => !accounted.has(name));
		if (extra.length) throw new Error(`Unaccounted store files: ${extra.join(", ")}`);
	}
	process.stdout.write(
		JSON.stringify({
			equal: true,
			categories,
			dictionaries: baseline.root.segments.length,
			comparedStoredSections: sections,
			rawEqualFiles,
			metadataOnlyFiles
		}) + "\n"
	);
} catch (cause) {
	process.stderr.write(
		JSON.stringify({
			equal: false,
			reason: cause instanceof Error ? cause.message : "Comparison failed",
			differingFiles
		}) + "\n"
	);
	process.exitCode = 1;
}
