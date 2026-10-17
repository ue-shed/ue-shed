import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
	AssetReader,
	batchProtocolPaths,
	ProjectIndex,
	ProjectIndexQuery,
	projectIndexProcessLayerFromReader,
	type ProjectIndexCursor,
	type ProjectIndexSummary
} from "@ue-shed/unreal-assets";
import { Cache, Data, Duration, Effect, Exit, Layer, Option, Schema, Stream } from "effect";
import {
	GameTextIndexError,
	GameTextIndexSource,
	type GameTextIndexSourceRequest
} from "./index-refresh.js";
import type { PackageTextInventoryEntry } from "./package-text-layer.js";
import { encodeWtf8 } from "./wtf8.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import { HostSliceClock, sortRowsInSlices } from "./host-slices.js";

const FileStamp = Schema.Struct({ size: Schema.Number, modifiedMs: Schema.Number });
const Signature = Schema.Array(Schema.NullOr(FileStamp));
const bundlePaths = (path: string) => [
	path,
	...["uexp", "ubulk", "uptnl"].map((extension) => path.replace(/\.[^.]+$/u, `.${extension}`))
];
const failure = (operation: string, message: string, cause?: unknown) =>
	new GameTextIndexError({
		nextStep: "escalate",
		retrySafe: false,
		code: "index_failed",
		operation,
		message,
		recovery:
			"Save the packages, refresh the Project Index and retry with the paired native reader.",
		...(cause === undefined ? undefined : { cause })
	});

class InventoryKey extends Data.Class<{
	readonly projectRoot: string;
	readonly projectId: ProjectIndexSummary["projectId"];
	readonly generation: ProjectIndexSummary["generation"];
	readonly packageCount: number;
}> {}

/**
 * Split selected packages into consecutive batches whose paths each fit in one native reader
 * request, so hosts can hand the source a whole project without batching it themselves.
 */
export function packageTextReadBatches<Entry extends Pick<PackageTextInventoryEntry, "path">>(
	entries: readonly Entry[],
	maximumPathBytes?: number
): readonly (readonly Entry[])[] {
	const batches: Entry[][] = [];
	let start = 0;
	for (const paths of batchProtocolPaths(
		entries.map((entry) => entry.path),
		maximumPathBytes
	)) {
		batches.push(entries.slice(start, start + paths.length));
		start += paths.length;
	}
	return batches;
}

/** The native scanner owns enumeration and header caching. Only selected bundles are stat-verified. */
export function gameTextIndexSourceNodeLayer(
	cacheRoot: string,
	options: { readonly refreshProjectIndex?: boolean } = {}
) {
	const source = Layer.effect(
		GameTextIndexSource,
		Effect.gen(function* () {
			const reader = yield* AssetReader;
			const projectIndex = yield* ProjectIndex;
			const mapError = (cause: { readonly message: string; readonly recovery: string }) =>
				new GameTextIndexError({
					nextStep: "escalate",
					retrySafe: false,
					code: "index_failed",
					operation: "reader_failure",
					message: cause.message,
					recovery: cause.recovery
				});
			const pages = Effect.fn("GameTextIndexSource.inventoryPages")(function* (
				key: InventoryKey
			) {
				const result: PackageTextInventoryEntry[] = [];
				let cursor: ProjectIndexCursor | undefined;
				do {
					const page = yield* projectIndex
						.query(
							ProjectIndexQuery.cases.Inventory.make({
								projectId: key.projectId,
								expectedGeneration: key.generation,
								limit: 1024,
								...(cursor === undefined ? undefined : { cursor })
							})
						)
						.pipe(Effect.mapError(mapError));
					for (const item of page.items) {
						if (item.kind !== "inventory")
							return yield* Effect.fail(
								failure(
									"inventory",
									"The paired Project Index did not return signature rows."
								)
							);
						result.push({
							path: item.packagePath,
							signature: item.signature,
							headerData: item.headerData ?? {
								packageFlags: 0x40000,
								gatherableTextDataCount: 0,
								gatherableTextDataOffset: 0,
								hasTextProperty: true
							}
						});
					}
					cursor = page.nextCursor;
				} while (cursor !== undefined);
				if (result.length !== key.packageCount)
					return yield* Effect.fail(
						failure("inventory", "The committed signature inventory is incomplete.")
					);
				// Encode each path once, then sort row numbers in host slices.
				const clock = new HostSliceClock(),
					keys: Uint8Array[] = [];
				for (const entry of result) {
					keys.push(encodeWtf8(entry.path));
					if (clock.step()) yield* Effect.yieldNow;
				}
				const rows = yield* sortRowsInSlices(
					Uint32Array.from(keys, (_, row) => row),
					(left, right) => Buffer.compare(keys[left]!, keys[right]!),
					clock
				);
				return Array.from(rows, (row) => result[row]!);
			});
			const inventories = yield* Cache.makeWith(pages, {
				capacity: 2,
				timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
			});
			const inventory = Effect.fn("GameTextIndexSource.inventory")(function* (
				request: GameTextIndexSourceRequest
			) {
				const reportProgress = yield* GameTextIndexProgressReporter;
				const project = { projectRoot: request.projectRoot };
				if (options.refreshProjectIndex !== false)
					yield* projectIndex.refresh(project).pipe(
						Stream.runForEach((event) =>
							Effect.sync(() => {
								if (event._tag === "Progress")
									reportProgress({
										phase: "inventory",
										completed: event.completedPackages,
										total: event.totalPackages ?? 0
									});
							})
						),
						Effect.mapError(mapError)
					);
				const status = yield* projectIndex.status(project).pipe(Effect.mapError(mapError));
				if (status.status !== "ready" || status.summary.completeness !== "complete")
					return yield* Effect.fail(
						failure(
							"inventory",
							"Refresh a complete Project Index before reading signature inventory."
						)
					);
				const result = yield* Cache.get(
					inventories,
					new InventoryKey({
						projectRoot: request.projectRoot,
						projectId: status.summary.projectId,
						generation: status.summary.generation,
						packageCount: status.summary.packageCount
					})
				);
				reportProgress({
					phase: "inventory",
					completed: result.length,
					total: result.length
				});
				return result;
			});
			const verify = Effect.fn("GameTextIndexSource.verify")(function* (
				root: string,
				entries: readonly PackageTextInventoryEntry[]
			) {
				yield* Effect.forEach(
					entries,
					(entry) =>
						Effect.gen(function* () {
							const expected = yield* Schema.decodeUnknownEffect(
								Schema.fromJsonString(Signature)
							)(entry.signature).pipe(
								Effect.mapError((cause) =>
									failure(
										"signature",
										"The Project Index returned an unreadable package bundle signature.",
										cause
									)
								)
							);
							const paths = bundlePaths(resolve(root, entry.path));
							if (expected.length !== paths.length)
								return yield* Effect.fail(
									failure(
										"signature",
										"The Project Index returned an invalid package bundle signature."
									)
								);
							for (let index = 0; index < paths.length; index++) {
								const actual = yield* Effect.tryPromise({
									try: async () => {
										try {
											const value = await stat(paths[index]!, {
												bigint: true
											});
											return {
												size: Number(value.size),
												modifiedMs: Number(value.mtimeNs) / 1_000_000
											};
										} catch (cause) {
											if (
												cause instanceof Error &&
												"code" in cause &&
												cause.code === "ENOENT"
											)
												return null;
											throw cause;
										}
									},
									catch: (cause) =>
										failure(
											"signature",
											`Could not check the bundle files of ${entry.path}.`,
											cause
										)
								});
								const prior = expected[index];
								if (
									actual === null
										? prior !== null
										: prior == null ||
											actual.size !== prior.size ||
											actual.modifiedMs !== prior.modifiedMs
								)
									return yield* Effect.fail(
										failure(
											"signature",
											`Package or sidecar changed while reading ${entry.path}.`
										)
									);
							}
						}),
					{ concurrency: 16, discard: true }
				);
			});
			const extractPackages = reader.extractProjectTextPackages;
			// One reader request per batch keeps each request inside the reader's frame limit. Each
			// batch is verified before and after its own read and emits its own text summary.
			const read = (root: string, entries: readonly PackageTextInventoryEntry[]) => {
				if (!extractPackages)
					return Stream.fail(
						failure(
							"capability",
							"The paired reader does not expose package-text extraction."
						)
					);
				const readBatch = (batch: readonly PackageTextInventoryEntry[]) =>
					Stream.fromEffect(verify(root, batch)).pipe(
						Stream.flatMap(() =>
							extractPackages({
								projectRoot: root,
								paths: batch.map((entry) => entry.path)
							}).pipe(
								Stream.map((event) =>
									event.event === "text_summary"
										? event
										: {
												...event,
												path: relative(
													root,
													resolve(root, event.path)
												).replaceAll("\\", "/")
											}
								),
								Stream.mapError((cause) => failure("read", cause.message, cause)),
								Stream.concat(
									Stream.fromEffect(verify(root, batch)).pipe(Stream.drain)
								)
							)
						)
					);
				return Stream.fromIterable(packageTextReadBatches(entries)).pipe(
					Stream.flatMap(readBatch)
				);
			};
			return GameTextIndexSource.of({ inventory, read });
		})
	);
	return Layer.unwrap(
		Effect.gen(function* () {
			const supplied = yield* Effect.serviceOption(ProjectIndex);
			if (Option.isSome(supplied))
				return source.pipe(Layer.provide(Layer.succeed(ProjectIndex, supplied.value)));
			const reader = yield* AssetReader;
			const configuration = yield* reader.configuration();
			return source.pipe(
				Layer.provide(projectIndexProcessLayerFromReader({ ...configuration, cacheRoot }))
			);
		})
	);
}
