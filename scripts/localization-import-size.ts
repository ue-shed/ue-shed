import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdCompressSync, constants } from "node:zlib";
import { performance } from "node:perf_hooks";
import { openSnapshotFile } from "../packages/game-text/src/snapshot-file.ts";
import { snapshotPayload } from "../packages/game-text/src/snapshot-format.ts";

/** Sequential bounded-section probe under the import benchmark's process watchdog. */
export async function measureLocalizationSize(report: string, selectedDomain?: string) {
	const data = JSON.parse(await readFile(report, "utf8"));
	const files = data.results.find(
		(stage: { stage: string }) => stage.stage === "cold:target"
	).files;
	const results = [];
	for (const format of ["archive", "po"]) {
		const file = files.find((file: { format: string }) => file.format === format);
		const manifest = JSON.parse(await readFile(join(file.directory, "manifest.json"), "utf8"));
		const reader = await openSnapshotFile(join(file.directory, manifest.physicalSnapshot));
		try {
			let measuredStage = "";
			const columns = [];
			const domains: Record<
				string,
				{
					raw: number;
					stored: number;
					levels: Record<string, { bytes: number; seconds: number }>;
				}
			> = {};
			for (const entry of reader.directory.entries.values()) {
				if (entry.kind !== "strings") {
					columns.push({
						name: entry.name,
						raw: entry.rawLength,
						stored: entry.storedLength
					});
					continue;
				}
				const domain = (domains[entry.domain] ??= { raw: 0, stored: 0, levels: {} });
				const values = await reader.load(entry.name);
				const raw = snapshotPayload({ ...entry, values });
				domain.raw += raw.length;
				domain.stored += entry.storedLength;
				if (selectedDomain && !selectedDomain.split(",").includes(entry.domain)) continue;
				for (const level of [3, 6, 9, 19]) {
					const nextStage = `size:${format}:${entry.domain}`;
					if (nextStage !== measuredStage) {
						measuredStage = nextStage;
						process.send?.({ kind: "stage", stage: measuredStage });
					}
					const measured = (domain.levels[level] ??= { bytes: 0, seconds: 0 });
					const started = performance.now();
					const compressed = zstdCompressSync(raw, {
						params: { [constants.ZSTD_c_compressionLevel]: level }
					});
					measured.seconds += (performance.now() - started) / 1000;
					measured.bytes += Math.min(compressed.length, raw.length);
				}
			}
			results.push({ format, bytes: reader.directory.fileLength, columns, domains });
			await writeFile(report + ".size-partial.json", JSON.stringify(results));
		} finally {
			await reader.close();
		}
	}
	return results;
}
