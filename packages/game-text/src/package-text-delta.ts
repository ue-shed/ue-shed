import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GameTextContract } from "@ue-shed/protocol";
import { Effect, Schema, Stream } from "effect";
import type { PackageTextRefreshInput, PackageTextShardEntries } from "./package-text-layer.js";
import type { PackageTextStored } from "./package-text-columns.js";
import type { SharedIndexWriter } from "./shared-index.js";
import { snapshotFailure } from "./snapshot-format.js";
import {
	packageTextAudienceRules,
	packageTextSnapshotBatches,
	preparePackageTextSnapshots,
	type PackageTextSnapshots
} from "./package-text-native.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import type { StageClock } from "./stage-clock.js";

/** One shard's entries in a plan file, as the writer's planner and comparison write them. */
export const PackageTextPlanLine = Schema.fromJsonString(
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
type PlanEntry = (typeof PackageTextPlanLine.Type)["expected"][number];

const stagingFailure = (cause: unknown) =>
	snapshotFailure("package-text.stage", "The package text staging operation failed.", cause);
const group = (name: string) => Number(name.slice("package-text.".length));

/** A refresh's changed shards compared with the index, and the directory holding their rows. */
export interface PackageTextComparison {
	readonly shards: GameTextContract.PackageTextComparison["shards"];
	readonly directory: string;
}

/**
 * Compares the changed shards with the index in the native writer, which writes each shard's
 * rows and changed entries to a scoped directory. The writer's plan file is compared as it is;
 * a plan made here is written out first.
 */
export const comparePackageText = Effect.fn("PackageText.compare")(function* <E>(
	plan: {
		readonly changed: readonly { readonly name: string }[];
		/** The writer's plan file, when the writer planned. */
		readonly file: string | undefined;
		readonly entries: Effect.Effect<readonly PackageTextShardEntries[], E>;
	},
	context: {
		readonly compare: NonNullable<SharedIndexWriter["comparePackages"]>;
		readonly stagingRoot: string;
		readonly format: string;
		readonly policyJson: string;
	}
) {
	const directory = yield* Effect.acquireRelease(
		Effect.tryPromise({
			try: async () => {
				await mkdir(context.stagingRoot, { recursive: true });
				return mkdtemp(join(context.stagingRoot, "package-delta-"));
			},
			catch: stagingFailure
		}),
		(path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
	);
	let planFile = plan.file;
	if (planFile === undefined) {
		const shards = yield* plan.entries;
		const file = join(directory, "plan.ndjson");
		yield* Effect.tryPromise({
			try: async () => {
				const handle = await open(file, "wx");
				try {
					for (const shard of shards)
						await handle.write(
							`${JSON.stringify({
								group: group(shard.name),
								expected: shard.entries.map(({ entry, selected }) => ({
									path: entry.path,
									signature: entry.signature,
									selected
								}))
							})}\n`
						);
				} finally {
					await handle.close();
				}
			},
			catch: stagingFailure
		});
		planFile = file;
	}
	const comparison = yield* context.compare({
		format: context.format,
		policyJson: context.policyJson,
		planFile,
		groups: plan.changed.map((shard) => group(shard.name)),
		outputDirectory: join(directory, "compared")
	});
	return { shards: comparison.shards, directory } satisfies PackageTextComparison;
});

/**
 * Converts the changed records into one snapshot per shard with the paired reader, in batches
 * that bound each request. Records go through files; entries that weren't read are written from
 * the inventory alone. A shard without changed entries gets an empty snapshot.
 */
const convertChanges = Effect.fn("PackageText.convertChanges")(function* (
	shards: PackageTextSnapshots["shards"],
	records: ReadonlyMap<string, PackageTextStored>,
	directory: string
) {
	const snapshots = new Map<number, string>();
	const batches = packageTextSnapshotBatches(shards);
	yield* Effect.annotateCurrentSpan({ "package-text.convert.batches": batches.length });
	for (const [index, batch] of batches.entries()) {
		const batchDirectory = join(directory, `batch-${index}`);
		const recordFile = join(batchDirectory, "records.ndjson");
		yield* Effect.tryPromise({
			try: async () => {
				await mkdir(batchDirectory);
				const file = await open(recordFile, "wx");
				try {
					let chunk = "";
					for (const shard of batch)
						for (const entry of shard.expected) {
							if (!entry.selected) continue;
							chunk += `${JSON.stringify(records.get(entry.path)!)}\n`;
							if (chunk.length > 1024 * 1024) {
								await file.write(chunk);
								chunk = "";
							}
						}
					if (chunk) await file.write(chunk);
				} finally {
					await file.close();
				}
			},
			catch: stagingFailure
		});
		yield* preparePackageTextSnapshots({
			projectRoot: batchDirectory,
			paths: [],
			staging: {
				directory: batchDirectory,
				groups: [],
				snapshots: {
					rules: packageTextAudienceRules(),
					shards: batch,
					records: [],
					recordFiles: [recordFile]
				}
			}
		});
		for (const shard of batch)
			snapshots.set(shard.group, join(batchDirectory, `${shard.group}.snapshot`));
	}
	return snapshots;
});

/**
 * Refreshes changed shards of an existing index in place: only changed packages are read and
 * converted, and the native writer keeps every unchanged record and its dictionary IDs. All
 * changed shards and removals publish in one root publication, however many shards changed.
 */
export const replacePackageTextRecords = Effect.fn("PackageText.replaceRecords")(function* <E, R>(
	input: PackageTextRefreshInput<E, R>,
	plan: {
		readonly packages: number;
		readonly changed: readonly { readonly name: string; readonly key: string }[];
		readonly removed: readonly string[];
	},
	comparison: PackageTextComparison,
	context: {
		readonly writer: SharedIndexWriter;
		readonly replace: NonNullable<SharedIndexWriter["replacePackages"]>;
		readonly stages: StageClock;
	}
) {
	const { writer, replace, stages } = context;
	const report = yield* GameTextIndexProgressReporter;
	const compared = join(comparison.directory, "compared");
	const changedByGroup = new Map<number, readonly PlanEntry[]>();
	const text = yield* Effect.tryPromise({
		try: () => readFile(join(compared, "changed.ndjson"), "utf8"),
		catch: stagingFailure
	});
	for (const line of text.split("\n")) {
		if (!line) continue;
		const { group: shard, expected } = yield* Schema.decodeUnknownEffect(PackageTextPlanLine)(
			line
		).pipe(
			Effect.mapError((cause) =>
				snapshotFailure("package-text.compare", "Invalid package comparison.", cause)
			)
		);
		changedByGroup.set(shard, expected);
	}
	const requests = new Map<string, string>();
	for (const entries of changedByGroup.values())
		for (const entry of entries) if (entry.selected) requests.set(entry.path, entry.signature);
	const unchanged =
		plan.packages - comparison.shards.reduce((sum, shard) => sum + shard.changed, 0);
	stages.mark("compare");
	const total = requests.size;
	let completed = 0;
	report({ phase: "package_read", completed, total, unchanged });
	const records = new Map<string, PackageTextStored>();
	if (total)
		yield* input.read([...requests.keys()], requests).pipe(
			Stream.runForEach((event) =>
				Effect.gen(function* () {
					if (event.event === "text_summary") return;
					const signature = requests.get(event.path);
					if (signature === undefined || records.has(event.path))
						return yield* Effect.fail(
							snapshotFailure("package-text.read", "Unexpected or duplicate package")
						);
					records.set(event.path, { path: event.path, signature, evidence: event });
					completed++;
					report({ phase: "package_read", completed, total, unchanged });
				})
			)
		);
	if (records.size !== total)
		return yield* Effect.fail(
			snapshotFailure("package-text.read", "Reader omitted requested packages")
		);
	stages.mark("read");
	report({ phase: "package_update", completed: 0, total: 0 });
	const snapshots = yield* convertChanges(
		comparison.shards.map((shard) => ({
			group: shard.group,
			expected: changedByGroup.get(shard.group) ?? []
		})),
		records,
		comparison.directory
	);
	records.clear();
	stages.mark("convert");
	if (input.publishGate) {
		yield* input.publishGate;
		stages.restart();
	}
	const keys = new Map(plan.changed.map((shard) => [group(shard.name), shard.key]));
	yield* replace(
		comparison.shards.map((shard) => ({
			name: `package-text.${shard.group}`,
			key: keys.get(shard.group)!,
			...(shard.previousKey === undefined ? undefined : { previousKey: shard.previousKey }),
			stagedFile: snapshots.get(shard.group)!,
			rowsFile: join(compared, `${shard.group}.rows`)
		})),
		plan.removed
	);
	stages.mark("publish");
	yield* Effect.annotateCurrentSpan({
		"package-text.unchangedPackages": unchanged,
		"package-text.convertedPackages": comparison.shards.reduce(
			(sum, shard) => sum + shard.changed,
			0
		)
	});
	return {
		readPackages: total,
		reusedPackages: plan.packages - total,
		changedShards: comparison.shards.length,
		removedShards: plan.removed.length,
		published: true,
		profile: writer.metrics()
	};
});
