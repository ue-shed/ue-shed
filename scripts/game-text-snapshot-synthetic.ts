import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { readScaleRecipe } from "./game-text-scale-options.ts";
import {
	decodeStringBlock,
	encodeStringBlock,
	type SnapshotEntry
} from "../packages/game-text/src/snapshot-format.ts";
import {
	openSnapshotFile,
	writeSnapshotFile,
	type SnapshotSourceColumn
} from "../packages/game-text/src/snapshot-file.ts";

/** Format-size probe only. Uses measured deduplicated 1× bytes, never PO widths or today's 10× join. */
export async function syntheticScaleSnapshot(
	project: string,
	file: string,
	mark: (name: string) => void,
	referencePath: string,
	targetBytes: number
) {
	const recipe = await readScaleRecipe(project);
	if (recipe.scale !== 10 || recipe.cultures.length !== 20)
		throw new Error("Expected retained 10× recipe");
	const descriptor = Schema.decodeUnknownSync(
		Schema.fromJsonString(
			Schema.Struct({
				recipe: Schema.Struct({
					resolved: Schema.Int,
					keyless: Schema.Int,
					gatheredOnly: Schema.Int,
					notFound: Schema.Int
				})
			})
		)
	)(await readFile(resolve(project, "scale.json"), "utf8"));
	const lines = Object.values(descriptor.recipe).reduce((sum, value) => sum + value, 0);
	const reference = await openSnapshotFile(referencePath);
	try {
		mark("measured-1x-string-census");
		const domains = new Map<string, { count: number; bytes: number }>();
		for (const entry of reference.directory.entries.values()) {
			if (entry.kind !== "strings") continue;
			const bytes = await reference.load(entry.name);
			if (!(bytes instanceof Uint8Array)) throw new Error("Invalid reference block");
			const block = decodeStringBlock(bytes, entry.name);
			const value = domains.get(entry.domain) ?? { count: entry.stringCount, bytes: 0 };
			value.bytes += bytes.length - 4 - (block.count + 1) * 4;
			domains.set(entry.domain, value);
		}
		const targets = new Map(domains);
		for (let i = 10; i < 20; i++) targets.set(`c${i}`, domains.get(`c${i % 10}`)!);
		const columns: SnapshotSourceColumn[] = [];
		const scaledName = (name: string, culture: number) =>
			name.replace(/^c[0-9]+/u, `c${culture}`);
		const add = (entry: SnapshotEntry, name = entry.name, domain = entry.domain) => {
			const stringCount = entry.stringCount * 10;
			const column: SnapshotSourceColumn = {
				name,
				kind: entry.kind,
				async load() {
					const original = await reference.load(entry.name);
					const length = entry.name === "culture.names" ? 20 : original.length * 10;
					const values =
						original instanceof Uint32Array
							? new Uint32Array(length)
							: new Uint8Array(length);
					for (let row = 0; row < length; row++) {
						const value = original[row % original.length] ?? 0;
						values[row] =
							entry.kind === "stringIds" && value !== 0
								? value * 10 + (row % 10)
								: value;
					}
					return values;
				}
			};
			columns.push(domain ? { ...column, domain, stringCount } : column);
		};
		for (const entry of reference.directory.entries.values()) {
			if (entry.kind === "strings" || entry.name.endsWith(".starts")) continue;
			add(entry);
			const culture = entry.name.match(/^c([0-9]+)\./u);
			if (culture) {
				const index = Number(culture[1]) + 10;
				add(entry, scaledName(entry.name, index), entry.domain ? `c${index}` : "");
			}
		}
		const widths: Record<
			string,
			{
				referenceCount: number;
				referenceUtf8Bytes: number;
				count: number;
				utf8Bytes: number;
				bytesPerString: number;
			}
		> = {};
		for (const [domain, measured] of targets) {
			const count = measured.count * 10;
			const byteTarget = measured.bytes * 10;
			const width = measured.bytes / measured.count;
			widths[domain] = {
				referenceCount: measured.count,
				referenceUtf8Bytes: measured.bytes,
				count,
				utf8Bytes: byteTarget,
				bytesPerString: width
			};
			const starts: number[] = [];
			for (let start = 0; start < count; ) {
				let end = Math.min(
					count,
					start + Math.max(1, Math.floor((targetBytes - 8) / (width + 4)))
				);
				while (
					end > start + 1 &&
					8 + (end - start) * 4 + Math.floor(end * width) - Math.floor(start * width) >
						targetBytes
				)
					end--;
				const blockEnd = end;
				starts.push(start);
				const blockStart = start;
				columns.push({
					name: `${domain}.b${starts.length - 1}`,
					kind: "strings",
					domain,
					stringCount: count,
					async load() {
						const strings: string[] = [];
						for (let id = blockStart; id < blockEnd; id++) {
							const length = Math.floor((id + 1) * width) - Math.floor(id * width);
							const token = id.toString(36);
							// Width is exactly the deduplicated domain mean. Repeated invented words
							// are deliberately compressible; this does not predict real content ratios.
							strings.push(
								`${token}/invented source words for snapshot size probe `
									.repeat(Math.ceil(length / 48) + 1)
									.slice(0, length)
							);
						}
						return encodeStringBlock(strings);
					}
				});
				start = end;
			}
			columns.push({
				name: `${domain}.starts`,
				kind: "u32",
				load: async () => Uint32Array.from(starts)
			});
		}
		mark("streaming-synthetic-sections");
		const { snapshotCompressionLevel } =
			await import("../packages/game-text/src/snapshot-store.ts");
		const directory = await writeSnapshotFile(file, { columns }, snapshotCompressionLevel);
		const dimensions = {
			lines,
			occurrences: recipe.occurrences,
			cultures: 20,
			widths,
			referenceLines: lines / 10,
			referenceOccurrences: recipe.occurrences / 10
		};
		await writeFile(`${file}.dimensions.json`, JSON.stringify(dimensions, null, "\t") + "\n");
		return { dimensions, fileBytes: directory.fileLength, sections: directory.entries.size };
	} finally {
		await reference.close();
	}
}
