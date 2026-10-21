import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { sharedIndexNodeLayer, SharedIndex } from "./shared-index.js";
import { refreshPackageTextLayer, type PackageTextInventoryEntry } from "./package-text-layer.js";
import { decodePackageTextColumns } from "./package-text-columns.js";
import { emptyPackageTextRecord } from "./package-text-record.js";
import { mountPackageTextEvent } from "./package-object-path.js";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { encodeWtf8 } from "./wtf8.js";
import { GameTextIndexProgressReporter, type GameTextIndexProgress } from "./index-progress.js";

describe("cold package refresh", () => {
	it("reads eligible packages once, preserves Unicode paths and excluded records, and reuses the result", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-cold-packages-"));
		const inventory: PackageTextInventoryEntry[] = Array.from({ length: 24 }, (_, row) => ({
			path: `Content/Package${row}.uasset`,
			signature: `signature-${row}`,
			headerData: {
				packageFlags: row % 4 === 0 ? 0 : 0x40000,
				gatherableTextDataCount: 0,
				gatherableTextDataOffset: 0,
				hasTextProperty: false
			}
		}));
		for (const name of ["\ue000", "😀"])
			inventory.push({ ...inventory[1]!, path: `Content/${name}.uasset`, signature: name });
		inventory.sort((a, b) => Buffer.compare(encodeWtf8(a.path), encodeWtf8(b.path)));
		const requests: (readonly string[])[] = [];
		const progress: GameTextIndexProgress[] = [];
		const input = {
			coldMinimumPackages: 24,
			inventory,
			read: (paths: readonly string[]) => {
				requests.push(paths);
				return Stream.fromIterable(paths.map((path) => emptyPackageTextRecord(path)));
			}
		};
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const first = yield* Effect.scoped(refreshPackageTextLayer(input)).pipe(
							Effect.provideService(GameTextIndexProgressReporter, (event) => {
								progress.push(event);
							})
						);
						expect(first.readPackages).toBe(20);
						const prepared = progress.filter((event) => event.phase === "package_text");
						expect(prepared[0]).toEqual({
							phase: "package_text",
							completed: 0,
							total: 26
						});
						expect(prepared.at(-1)).toEqual({
							phase: "package_text",
							completed: 26,
							total: 26
						});
						expect(progress.at(-1)?.phase).toBe("package_publish");
						expect(requests).toHaveLength(1);
						expect(requests[0]).toHaveLength(20);
						const reader = yield* (yield* SharedIndex).open();
						const records = [];
						for (const name of Object.keys(reader.manifest.active)) {
							if (!name.startsWith("package-text.")) continue;
							records.push(
								...(yield* decodePackageTextColumns(yield* reader.layer(name)))
							);
						}
						expect(records).toHaveLength(26);
						expect(
							records.filter((record) => record.evidence.event === "not_gatherable")
						).toHaveLength(6);
						expect(records.map((record) => record.path).sort()).toEqual(
							inventory.map((entry) => entry.path).sort()
						);
						const second = yield* Effect.scoped(refreshPackageTextLayer(input));
						expect(second.published).toBe(false);
						expect(requests).toHaveLength(1);
					})
				).pipe(
					Effect.provide(
						sharedIndexNodeLayer({
							cacheRoot: root,
							projectKey: root,
							targetKey: "cold"
						})
					)
				)
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 15000);

	it("builds the same layers from reader-staged groups as from streamed records", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-staged-packages-"));
		const inventory: PackageTextInventoryEntry[] = Array.from({ length: 300 }, (_, row) => ({
			path: `Content/Folder${row % 7}/Package${row}.uasset`,
			signature: `signature-${row}`,
			headerData: {
				packageFlags: row % 5 === 0 ? 0 : 0x40000,
				gatherableTextDataCount: 0,
				gatherableTextDataOffset: 0,
				hasTextProperty: false
			}
		}));
		inventory.push({ ...inventory[1]!, path: "Content/😀.uasset", signature: "emoji" });
		inventory.sort((a, b) => Buffer.compare(encodeWtf8(a.path), encodeWtf8(b.path)));
		// Package-relative object paths, which the read path mounts on Unreal's package name.
		const record = (path: string): SavedAssetPackageTextRecord => ({
			...emptyPackageTextRecord(path),
			occurrences: [
				{
					source: `Text of ${path}`,
					dev_notes: "",
					identity: { status: "resolved", namespace: "", key: path },
					location: {
						kind: "asset_property",
						object_path: "Asset.Widget",
						class_path: "/Script/UMG.TextBlock",
						property_path: "Text"
					},
					edit_capability: "read_only"
				}
			]
		});
		const layers = async (staged: boolean) => {
			const cacheRoot = join(root, staged ? "staged" : "streamed");
			const reads: string[] = [];
			const input = {
				inventory,
				read: (paths: readonly string[]) => {
					reads.push("read");
					return Stream.fromIterable(
						paths.map((path) => mountPackageTextEvent(root, record(path)))
					);
				},
				...(staged
					? {
							stage: {
								projectRoot: root,
								read: (
									paths: readonly string[],
									directory: string,
									groups: readonly number[]
								) => {
									reads.push("stage");
									return Stream.fromEffect(
										Effect.promise(async () => {
											// Out of order and absolute, as the reader writes them.
											for (let row = paths.length - 1; row >= 0; row--)
												await appendFile(
													join(directory, `${groups[row]}.ndjson`),
													`${JSON.stringify({ ...record(paths[row]!), path: join(root, paths[row]!) })}
`
												);
										})
									).pipe(
										Stream.flatMap(() => Stream.fromIterable(paths)),
										Stream.map((path) => ({ path }))
									);
								}
							}
						}
					: undefined)
			};
			return Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const result = yield* Effect.scoped(refreshPackageTextLayer(input));
						const reader = yield* (yield* SharedIndex).open();
						const records: Record<string, unknown> = {};
						for (const name of Object.keys(reader.manifest.active).sort())
							records[name] = yield* decodePackageTextColumns(
								yield* reader.layer(name)
							);
						return { reads, readPackages: result.readPackages, records };
					})
				).pipe(
					Effect.provide(
						sharedIndexNodeLayer({ cacheRoot, projectKey: root, targetKey: "cold" })
					)
				)
			);
		};
		try {
			const streamed = await layers(false);
			const staged = await layers(true);
			expect(streamed.reads).toEqual(["read"]);
			expect(staged.reads).toEqual(["stage"]);
			expect(staged.readPackages).toBe(streamed.readPackages);
			expect(Object.keys(staged.records).length).toBeGreaterThan(100);
			expect(staged.records).toEqual(streamed.records);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30000);
});
