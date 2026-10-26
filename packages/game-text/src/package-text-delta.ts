import { Effect, Stream } from "effect";
import type { PackageTextRefreshInput, PackageTextShardEntries } from "./package-text-layer.js";
import { type PackageTextStored } from "./package-text-columns.js";
import type { SharedIndexReader, SharedIndexWriter } from "./shared-index.js";
import { snapshotFailure } from "./snapshot-format.js";
import { nativePackageTextColumns } from "./package-text-native.js";
import { encodeWtf8 } from "./wtf8.js";

/** Read only package identity columns in JS; Rust retains the unchanged authored rows and IDs. */
export const replacePackageTextRecords = Effect.fn("PackageText.replaceRecords")(function* <E, R>(
	input: PackageTextRefreshInput<E, R>,
	packages: number,
	changed: readonly PackageTextShardEntries[],
	removed: readonly string[],
	reader: SharedIndexReader,
	writer: SharedIndexWriter,
	replace: NonNullable<SharedIndexWriter["replacePackages"]>,
	publishGate?: Effect.Effect<void, never, never>
) {
	const entries = [];
	let readPackages = 0;
	for (const shard of changed) {
		const layer = yield* reader.layer(shard.name);
		const paths = yield* layer.section("package.path");
		const signatures = yield* layer.section("package.signature");
		const statuses = yield* layer.section("package.status");
		if (
			!(paths instanceof Uint32Array) ||
			!(signatures instanceof Uint32Array) ||
			!(statuses instanceof Uint32Array) ||
			paths.length !== signatures.length ||
			paths.length !== statuses.length
		)
			return yield* Effect.fail(
				snapshotFailure(shard.name, "Invalid package identity columns")
			);
		const pathValues = yield* layer.strings("paths", [...paths]);
		const signatureValues = yield* layer.strings("identity", [...signatures]);
		const byPath = new Map(pathValues.map((path, row) => [path, row]));
		const records: PackageTextStored[] = [];
		const rows: number[] = [];
		const requests = new Map<string, string>();
		const changedRows = new Map<string, number>();
		for (const { entry, selected } of shard.entries) {
			const prior = byPath.get(entry.path);
			if (
				prior !== undefined &&
				signatureValues[prior] === entry.signature &&
				selected === (statuses[prior] !== 2)
			) {
				rows.push(prior);
			} else {
				changedRows.set(entry.path, rows.length);
				rows.push(0);
				if (selected) requests.set(entry.path, entry.signature);
				else {
					rows[rows.length - 1] = -1 - records.length;
					records.push({
						path: entry.path,
						signature: entry.signature,
						evidence: { event: "not_gatherable", path: entry.path }
					});
				}
			}
		}
		const received = new Set<string>();
		if (requests.size)
			yield* input.read([...requests.keys()], requests).pipe(
				Stream.runForEach((event) =>
					Effect.gen(function* () {
						if (event.event === "text_summary") return;
						const signature = requests.get(event.path);
						const row = changedRows.get(event.path);
						if (
							signature === undefined ||
							row === undefined ||
							received.has(event.path)
						)
							return yield* Effect.fail(
								snapshotFailure(
									"package-text.read",
									"Unexpected or duplicate package"
								)
							);
						received.add(event.path);
						rows[row] = -1 - records.length;
						records.push({ path: event.path, signature, evidence: event });
						readPackages++;
					})
				)
			);
		if (received.size !== requests.size)
			return yield* Effect.fail(
				snapshotFailure("package-text.read", "Reader omitted requested packages")
			);
		const previousKey = reader.manifest.active[shard.name];
		if (!previousKey)
			return yield* Effect.fail(
				snapshotFailure(shard.name, "Previous package shard disappeared")
			);
		const original = records.map((record) => record.path);
		records.sort((a, b) => Buffer.compare(encodeWtf8(a.path), encodeWtf8(b.path)));
		const convertedRows = new Map(records.map((record, row) => [record.path, row]));
		for (let row = 0; row < rows.length; row++)
			if (rows[row]! < 0) rows[row] = -1 - convertedRows.get(original[-1 - rows[row]!]!)!;
		entries.push({
			name: shard.name,
			key: shard.key,
			previousKey,
			rows,
			source: yield* nativePackageTextColumns(records)
		});
	}
	if (publishGate) yield* publishGate;
	yield* replace(entries, removed);
	yield* Effect.annotateCurrentSpan({
		"package-text.readPackages": readPackages,
		"package-text.changedShards": changed.length,
		"package-text.delta_records": true
	});
	return {
		readPackages,
		reusedPackages: packages - readPackages,
		changedShards: changed.length,
		removedShards: removed.length,
		published: true,
		profile: writer.metrics()
	};
});
