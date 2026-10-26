import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GameTextContract } from "@ue-shed/protocol";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { Effect, Option, Schema, Stream } from "effect";
import { ProjectIndexHeader, SavedAssetPackageTextEvent } from "@ue-shed/unreal-assets";
import { SharedIndex, type SharedIndexReader, type SharedIndexWriter } from "./shared-index.js";
import { snapshotFailure } from "./snapshot-format.js";
import {
	isPackageTextCandidate,
	textCorpusWithExcludedPackages
} from "./package-text-candidates.js";
import { decodePackageTextColumns, type PackageTextStored } from "./package-text-columns.js";
import type { ColdLayerSource } from "./shared-string-sort.js";
import { textCorpusFromExtractionEvents } from "./corpus.js";
import { comparePackageTextPathBytes } from "./package-text-order.js";
import { encodeWtf8 } from "./wtf8.js";
import { LocalizationImportSession } from "./localization-import-session.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import { writeSnapshotFile, openSnapshotFile, type SnapshotFileReader } from "./snapshot-file.js";
import { importColdPackageTextShards } from "./package-text-cold.js";
import {
	nativePackageTextColumns,
	packageTextAudienceRules,
	type PackageTextSnapshots
} from "./package-text-native.js";
import { TEXT_AUDIENCE_MATCHER_VERSION, TEXT_AUDIENCE_POLICY } from "./text-audience.js";
import { HostSliceClock, sortRowsInSlices } from "./host-slices.js";
import { StageClock } from "./stage-clock.js";
import { replacePackageTextRecords } from "./package-text-delta.js";

/** The caller supplies the Project Index's opaque package-and-sidecar signature, never a layer hash.
 * Header evidence and signatures must come from the same complete inventory generation.
 */
export const PackageTextInventoryEntry = Schema.Struct({
	path: Schema.String,
	signature: Schema.String,
	headerData: ProjectIndexHeader.fields.headerData
});
export type PackageTextInventoryEntry = typeof PackageTextInventoryEntry.Type;
/** Bump when package text columns change; older shards are read again instead of decoded.
 * v3: object paths are completed with the package name; v2 shards from UE 4.27 projects held
 * package-relative names.
 * v4: occurrences keep the reader's gather-table editor-only bit and their audience
 * (`text-audience.ts`). The audience policy table and matcher version are part of every shard key,
 * so a policy or matcher change re-encodes each shard from its stored evidence without reading
 * packages again.
 * v5: records keep the reader's Blueprint classes (uasset-io 1.12) and are stored with their
 * representation copies folded into the authored sites (`representation-copies.ts`); copies keep
 * their raw paths and text in `copy.*` columns.
 * v6: re-extract saved packages so caches built before graph pin extraction cannot retain
 * silently incomplete Blueprint text.
 * v7: re-extract bytecode identities reconciled with saved pin package namespaces.
 * v8: re-extract so a package moved or copied outside Unreal stores its object paths under the
 * file's package instead of the name its summary serializes, which records keep as `packageName`
 * (uasset-io 1.17), and so every package records its main asset's class as `assetClass`.
 * v9: re-extract with the UE 4.27 decoders and the reader's text-capable gap status (uasset-io
 * 1.18), so cached records do not keep packages partial for text-free gaps.
 * v10: reconcile stale bytecode identities and fold uniquely attributable pin runtime copies. */
export const PACKAGE_TEXT_FORMAT = "package-text-v10";
export const PACKAGE_TEXT_SHARDS = 256;
export function packageTextShard(path: string) {
	let hash = 2166136261;
	for (let index = 0; index < path.length; index++)
		hash = Math.imul(hash ^ path.charCodeAt(index), 16777619);
	return (hash >>> 0) % PACKAGE_TEXT_SHARDS;
}
const shardName = (shard: number) => `package-text.${shard}`;

/** The Project Index Catalog generation a native writer plans a refresh from. */
export interface PackageTextCatalog {
	readonly cacheRoot: string;
	readonly projectId: string;
	readonly generation: number;
}

export interface PackageTextRefreshInput<E, R> {
	/** Override the cold-path inventory threshold for bounded integration fixtures. */
	readonly coldMinimumPackages?: number;
	/** Awaited after the read, before any package layer is published. */
	readonly publishGate?: Effect.Effect<void, never, never>;
	/** Run once the refresh has planned, before it reads any package. */
	readonly planned?: Effect.Effect<void, never, never>;
	/** Explicit prepare-pool budget when another cold pool runs beside this refresh. */
	readonly memoryBudgetBytes?: number;
	/**
	 * The Catalog generation the writer plans from (`planPackages`): the reader selects, shards
	 * and keys every package, and stages the changed shards from its plan file, so no package
	 * list crosses into the host. Without it, `inventory` is planned here.
	 */
	readonly catalog?: PackageTextCatalog;
	readonly inventory?: readonly PackageTextInventoryEntry[];
	readonly changedFiles?: readonly string[];
	/** Reads packages; `signatures` holds each one's inventory signature. */
	readonly read: (
		paths: readonly string[],
		signatures: ReadonlyMap<string, string>
	) => Stream.Stream<typeof SavedAssetPackageTextEvent.Type, E, R>;
	/**
	 * Native shard preparation (`GameTextIndexSource.stage`): workers mount and convert the
	 * selected packages, and the coordinator writes each completed shard's snapshot.
	 */
	readonly stage?: {
		readonly projectRoot: string;
		readonly read: (
			paths: readonly string[],
			directory: string,
			groups: readonly number[],
			snapshots: PackageTextSnapshots
		) => Stream.Stream<{ readonly path: string; readonly file: string }, E, R>;
	};
}

/** Signature keys include eligibility, so header transitions invalidate reuse.
 * Digest framing prevents ambiguous concatenations. Inventory order is required to be path sorted.
 */
export function packageTextSelection(
	inventory: readonly PackageTextInventoryEntry[],
	retainedEligibility?: ReadonlyMap<string, boolean>
) {
	const selection = new PackageTextSelectionBuilder(retainedEligibility);
	for (const entry of inventory) selection.add(entry);
	return selection.finish();
}

/** Selection state shared by the synchronous export and the host-sliced refresh. */
class PackageTextSelectionBuilder {
	private readonly buckets: { entry: PackageTextInventoryEntry; selected: boolean }[][] =
		Array.from({ length: PACKAGE_TEXT_SHARDS }, () => []);
	private readonly hashes = Array.from({ length: PACKAGE_TEXT_SHARDS }, () =>
		createHash("sha256")
			.update(PACKAGE_TEXT_FORMAT)
			.update(JSON.stringify([TEXT_AUDIENCE_MATCHER_VERSION, TEXT_AUDIENCE_POLICY]))
	);
	private previous: Uint8Array | undefined;
	private readonly retainedEligibility: ReadonlyMap<string, boolean> | undefined;
	constructor(retainedEligibility?: ReadonlyMap<string, boolean>) {
		this.retainedEligibility = retainedEligibility;
	}
	add(entry: PackageTextInventoryEntry) {
		// Each path is encoded once and kept as the next entry's predecessor.
		const bytes = encodeWtf8(entry.path);
		if (this.previous !== undefined && Buffer.compare(bytes, this.previous) <= 0)
			throw snapshotFailure(
				"package-text.inventory",
				"Inventory must have unique paths in byte order"
			);
		this.previous = bytes;
		if (entry.headerData === undefined)
			throw snapshotFailure(
				"package-text.inventory",
				"Missing header evidence; upgrade the paired reader"
			);
		const selected =
			this.retainedEligibility?.get(entry.path) ?? isPackageTextCandidate(entry.headerData);
		const shard = packageTextShard(entry.path);
		this.buckets[shard]!.push({ entry, selected });
		this.hashes[shard]!.update(JSON.stringify([entry.path, entry.signature, selected]));
	}
	finish() {
		return this.buckets.map((entries, shard) => ({
			name: shardName(shard),
			entries,
			key: `${PACKAGE_TEXT_FORMAT}:${shard}:${this.hashes[shard]!.digest("hex")}`
		}));
	}
}

/** One shard a refresh reads again, with its entries once they are needed. */
interface PlannedShard {
	readonly name: string;
	readonly key: string;
	readonly packages: number;
	readonly selected: number;
	readonly entries?: PackageTextShardEntries["entries"];
}
/** A changed shard's entries: each package and whether it is read. */
export interface PackageTextShardEntries {
	readonly name: string;
	readonly key: string;
	readonly entries: readonly {
		readonly entry: PackageTextInventoryEntry;
		readonly selected: boolean;
	}[];
}
interface PackageTextRefreshPlan {
	readonly packages: number;
	/** Shard 0, which an empty inventory publishes as its marker. */
	readonly first: { readonly name: string; readonly key: string };
	readonly changed: readonly PlannedShard[];
	readonly removed: readonly string[];
	/** The writer's plan file, which holds the changed shards' entries, when the writer planned. */
	readonly file?: string;
}

const PlanLine = Schema.fromJsonString(
	Schema.Struct({
		group: Schema.Number,
		expected: Schema.Array(
			Schema.Struct({
				path: Schema.String,
				signature: Schema.String,
				selected: Schema.Boolean
			})
		)
	})
);

/** The changed shards with their entries: planned here, or read from the writer's plan file. */
const shardEntries = Effect.fn("PackageText.planEntries")(function* (plan: PackageTextRefreshPlan) {
	const byGroup = new Map<string, PackageTextShardEntries["entries"]>();
	if (plan.file && plan.changed.some((shard) => !shard.entries)) {
		const text = yield* Effect.tryPromise({
			try: () => readFile(plan.file!, "utf8"),
			catch: (cause) =>
				snapshotFailure(
					"package-text.plan",
					"The package text plan could not be read.",
					cause
				)
		});
		for (const line of text.split("\n")) {
			if (!line) continue;
			const { group, expected } = yield* Schema.decodeUnknownEffect(PlanLine)(line).pipe(
				Effect.mapError((cause) =>
					snapshotFailure("package-text.plan", "Invalid package text plan.", cause)
				)
			);
			byGroup.set(
				shardName(group),
				expected.map(({ path, signature, selected }) => ({
					entry: { path, signature },
					selected
				}))
			);
		}
	}
	const shards: PackageTextShardEntries[] = [];
	for (const shard of plan.changed) {
		const entries = shard.entries ?? byGroup.get(shard.name);
		if (!entries)
			return yield* Effect.fail(
				snapshotFailure("package-text.plan", "The package text plan lacks a shard.")
			);
		shards.push({ name: shard.name, key: shard.key, entries });
	}
	return shards;
});

/** The writer plans from the Catalog generation and writes the changed shards' entries to a file. */
const planOnWriter = Effect.fn("PackageText.plan")(function* (
	catalog: PackageTextCatalog,
	changedFiles: readonly string[] | undefined,
	plan: NonNullable<SharedIndexWriter["planPackages"]>,
	stagingRoot: string
) {
	const file = yield* Effect.acquireRelease(
		Effect.tryPromise({
			try: async () => {
				await mkdir(stagingRoot, { recursive: true });
				return join(await mkdtemp(join(stagingRoot, "package-plan-")), "plan.ndjson");
			},
			catch: (cause) =>
				snapshotFailure(
					"package-text.plan",
					"The package text plan could not be staged.",
					cause
				)
		}),
		(file) => Effect.promise(() => rm(dirname(file), { recursive: true, force: true }))
	);
	const result = yield* plan({
		...catalog,
		format: PACKAGE_TEXT_FORMAT,
		policyJson: JSON.stringify([TEXT_AUDIENCE_MATCHER_VERSION, TEXT_AUDIENCE_POLICY]),
		...(changedFiles ? { changedFiles: [...changedFiles] } : undefined),
		planFile: file
	} satisfies GameTextContract.PackageTextPlanRequest);
	yield* Effect.annotateCurrentSpan({
		"package-text.plan.packages": result.packages,
		"package-text.plan.changed": result.changed.length,
		"package-text.plan.removed": result.removed.length
	});
	return {
		packages: result.packages,
		first: { name: shardName(0), key: result.firstKey },
		changed: result.changed.map((shard) => ({
			name: shardName(shard.group),
			key: shard.key,
			packages: shard.packages,
			selected: shard.selected
		})),
		removed: result.removed,
		file
	} satisfies PackageTextRefreshPlan;
});

/** `packageTextSelection` in bounded host slices, with the refresh's inventory failure. */
export const packageTextSelectionInSlices = Effect.fn("PackageText.selection")(function* (
	inventory: readonly PackageTextInventoryEntry[],
	retainedEligibility?: ReadonlyMap<string, boolean>
) {
	const clock = new HostSliceClock();
	const selection = new PackageTextSelectionBuilder(retainedEligibility);
	for (let next = 0; next < inventory.length; ) {
		yield* Effect.try({
			try: () => {
				do selection.add(inventory[next++]!);
				while (next < inventory.length && !clock.step());
			},
			catch: (cause) =>
				snapshotFailure(
					"package-text.inventory",
					"The package inventory could not be prepared.",
					cause
				)
		});
		if (next < inventory.length) yield* Effect.yieldNow;
	}
	return selection.finish();
});

/** Own the writer lock across comparison, selected reads, and atomic multi-shard publication. */
export const refreshPackageTextLayer = Effect.fn("PackageText.refresh")(function* <E, R>(
	input: PackageTextRefreshInput<E, R>
) {
	const store = yield* SharedIndex;
	const leased = yield* store.writer();
	const initial = leased.metrics();
	const writer = {
		...leased,
		metrics: () => {
			const current = leased.metrics();
			return {
				...current,
				readBytes: current.readBytes - initial.readBytes,
				indexReadBytes: current.indexReadBytes - initial.indexReadBytes,
				appendedBytes: current.appendedBytes - initial.appendedBytes,
				lookupStrings: current.lookupStrings - initial.lookupStrings,
				reusedStrings: current.reusedStrings - initial.reusedStrings,
				probePasses: current.probePasses - initial.probePasses,
				sortMs: current.sortMs - initial.sortMs,
				probeMs: current.probeMs - initial.probeMs,
				appendMs: current.appendMs - initial.appendMs,
				timings: {
					collectMs: current.timings.collectMs - initial.timings.collectMs,
					reuseMs: current.timings.reuseMs - initial.timings.reuseMs,
					layerEncodeMs: current.timings.layerEncodeMs - initial.timings.layerEncodeMs,
					layerVerifyMs: current.timings.layerVerifyMs - initial.timings.layerVerifyMs,
					garbageMs: current.timings.garbageMs - initial.timings.garbageMs,
					rootPublishMs: current.timings.rootPublishMs - initial.timings.rootPublishMs
				}
			};
		}
	};
	const reportProgress = yield* GameTextIndexProgressReporter;
	const stages = new StageClock();
	const manifest = writer.manifest();
	const session = yield* Effect.serviceOption(LocalizationImportSession);
	const stagingRoot = Option.isSome(session)
		? join(session.value.configuration.cacheRoot, "staging")
		: tmpdir();
	const planned =
		input.catalog && writer.planPackages
			? yield* planOnWriter(
					input.catalog,
					input.changedFiles,
					writer.planPackages,
					stagingRoot
				)
			: yield* planHere(input.inventory ?? [], input.changedFiles, manifest);
	stages.mark("selection");
	if (input.planned) yield* input.planned;
	if (!planned.packages && manifest.active[planned.first.name] === planned.first.key)
		return {
			readPackages: 0,
			reusedPackages: 0,
			changedShards: 0,
			removedShards: 0,
			published: false,
			profile: writer.metrics()
		};
	const changed = planned.changed;
	const removed = planned.removed;
	let completed = planned.packages - changed.reduce((count, shard) => count + shard.packages, 0);
	const report = () => reportProgress({ phase: "packages", completed, total: planned.packages });
	report();
	if (!planned.packages) {
		const empty = {
			name: planned.first.name,
			key: planned.first.key,
			source: yield* nativePackageTextColumns([])
		};
		const retired = removed.filter((name) => name !== empty.name);
		if (input.publishGate) yield* input.publishGate;
		// Retain an empty prepared-inventory marker after deleting the last package, including
		// when localization layers were imported before this first package preparation.
		if (!Object.keys(writer.manifest().layers).length) yield* writer.publishCold([empty]);
		else yield* writer.publishBatch([empty], retired);
		return {
			readPackages: 0,
			reusedPackages: 0,
			changedShards: 0,
			removedShards: retired.length,
			published: true,
			profile: writer.metrics()
		};
	}
	if (!changed.length && !removed.length)
		return {
			readPackages: 0,
			reusedPackages: planned.packages,
			changedShards: 0,
			removedShards: 0,
			published: false,
			profile: writer.metrics()
		};
	const reader = Object.keys(manifest.active).some((name) => name.startsWith("package-text."))
		? yield* store.open()
		: undefined;
	if (
		reader &&
		writer.replacePackages &&
		changed.length <= 8 &&
		changed.every((shard) => manifest.active[shard.name]?.startsWith(`${PACKAGE_TEXT_FORMAT}:`))
	) {
		return yield* replacePackageTextRecords(
			input,
			planned.packages,
			yield* shardEntries(planned),
			removed,
			reader,
			writer,
			writer.replacePackages,
			input.publishGate
		);
	}
	return yield* refreshChangedShards(input, planned, {
		manifest,
		reader,
		writer,
		stages,
		stagingRoot,
		completed,
		report: (done: number) => {
			completed = done;
			report();
		}
	});
});

/** Plans an explicit inventory here: selects, shards and keys every package. */
const planHere = Effect.fn("PackageText.planHere")(function* (
	input: readonly PackageTextInventoryEntry[],
	changedFiles: readonly string[] | undefined,
	manifest: ReturnType<SharedIndexWriter["manifest"]>
) {
	const store = yield* SharedIndex;
	let inventory = input;
	const retainedEligibility = new Map<string, boolean>();
	if (
		changedFiles !== undefined &&
		Object.keys(manifest.active).some((name) => name.startsWith("package-text."))
	) {
		const selected = new Set(
			changedFiles.flatMap((path) => {
				const normalized = path.replaceAll("\\", "/");
				return /\.(?:uexp|ubulk|uptnl)$/u.test(normalized)
					? [
							normalized.replace(/\.[^.]+$/u, ".uasset"),
							normalized.replace(/\.[^.]+$/u, ".umap")
						]
					: [normalized];
			})
		);
		const retained = new Map<string, PackageTextInventoryEntry>();
		const reader = yield* store.open();
		for (const name of Object.keys(manifest.active).filter((name) =>
			name.startsWith("package-text.")
		)) {
			const layer = yield* reader.layer(name);
			const paths = yield* layer.section("package.path"),
				signatures = yield* layer.section("package.signature"),
				statuses = yield* layer.section("package.status");
			if (
				!(paths instanceof Uint32Array) ||
				!(signatures instanceof Uint32Array) ||
				!(statuses instanceof Uint32Array)
			)
				return yield* Effect.fail(
					snapshotFailure(name, "Expected package inventory columns")
				);
			const pathValues = yield* layer.strings("paths", [...paths]),
				signatureValues = yield* layer.strings("identity", [...signatures]);
			for (let row = 0; row < paths.length; row++) {
				const path = pathValues[row]!;
				if (!selected.has(path)) {
					retainedEligibility.set(path, statuses[row] !== 2);
					retained.set(path, {
						path,
						signature: signatureValues[row]!,
						headerData: {
							packageFlags: statuses[row] === 2 ? 0 : 0x40000,
							gatherableTextDataCount: 0,
							gatherableTextDataOffset: 0,
							hasTextProperty: false
						}
					});
				}
			}
		}
		for (const entry of inventory)
			if (selected.has(entry.path)) retained.set(entry.path, entry);
		const entries = [...retained.values()],
			clock = new HostSliceClock(),
			keys: Uint8Array[] = [];
		for (const entry of entries) {
			keys.push(encodeWtf8(entry.path));
			if (clock.step()) yield* Effect.yieldNow;
		}
		const rows = yield* sortRowsInSlices(
			Uint32Array.from(keys, (_, row) => row),
			(left, right) => Buffer.compare(keys[left]!, keys[right]!),
			clock
		);
		inventory = Array.from(rows, (row) => entries[row]!);
	}
	const selection = yield* packageTextSelectionInSlices(inventory, retainedEligibility);
	return {
		packages: inventory.length,
		first: { name: selection[0]!.name, key: selection[0]!.key },
		changed: selection
			.filter((shard) => shard.entries.length && manifest.active[shard.name] !== shard.key)
			.map((shard) => ({
				name: shard.name,
				key: shard.key,
				packages: shard.entries.length,
				selected: shard.entries.filter(({ selected }) => selected).length,
				entries: shard.entries
			})),
		removed: selection
			.filter((shard) => !shard.entries.length && manifest.active[shard.name])
			.map((shard) => shard.name)
	} satisfies PackageTextRefreshPlan;
});

/**
 * Reads the changed shards' packages and publishes them: on a cold build the reader stages
 * them, from the writer's plan file when it planned; otherwise they are read here.
 */
const refreshChangedShards = Effect.fn("PackageText.refreshShards")(function* <E, R>(
	input: PackageTextRefreshInput<E, R>,
	planned: PackageTextRefreshPlan,
	context: {
		readonly manifest: ReturnType<SharedIndexWriter["manifest"]>;
		readonly reader: SharedIndexReader | undefined;
		readonly writer: SharedIndexWriter;
		readonly stages: StageClock;
		readonly stagingRoot: string;
		readonly completed: number;
		readonly report: (completed: number) => void;
	}
) {
	const store = yield* SharedIndex;
	const { manifest, reader, writer, stages, stagingRoot } = context;
	const changed = planned.changed;
	const removed = planned.removed;
	let completed = context.completed;
	const report = () => context.report(completed);
	if (!reader && changed.length > 8 && planned.packages >= (input.coldMinimumPackages ?? 256)) {
		const directory = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: async () => {
					await mkdir(stagingRoot, { recursive: true });
					return mkdtemp(join(stagingRoot, "package-cold-"));
				},
				catch: (cause) =>
					snapshotFailure(
						"package-text.stage",
						"The package text staging operation failed.",
						cause
					)
			}),
			(value) => Effect.promise(() => rm(value, { recursive: true, force: true }))
		);
		const requested = new Map<string, PackageTextInventoryEntry>();
		const received = new Set<string>();
		const snapshots = new Map<string, string>();
		const stage = input.stage;
		const group = (shard: { readonly name: string }) =>
			Number(shard.name.slice("package-text.".length));
		// The reader stages the plan file's shards: no package crosses into the host.
		const fromPlan = stage !== undefined && planned.file !== undefined;
		const reads = fromPlan
			? changed.reduce((count, shard) => count + shard.selected, 0)
			: undefined;
		const shards = fromPlan ? [] : yield* shardEntries(planned);
		for (const shard of shards)
			for (const { entry, selected } of shard.entries)
				if (selected) requested.set(entry.path, entry);
		const expected = reads ?? requested.size;
		if (stage && planned.file) {
			completed += planned.packages - expected;
			report();
			yield* stage
				.read([], directory, [], {
					rules: packageTextAudienceRules(),
					shards: [],
					planFile: planned.file,
					groups: changed.map(group)
				})
				.pipe(
					Stream.runForEach((event) =>
						Effect.gen(function* () {
							if (received.has(event.path))
								return yield* Effect.fail(
									snapshotFailure(
										"package-text.read",
										"Unexpected or duplicate package"
									)
								);
							received.add(event.path);
							completed++;
							report();
						})
					)
				);
			for (const shard of changed)
				snapshots.set(shard.name, join(directory, `${group(shard)}.snapshot`));
		} else if (stage) {
			completed += planned.packages - requested.size;
			report();
			const paths = [...requested.keys()];
			yield* stage
				.read(paths, directory, paths.map(packageTextShard), {
					rules: packageTextAudienceRules(),
					shards: shards.map((shard) => ({
						group: Number(shard.name.slice("package-text.".length)),
						expected: shard.entries.map(({ entry, selected }) => ({
							path: entry.path,
							signature: entry.signature,
							selected
						}))
					}))
				})
				.pipe(
					Stream.runForEach((event) =>
						Effect.gen(function* () {
							if (!requested.has(event.path) || received.has(event.path))
								return yield* Effect.fail(
									snapshotFailure(
										"package-text.read",
										"Unexpected or duplicate package"
									)
								);
							received.add(event.path);
							completed++;
							report();
						})
					)
				);
			for (const shard of changed)
				snapshots.set(
					shard.name,
					join(directory, `${Number(shard.name.slice("package-text.".length))}.snapshot`)
				);
		} else {
			const records = new Map<string, PackageTextStored[]>();
			for (const shard of shards) {
				const rows: PackageTextStored[] = [];
				for (const { entry, selected } of shard.entries)
					if (!selected) {
						rows.push({
							path: entry.path,
							signature: entry.signature,
							evidence: { event: "not_gatherable", path: entry.path }
						});
						completed++;
					}
				records.set(shard.name, rows);
			}
			report();
			if (requested.size)
				yield* input
					.read(
						[...requested.keys()],
						new Map([...requested].map(([path, entry]) => [path, entry.signature]))
					)
					.pipe(
						Stream.runForEach((event) =>
							Effect.gen(function* () {
								if (event.event === "text_summary") return;
								const entry = requested.get(event.path);
								if (!entry || received.has(event.path))
									return yield* Effect.fail(
										snapshotFailure(
											"package-text.read",
											"Unexpected or duplicate package"
										)
									);
								received.add(event.path);
								records.get(shardName(packageTextShard(event.path)))!.push({
									path: event.path,
									signature: entry.signature,
									evidence: event
								});
								completed++;
								report();
							})
						)
					);
			for (const shard of changed) {
				const path = join(
					directory,
					`${Number(shard.name.slice("package-text.".length))}.snapshot`
				);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const source = yield* nativePackageTextColumns(records.get(shard.name)!);
						yield* Effect.tryPromise({
							try: () =>
								writeSnapshotFile(path, source, 0, undefined, undefined, {
									durable: false
								}),
							catch: (cause) =>
								snapshotFailure(
									"package-text.stage",
									"The package text staging operation failed.",
									cause
								)
						});
					})
				);
				records.delete(shard.name);
				snapshots.set(shard.name, path);
			}
		}
		if (received.size !== expected)
			return yield* Effect.fail(
				snapshotFailure("package-text.read", "Reader omitted requested packages")
			);
		stages.mark("read");
		if (input.publishGate) yield* input.publishGate;
		stages.restart();
		const result = yield* importColdPackageTextShards(
			{ snapshots },
			changed.map(({ name, key, packages }) => ({ name, key, packages })),
			planned.packages
		).pipe(
			Effect.provideService(
				SharedIndex,
				SharedIndex.of({
					...store,
					writer: () => Effect.succeed(writer),
					inspect: () => Effect.succeed(writer.manifest())
				})
			)
		);
		stages.mark("import");
		yield* Effect.annotateCurrentSpan({
			"package-text.readPackages": expected,
			...stages.attributes("package-text.stage_ms")
		});
		return {
			readPackages: expected,
			reusedPackages: planned.packages - expected,
			changedShards: changed.length,
			removedShards: removed.length,
			published: true,
			profile: result.profile
		};
	}
	const sources: ColdLayerSource[] = [];
	// A cold build must release each shard's authored objects before reading the next shard.
	// Disk-backed sources retain the atomic dictionary/root publication without retaining the corpus.
	const staged =
		changed.length > 8
			? yield* Effect.acquireRelease(
					Effect.tryPromise({
						try: async () => {
							await mkdir(stagingRoot, { recursive: true });
							const readers: SnapshotFileReader[] = [];
							return {
								directory: await mkdtemp(join(stagingRoot, "package-refresh-")),
								readers
							};
						},
						catch: (cause) =>
							snapshotFailure(
								"package-text.stage",
								"The package text staging operation failed.",
								cause
							)
					}),
					(value) =>
						Effect.promise(async () => {
							await Promise.all(value.readers.map((reader) => reader.close()));
							await rm(value.directory, { recursive: true, force: true });
						})
				)
			: undefined;
	let readPackages = 0;
	for (const shard of yield* shardEntries(planned)) {
		// A shard written in an older column format is read again rather than decoded.
		const old =
			reader && manifest.active[shard.name]?.startsWith(`${PACKAGE_TEXT_FORMAT}:`)
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
		completed += shard.entries.length - requests.length;
		report();
		if (requests.length)
			yield* input.read(requests, signatures).pipe(
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
						completed++;
						report();
					})
				)
			);
		if (received.size !== requests.length)
			return yield* Effect.fail(
				snapshotFailure("package-text.read", "Reader omitted requested packages")
			);
		next.sort((a, b) => Buffer.compare(encodeWtf8(a.path), encodeWtf8(b.path)));
		const source = yield* nativePackageTextColumns(next);
		if (staged) {
			const file = yield* Effect.tryPromise({
				try: async () => {
					const path = join(staged.directory, `${shard.name}.snapshot`);
					// Staged for the writer: uncompressed and unsynced.
					await writeSnapshotFile(path, source, 0, undefined, undefined, {
						durable: false
					});
					return openSnapshotFile(path);
				},
				catch: (cause) =>
					snapshotFailure(
						"package-text.stage",
						"The package text staging operation failed.",
						cause
					)
			});
			staged.readers.push(file);
			sources.push({
				name: shard.name,
				key: shard.key,
				source: {
					columns: [...file.directory.entries.values()].map((entry) => ({
						...entry,
						load: () => file.load(entry.name)
					}))
				}
			});
		} else sources.push({ name: shard.name, key: shard.key, source: source });
	}
	// Reading includes the reader's own work and each shard's staging.
	stages.mark("read");
	if (input.publishGate) yield* input.publishGate;
	stages.restart();
	(yield* GameTextIndexProgressReporter)({ phase: "package_publish", completed: 0, total: 0 });
	if (!Object.keys(writer.manifest().layers).length || sources.length > 8)
		yield* writer.publishCold(sources, removed);
	else yield* writer.publishBatch(sources, removed);
	stages.mark("publish");
	yield* Effect.annotateCurrentSpan({
		"package-text.readPackages": readPackages,
		"package-text.changedShards": changed.length,
		"package-text.removedShards": removed.length,
		...stages.attributes("package-text.stage_ms")
	});
	return {
		readPackages,
		reusedPackages: planned.packages - readPackages,
		changedShards: changed.length,
		removedShards: removed.length,
		published: true,
		profile: writer.metrics()
	};
});

/**
 * Read the published package-text layer back as a text corpus, as a test oracle. Deliberately only
 * for bounded fixture and tiny corpora.
 */
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
	records.sort((a, b) => comparePackageTextPathBytes(encodeWtf8(a.path), encodeWtf8(b.path)));
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
