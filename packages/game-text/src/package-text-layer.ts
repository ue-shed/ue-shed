import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { ProjectIndexHeader, SavedAssetPackageTextEvent } from "@ue-shed/unreal-assets";
import { SharedIndex } from "./shared-index.js";
import { snapshotFailure } from "./snapshot-format.js";
import {
	isPackageTextCandidate,
	packageTextExternalReferences,
	textCorpusWithExcludedPackages
} from "./package-text-candidates.js";
import {
	packageTextColumns,
	decodePackageTextColumns,
	type PackageTextStored
} from "./package-text-columns.js";
import type { ColdLayerSource } from "./shared-string-sort.js";
import { textCorpusFromExtractionEvents } from "./corpus.js";
import { comparePackageTextPathBytes } from "./package-text-order.js";

/** The caller supplies the Project Index's opaque package-and-sidecar signature, never a layer hash.
 * Header evidence and signatures must come from the same complete inventory generation.
 */
export const PackageTextInventoryEntry = Schema.Struct({
	path: Schema.String,
	signature: Schema.String,
	headerData: ProjectIndexHeader.fields.headerData
});
export type PackageTextInventoryEntry = typeof PackageTextInventoryEntry.Type;
export const PACKAGE_TEXT_SHARDS = 256;
export function packageTextShard(path: string) {
	let hash = 2166136261;
	for (let index = 0; index < path.length; index++)
		hash = Math.imul(hash ^ path.charCodeAt(index), 16777619);
	return (hash >>> 0) % PACKAGE_TEXT_SHARDS;
}
const shardName = (shard: number) => `package-text.${shard}`;

export interface PackageTextRefreshInput<E, R> {
	readonly inventory: readonly PackageTextInventoryEntry[];
	readonly read: (
		paths: readonly string[]
	) => Stream.Stream<typeof SavedAssetPackageTextEvent.Type, E, R>;
}

/** Signature keys include eligibility, so external-reference/header transitions invalidate reuse.
 * Digest framing prevents ambiguous concatenations. Inventory order is required to be path sorted.
 */
export function packageTextSelection(inventory: readonly PackageTextInventoryEntry[]) {
	const external = packageTextExternalReferences(inventory.map((entry) => entry.path));
	const buckets: { entry: PackageTextInventoryEntry; selected: boolean }[][] = Array.from(
		{ length: PACKAGE_TEXT_SHARDS },
		() => []
	);
	const hashes = Array.from({ length: PACKAGE_TEXT_SHARDS }, () =>
		createHash("sha256").update("package-text-v1")
	);
	let previous: string | undefined;
	for (const entry of inventory) {
		if (previous !== undefined && entry.path <= previous)
			throw snapshotFailure(
				"package-text.inventory",
				"Inventory must have unique paths in byte order"
			);
		previous = entry.path;
		if (entry.headerData === undefined)
			throw snapshotFailure(
				"package-text.inventory",
				"Missing header evidence; upgrade the paired reader"
			);
		const selected = isPackageTextCandidate(entry.headerData, external.has(entry.path));
		const shard = packageTextShard(entry.path);
		buckets[shard]!.push({ entry, selected });
		hashes[shard]!.update(JSON.stringify([entry.path, entry.signature, selected]));
	}
	return buckets.map((entries, shard) => ({
		name: shardName(shard),
		entries,
		key: `package-text-v1:${shard}:${hashes[shard]!.digest("hex")}`
	}));
}

/** Own the writer lock across comparison, selected reads, and atomic multi-shard publication. */
export const refreshPackageTextLayer = Effect.fn("PackageText.refresh")(function* <E, R>(
	input: PackageTextRefreshInput<E, R>
) {
	const selection = yield* Effect.try({
		try: () => packageTextSelection(input.inventory),
		catch: (cause) => snapshotFailure("package-text.inventory", String(cause))
	});
	const store = yield* SharedIndex,
		writer = yield* store.writer();
	const manifest = writer.manifest();
	if (!input.inventory.length && manifest.active[selection[0]!.name] === selection[0]!.key)
		return {
			readPackages: 0,
			reusedPackages: 0,
			changedShards: 0,
			removedShards: 0,
			published: false,
			profile: writer.metrics()
		};
	const changed = selection.filter(
		(shard) => shard.entries.length && manifest.active[shard.name] !== shard.key
	);
	const removed = selection
		.filter((shard) => !shard.entries.length && manifest.active[shard.name])
		.map((shard) => shard.name);
	if (!input.inventory.length && !Object.keys(manifest.layers).length) {
		yield* writer.publishCold([
			{ name: selection[0]!.name, key: selection[0]!.key, source: packageTextColumns([]) }
		]);
		return {
			readPackages: 0,
			reusedPackages: 0,
			changedShards: 0,
			removedShards: 0,
			published: true,
			profile: writer.metrics()
		};
	}
	if (!changed.length && !removed.length)
		return {
			readPackages: 0,
			reusedPackages: input.inventory.length,
			changedShards: 0,
			removedShards: 0,
			published: false,
			profile: writer.metrics()
		};
	const reader = Object.keys(manifest.active).some((name) => name.startsWith("package-text."))
		? yield* store.open()
		: undefined;
	const sources: ColdLayerSource[] = [];
	let readPackages = 0;
	for (const shard of changed) {
		const old =
			reader && manifest.active[shard.name]
				? yield* decodePackageTextColumns(yield* reader.layer(shard.name))
				: [];
		const byPath = new Map(old.map((record) => [record.path, record]));
		const next: PackageTextStored[] = [],
			requests: string[] = [];
		const signatures = new Map<string, string>();
		for (const { entry, selected } of shard.entries) {
			const prior = byPath.get(entry.path);
			if (
				prior &&
				prior.signature === entry.signature &&
				selected === (prior.evidence.event !== "not_gatherable")
			) {
				next.push(prior);
				continue;
			}
			if (!selected)
				next.push({
					path: entry.path,
					signature: entry.signature,
					evidence: { event: "not_gatherable", path: entry.path }
				});
			else {
				requests.push(entry.path);
				signatures.set(entry.path, entry.signature);
			}
		}
		const received = new Set<string>();
		if (requests.length)
			yield* input.read(requests).pipe(
				Stream.runForEach((event) =>
					Effect.gen(function* () {
						if (event.event === "text_summary") return;
						const signature = signatures.get(event.path);
						if (signature === undefined || received.has(event.path))
							return yield* Effect.fail(
								snapshotFailure(
									"package-text.read",
									"Unexpected or duplicate package"
								)
							);
						received.add(event.path);
						next.push({ path: event.path, signature, evidence: event });
						readPackages++;
					})
				)
			);
		if (received.size !== requests.length)
			return yield* Effect.fail(
				snapshotFailure("package-text.read", "Reader omitted requested packages")
			);
		next.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		sources.push({ name: shard.name, key: shard.key, source: packageTextColumns(next) });
	}
	if (!Object.keys(manifest.layers).length || sources.length > 8)
		yield* writer.publishCold(sources, removed);
	else yield* writer.publishBatch(sources, removed);
	yield* Effect.annotateCurrentSpan({
		"package-text.readPackages": readPackages,
		"package-text.changedShards": changed.length,
		"package-text.removedShards": removed.length
	});
	return {
		readPackages,
		reusedPackages: input.inventory.length - readPackages,
		changedShards: changed.length,
		removedShards: removed.length,
		published: true,
		profile: writer.metrics()
	};
});

/** Reusable Phase 5 layer oracle adapter. Deliberately only for bounded fixture/tiny corpora. */
export const textCorpusFromPackageTextLayer = Effect.fn("PackageText.oracleCorpus")(function* (
	projectRoot: string
) {
	const reader = yield* (yield* SharedIndex).open();
	const records: PackageTextStored[] = [];
	for (const name of Object.keys(reader.manifest.active).filter((name) =>
		name.startsWith("package-text.")
	))
		records.push(...(yield* decodePackageTextColumns(yield* reader.layer(name))));
	// Shards are a storage partition, not the native reader's package emission order.
	records.sort((a, b) => comparePackageTextPathBytes(Buffer.from(a.path), Buffer.from(b.path)));
	const corpus = textCorpusFromExtractionEvents({
		projectRoot,
		discoveredPackages: records.length,
		events: records.flatMap((record) =>
			record.evidence.event === "not_gatherable"
				? []
				: [{ ...record.evidence, path: resolve(projectRoot, record.path) }]
		)
	});
	return textCorpusWithExcludedPackages(
		corpus,
		records
			.filter((record) => record.evidence.event === "not_gatherable")
			.map((record) => relative(projectRoot, resolve(projectRoot, record.path)))
	);
});
