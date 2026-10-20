import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { sharedIndexNodeLayer, SharedIndex } from "./shared-index.js";
import { refreshPackageTextLayer, type PackageTextInventoryEntry } from "./package-text-layer.js";
import { decodePackageTextColumns } from "./package-text-columns.js";
import { emptyPackageTextRecord } from "./package-text-record.js";
import { encodeWtf8 } from "./wtf8.js";
import { GameTextIndexProgressReporter, type GameTextIndexProgress } from "./index-progress.js";

describe("cold package refresh", () => {
	it("reads eligible packages once, preserves Unicode paths and excluded records, and reuses the result", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-cold-packages-"));
		const inventory: PackageTextInventoryEntry[] = Array.from({ length: 256 }, (_, row) => ({
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
						expect(first.readPackages).toBe(194);
						const prepared = progress.filter((event) => event.phase === "package_text");
						expect(prepared[0]).toEqual({
							phase: "package_text",
							completed: 0,
							total: 258
						});
						expect(prepared.at(-1)).toEqual({
							phase: "package_text",
							completed: 258,
							total: 258
						});
						expect(progress.at(-1)?.phase).toBe("package_publish");
						expect(requests).toHaveLength(1);
						expect(requests[0]).toHaveLength(194);
						const reader = yield* (yield* SharedIndex).open();
						const records = [];
						for (const name of Object.keys(reader.manifest.active)) {
							if (!name.startsWith("package-text.")) continue;
							records.push(
								...(yield* decodePackageTextColumns(yield* reader.layer(name)))
							);
						}
						expect(records).toHaveLength(258);
						expect(
							records.filter((record) => record.evidence.event === "not_gatherable")
						).toHaveLength(64);
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
});
