import { Effect, Stream } from "effect";
import type { PackageTextRefreshInput, packageTextSelection } from "./package-text-layer.js";
import { packageTextColumns, type PackageTextStored } from "./package-text-columns.js";
import type { SharedIndexReader, SharedIndexWriter } from "./shared-index.js";
import { snapshotFailure } from "./snapshot-format.js";

/** Read only package identity columns in JS; Rust retains the unchanged authored rows and IDs. */
export const replacePackageTextRecords = Effect.fn("PackageText.replaceRecords")(function* <E, R>(
	input: PackageTextRefreshInput<E, R>,
	changed: ReturnType<typeof packageTextSelection>,
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
			yield* input.read([...requests.keys()]).pipe(
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
		entries.push({
			name: shard.name,
			key: shard.key,
			previousKey,
			rows,
			source: packageTextColumns(records)
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
		reusedPackages: input.inventory.length - readPackages,
		changedShards: changed.length,
		removedShards: removed.length,
		published: true,
		profile: writer.metrics()
	};
});
