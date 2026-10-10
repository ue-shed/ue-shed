import { openSync, closeSync, writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { packageTextJsonLines } from "../packages/game-text/src/package-text-ndjson.ts";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Schema } from "effect";
import { SavedAssetTextExtractionEvent } from "../packages/unreal-assets/dist/index.js";
import {
	emptyPackageTextRecord,
	retainPackageTextGap
} from "../packages/game-text/src/package-text-record.ts";
import {
	PackageTextInventoryEntry,
	packageTextShard,
	PACKAGE_TEXT_SHARDS
} from "../packages/game-text/src/package-text-layer.ts";
import type { SavedAssetTextCoverageGap } from "../packages/unreal-assets/dist/index.js";

class Spool {
	private readonly handle: number;
	private readonly buffer = Buffer.allocUnsafe(256 * 1024);
	private position = 0;
	constructor(path: string) {
		this.handle = openSync(path, "wx");
	}
	append(line: string) {
		const bytes = Buffer.from(line + "\n");
		for (let offset = 0; offset < bytes.length; ) {
			const size = Math.min(bytes.length - offset, this.buffer.length - this.position);
			this.buffer.set(bytes.subarray(offset, offset + size), this.position);
			offset += size;
			this.position += size;
			if (this.position === this.buffer.length) this.flush();
		}
	}
	private flush() {
		for (let offset = 0; offset < this.position; )
			offset += writeSync(this.handle, this.buffer, offset, this.position - offset);
		this.position = 0;
	}
	close() {
		try {
			this.flush();
		} finally {
			closeSync(this.handle);
		}
	}
}

/** Conversion of retained bytes, never generation. Text-package flags are assigned explicitly.
 * Gaps are contiguous by package in the retained generator; reject deviations instead of losing them.
 */
export async function convertGeneratedPackageText(
	project: string,
	directory: string,
	textPackages: number
) {
	await mkdir(directory); // Exclusive destination, never overwrite source input.
	const spools = Array.from(
		{ length: PACKAGE_TEXT_SHARDS },
		(_, shard) => new Spool(join(directory, `events.${shard}.ndjson`))
	);
	const inventory = new Spool(join(directory, "inventory.ndjson"));
	const decodeGap = Schema.decodeUnknownSync(SavedAssetTextExtractionEvent);
	let current = emptyPackageTextRecord(""),
		samples: SavedAssetTextCoverageGap[] = [];
	let occurrences = 0,
		packages = 0,
		gaps = 0;
	try {
		for await (const line of packageTextJsonLines(join(project, "saved-text.ndjson"))) {
			// This streaming census reads 20 GB at 10×. Validate occurrence payloads in bounded workers.
			const event: typeof SavedAssetTextExtractionEvent.Type = JSON.parse(line);
			if (event.event === "text_summary") continue;
			if (event.event === "error")
				throw new Error("Generated saved-text input contains a failure");
			const shard = packageTextShard(event.path);
			if (event.event === "text_occurrence") {
				spools[shard]!.append(line);
				occurrences++;
				continue;
			}
			if (current.path === "") {
				current = emptyPackageTextRecord(event.path);
				samples = [];
			}
			if (current.path !== event.path)
				throw new Error("Generated gaps must be package contiguous");
			if (event.event === "text_coverage_gap") {
				const checked = decodeGap(event);
				if (checked.event !== "text_coverage_gap") throw new Error("Invalid gap");
				retainPackageTextGap(current.gapCounts, samples, checked.coverage_gap);
				gaps++;
				continue;
			}
			const index = Number(event.path.match(/Package(\d+)\.uasset$/u)?.[1]);
			if (!Number.isSafeInteger(index)) throw new Error("Unexpected generated package path");
			const selected = index < textPackages;
			const signature = JSON.stringify([event.fileBytes, 0]);
			const evidence = selected
				? {
						...current,
						status: event.status,
						fileBytes: event.fileBytes,
						decodeErrors: event.diagnostics.length,
						gapSamples: samples
					}
				: { event: "not_gatherable", path: event.path };
			spools[shard]!.append(JSON.stringify({ path: event.path, signature, evidence }));
			inventory.append(
				JSON.stringify({
					path: event.path,
					signature,
					headerData: {
						packageFlags: selected ? 0x00040000 : 0,
						gatherableTextDataCount: 0,
						gatherableTextDataOffset: 0,
						hasTextProperty: false
					}
				})
			);
			current = emptyPackageTextRecord("");
			packages++;
		}
		if (current.path) throw new Error("Unfinished generated package");
	} finally {
		for (const spool of spools) spool.close();
		inventory.close();
	}
	const pending = Array.from({ length: PACKAGE_TEXT_SHARDS }, (_, shard) => shard);
	const workers: Worker[] = [];
	try {
		await Promise.all(
			Array.from({ length: 8 }, async () => {
				const url = new URL("./package-text-generated-worker.ts", import.meta.url);
				const worker = new Worker(
					`import("tsx/esm/api").then(async ({ register }) => { register(); await import(${JSON.stringify(url.href)}); });`,
					{ eval: true, resourceLimits: { maxOldGenerationSizeMb: 16384 } }
				);
				workers.push(worker);
				for (let shard = pending.shift(); shard !== undefined; shard = pending.shift()) {
					const currentShard = shard;
					await new Promise<void>((resolve, reject) => {
						const clean = () => {
							worker.off("message", message);
							worker.off("error", error);
							worker.off("exit", exit);
						};
						const message = (reply: string) => {
							clean();
							if (reply === "ok") resolve();
							else reject(new Error(reply));
						};
						const error = (cause: Error) => {
							clean();
							reject(cause);
						};
						const exit = (code: number) => {
							clean();
							reject(new Error(`Conversion worker exited (${code})`));
						};
						worker.once("message", message);
						worker.once("error", error);
						worker.once("exit", exit);
						worker.postMessage({
							input: join(directory, `events.${currentShard}.ndjson`),
							output: join(directory, `package-text.${currentShard}.ndjson`)
						});
					});
				}
			})
		);
	} finally {
		await Promise.all(workers.map((worker) => worker.terminate()));
	}
	return {
		packages,
		occurrences,
		gaps,
		selectedPackages: textPackages,
		flagPolicy:
			"Generated text packages flagged; all other packages unflagged. Original retained stream has no flags."
	};
}

export async function readGeneratedPackageInventory(directory: string) {
	const decode = Schema.decodeUnknownSync(Schema.fromJsonString(PackageTextInventoryEntry));
	const inventory: PackageTextInventoryEntry[] = [];
	for await (const line of packageTextJsonLines(join(directory, "inventory.ndjson")))
		inventory.push(decode(line));
	inventory.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return inventory;
}

export async function readGeneratedPackageRecord(directory: string, path: string) {
	const { PackageTextStored } = await import("../packages/game-text/src/package-text-columns.ts");
	const decode = Schema.decodeUnknownSync(Schema.fromJsonString(PackageTextStored));
	for await (const line of packageTextJsonLines(
		join(directory, `package-text.${packageTextShard(path)}.ndjson`)
	)) {
		const record = decode(line);
		if (record.path === path) return record;
	}
	throw new Error("Missing converted package");
}
