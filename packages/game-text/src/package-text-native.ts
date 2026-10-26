import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Option, Stream } from "effect";
import {
	AssetReader,
	AssetReaderLive,
	assetReaderLayer,
	type AssetReaderConfiguration
} from "@ue-shed/unreal-assets";
import type { UAssetIoPackageTextSnapshots } from "@ue-shed/protocol";
import type { PackageTextStored } from "./package-text-columns.js";
import { openSnapshotFile } from "./snapshot-file.js";
import { snapshotStoreFailure } from "./snapshot-store.js";
import { encodeTextAudience, TEXT_AUDIENCE_POLICY } from "./text-audience.js";

const nativeFailure = (cause: unknown) =>
	snapshotStoreFailure(
		"package-text.native",
		cause,
		"Rebuild the derived package snapshots with the paired native reader."
	);

export type PackageTextSnapshots = UAssetIoPackageTextSnapshots;
/** The writer's paired executable also owns conversion when no extraction source is involved. */
export class PackageTextReaderConfiguration extends Context.Service<
	PackageTextReaderConfiguration,
	AssetReaderConfiguration
>()("@ue-shed/game-text/PackageTextReaderConfiguration") {}
/** Keep every shard in one bounded native request, including its signature inventory. */
export function packageTextSnapshotBatches(shards: PackageTextSnapshots["shards"]) {
	const batches: PackageTextSnapshots["shards"][] = [];
	let batch: PackageTextSnapshots["shards"][number][] = [],
		bytes = 0;
	for (const shard of shards) {
		const size =
			Buffer.byteLength(JSON.stringify(shard)) +
			shard.expected.reduce(
				(sum, entry) =>
					sum + (entry.selected ? Buffer.byteLength(JSON.stringify(entry.path)) + 8 : 0),
				0
			);
		if (batch.length && bytes + size > 3 * 1024 * 1024) {
			batches.push(batch);
			batch = [];
			bytes = 0;
		}
		batch.push(shard);
		bytes += size;
	}
	if (batch.length) batches.push(batch);
	return batches;
}
export const packageTextAudienceRules = () =>
	TEXT_AUDIENCE_POLICY.map((rule) => ({
		code: encodeTextAudience({ audience: rule.audience, reason: rule.reason, rule: rule.id }),
		when: rule.when
	}));

export const preparePackageTextSnapshots = Effect.fn("PackageText.prepareSnapshots")(function* (
	options: import("@ue-shed/unreal-assets").SavedAssetStagedTextExtractionOptions
) {
	const convert = Effect.gen(function* () {
		const reader = yield* AssetReader,
			stage = reader.stageProjectTextPackages;
		if (!stage)
			return yield* Effect.fail(
				nativeFailure(new Error("The paired reader cannot prepare package snapshots."))
			);
		yield* stage(options).pipe(Stream.runDrain, Effect.mapError(nativeFailure));
	});
	const configuration = yield* Effect.serviceOption(PackageTextReaderConfiguration);
	if (Option.isSome(configuration))
		return yield* convert.pipe(Effect.provide(assetReaderLayer(configuration.value)));
	const supplied = yield* Effect.serviceOption(AssetReader);
	yield* Option.isSome(supplied)
		? convert.pipe(Effect.provideService(AssetReader, supplied.value))
		: convert.pipe(Effect.provide(AssetReaderLive));
});

/** Replay retained record files without decoding their authored contents in the host. */
export const prepareRetainedPackageTextSnapshots = Effect.fn("PackageText.prepareRetained")(
	function* (
		selection: ReturnType<typeof import("./package-text-layer.js").packageTextSelection>,
		recordDirectory: string,
		stagingRoot: string
	) {
		const directory = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: async () => {
					await mkdir(stagingRoot, { recursive: true });
					return mkdtemp(join(stagingRoot, "package-snapshots-"));
				},
				catch: nativeFailure
			}),
			(path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
		);
		const shards = selection.filter((shard) => shard.entries.length);
		const shardRequests = shards.map((shard) => ({
			group: Number(shard.name.slice("package-text.".length)),
			expected: shard.entries.map(({ entry, selected }) => ({
				path: entry.path,
				signature: entry.signature,
				selected
			}))
		}));
		for (const batch of packageTextSnapshotBatches(shardRequests))
			yield* preparePackageTextSnapshots({
				projectRoot: directory,
				paths: [],
				staging: {
					directory,
					groups: [],
					snapshots: {
						rules: packageTextAudienceRules(),
						recordFiles: batch.map((shard) =>
							join(recordDirectory, `package-text.${shard.group}.ndjson`)
						),
						shards: batch
					}
				}
			});
		return new Map(
			shards.map((shard) => [
				shard.name,
				join(directory, `${Number(shard.name.slice("package-text.".length))}.snapshot`)
			])
		);
	}
);

/** Convert explicit retained records with the same reader encoder used by package extraction. */
export const nativePackageTextColumns = Effect.fn("PackageText.nativeColumns")(function* (
	records: readonly PackageTextStored[]
) {
	const directory = yield* Effect.acquireRelease(
		Effect.tryPromise({
			try: () => mkdtemp(join(tmpdir(), "ue-shed-package-columns-")),
			catch: (cause) => nativeFailure(cause)
		}),
		(path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
	);
	const strings: string[] = [],
		files: string[] = [];
	let bytes = 0;
	for (const [index, record] of records.entries()) {
		const text = JSON.stringify(record),
			size = Buffer.byteLength(JSON.stringify(text));
		if (size + bytes > 2 * 1024 * 1024) {
			const file = join(directory, `${index}.record`);
			yield* Effect.tryPromise({
				try: () => writeFile(file, text, { flag: "wx" }),
				catch: (cause) => nativeFailure(cause)
			});
			files.push(file);
		} else {
			strings.push(text);
			bytes += size;
		}
	}
	const snapshots: PackageTextSnapshots = {
		shards: [
			{
				group: 0,
				expected: records.map((record) => ({
					path: record.path,
					signature: record.signature,
					selected: record.evidence.event !== "not_gatherable"
				}))
			}
		],
		rules: packageTextAudienceRules(),
		records: strings,
		recordFiles: files
	};
	yield* preparePackageTextSnapshots({
		projectRoot: directory,
		paths: [],
		staging: { directory, groups: [], snapshots }
	});
	const reader = yield* Effect.acquireRelease(
		Effect.tryPromise({
			try: () => openSnapshotFile(join(directory, "0.snapshot")),
			catch: (cause) => nativeFailure(cause)
		}),
		(file) => Effect.promise(() => file.close())
	);
	return {
		columns: [...reader.directory.entries.values()].map((entry) => ({
			...entry,
			load: () => reader.load(entry.name)
		}))
	};
});
