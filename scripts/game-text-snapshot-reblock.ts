import { decodeStringBlock, encodeStringBlock } from "../packages/game-text/src/snapshot-format.ts";
import {
	openSnapshotFile,
	writeSnapshotFile,
	type SnapshotSourceColumn
} from "../packages/game-text/src/snapshot-file.ts";
import { snapshotCompressionLevel } from "../packages/game-text/src/snapshot-store.ts";

/** Replay saved sections; no corpus, join, or generated-project work. */
export async function reblockSnapshot(referencePath: string, destination: string, target: number) {
	const reference = await openSnapshotFile(referencePath, { allowLegacy: true });
	try {
		const tables = new Map<string, { domain: string; map: Uint32Array }[]>();
		const mappings = new Map<string, { domain: string; map: Uint32Array }>();
		const select = async (domain: string, names: string[], output: string) => {
			const map = new Uint32Array(
				reference.directory.entries.get(`${domain}.b0`)!.stringCount
			);
			map.fill(0xffffffff);
			map[0] = 0;
			for (const name of names) {
				const values = await reference.load(name);
				for (const id of values) map[id] = 0;
				mappings.set(name, { domain: output, map });
			}
			const segments = tables.get(output) ?? [];
			segments.push({ domain, map });
			tables.set(output, segments);
		};
		await select("hot", ["line.source"], "source");
		await select(
			"hot",
			[...reference.directory.entries.values()]
				.filter(
					(e) => e.kind === "stringIds" && e.domain === "hot" && e.name !== "line.source"
				)
				.map((e) => e.name),
			"identity"
		);
		await select(
			"paths",
			[
				"line.place",
				"occurrence.package",
				"occurrence.object",
				"occurrence.property",
				"occurrence.row"
			],
			"paths"
		);
		for (const entry of reference.directory.entries.values())
			if (
				entry.kind === "strings" &&
				entry.name.endsWith(".b0") &&
				!["hot", "paths"].includes(entry.domain)
			) {
				const map = new Uint32Array(entry.stringCount);
				tables.set(entry.domain, [{ domain: entry.domain, map }]);
			}
		const columns: SnapshotSourceColumn[] = [];
		const counts = new Map<string, number>();
		const stringColumns: SnapshotSourceColumn[] = [];
		for (const [domain, segments] of tables) {
			const starts: number[] = [],
				lengths: number[] = [];
			let count = 0,
				bytes = 8,
				length = 0;
			for (const segment of segments) {
				let oldId = 0;
				for (const entry of reference.directory.entries.values())
					if (entry.kind === "strings" && entry.domain === segment.domain) {
						const raw = await reference.load(entry.name);
						if (!(raw instanceof Uint8Array)) throw new Error("Invalid string section");
						const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
							blockCount = view.getUint32(0, true);
						for (let id = 0; id < blockCount; id++, oldId++) {
							if (segment.map[oldId] === 0xffffffff) continue;
							const width =
								4 +
								view.getUint32(8 + id * 4, true) -
								view.getUint32(4 + id * 4, true);
							if (length && bytes + width > target) {
								starts.push(count - length);
								lengths.push(length);
								bytes = 8;
								length = 0;
							}
							segment.map[oldId] = count++;
							bytes += width;
							length++;
						}
					}
			}
			if (length) {
				starts.push(count - length);
				lengths.push(length);
			}
			counts.set(domain, count);
			async function* strings() {
				for (const segment of segments) {
					let oldId = 0;
					for (const entry of reference.directory.entries.values())
						if (entry.kind === "strings" && entry.domain === segment.domain) {
							const raw = await reference.load(entry.name);
							if (!(raw instanceof Uint8Array))
								throw new Error("Invalid string section");
							const block = decodeStringBlock(raw, entry.name);
							for (let id = 0; id < block.count; id++, oldId++)
								if (segment.map[oldId] !== 0xffffffff) yield block.string(id);
						}
				}
			}
			const iterator = strings();
			for (let block = 0; block < starts.length; block++) {
				const size = lengths[block]!;
				stringColumns.push({
					name: `${domain}.b${block}`,
					kind: "strings",
					domain,
					stringCount: count,
					async load() {
						const values: string[] = [];
						for (let id = 0; id < size; id++) {
							const next = await iterator.next();
							if (next.done) throw new Error("Truncated replay domain");
							values.push(next.value);
						}
						return encodeStringBlock(values);
					}
				});
			}
			stringColumns.push({
				name: `${domain}.starts`,
				kind: "u32",
				load: async () => Uint32Array.from(starts)
			});
		}
		for (const entry of reference.directory.entries.values())
			if (entry.kind !== "strings") {
				const mapping = mappings.get(entry.name),
					domain = mapping?.domain ?? entry.domain;
				const column: SnapshotSourceColumn = {
					name: entry.name,
					kind: entry.kind,
					async load() {
						const original = await reference.load(entry.name);
						return mapping
							? Uint32Array.from(original, (id) => mapping.map[id]!)
							: original;
					}
				};
				columns.push(
					domain ? { ...column, domain, stringCount: counts.get(domain)! } : column
				);
			}
		return await writeSnapshotFile(
			destination,
			{ columns: [...columns, ...stringColumns] },
			snapshotCompressionLevel
		);
	} finally {
		await reference.close();
	}
}
