import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotColumnsSource } from "./snapshot-file.js";
import { encodeStringBlock } from "./snapshot-format.js";
import { SharedStringFiles } from "./shared-string-file.js";
import { sortColdStrings } from "./shared-string-sort.js";

describe("cold external string sort", () => {
	it("scans packed bytes with entry bounds and folds Unicode only when needed", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-domain-scan-"));
		const files = await new SharedStringFiles(root, []).open();
		const strings = ["ab", "cd", "ABC", "é", "É", "İ", "K", "😀/place", "", "x/y/z"];
		try {
			await files.intern("source", strings);
			const [domain] = await files.domain("source");
			expect(domain!.offsets.length).toBe(strings.length + 1);
			for (const query of ["", "bc", "ABC", "é", "i", "k", "/", "😀"])
				expect(domain!.scanSubstring(query)).toBe(
					strings.filter((value) => value.toLowerCase().includes(query.toLowerCase()))
						.length
				);
			const before = files.blocksLoaded;
			await files.strings([0, 1, 2]);
			const coldBlocks = files.blocksLoaded;
			await files.strings([0, 1, 2]);
			expect(files.blocksLoaded).toBe(coldBlocks);
			expect(coldBlocks - before).toBeLessThanOrEqual(1);
		} finally {
			await files.close();
			await rm(root, { recursive: true, force: true });
		}
	});
	it("merges bounded runs, keeps exact GUID case and shares IDs across file/domain boundaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-cold-sort-"));
		const files = await new SharedStringFiles(root, []).open();
		const values = [
			["", "repeat", "😀", "ABCDEF0123456789abcdef0123456789", "source"],
			["repeat", "é", "", "translation", "ABCDEF0123456789abcdef0123456789"],
			["😀", "/Game/Folder/One", "repeat", "/Game/Folder/Two"]
		];
		const domains = ["source", "translation", "paths"];
		const entries = values.map((strings, row) => ({
			name: `Content/Localization/Invented/fr/file-${row}.po`,
			key: `key-${row}`,
			source: snapshotColumnsSource([
				{
					name: `${domains[row]}.b0`,
					kind: "strings",
					domain: domains[row]!,
					stringCount: strings.length,
					values: encodeStringBlock(strings)
				}
			])
		}));
		try {
			const mappings = await sortColdStrings(entries, files, root, 64);
			const maps = mappings.map((mapping) => mapping.maps);
			for (let row = 0; row < entries.length; row++)
				expect(await files.strings(Array.from(maps[row]!.get(domains[row]!)!))).toEqual(
					values[row]
				);
			expect(files.count).toBe(new Set(values.flat()).size);
			expect(files.probePasses).toBe(0);
			expect(files.segments.map((segment) => segment.domains)).toEqual([
				["source"],
				["culture.fr"],
				["paths"]
			]);
			expect(
				(await files.domain("culture.fr")).flatMap((domain) =>
					Array.from({ length: domain.count }, (_, id) => domain.string(id))
				)
			).toEqual(["translation", "é"]);
		} finally {
			await files.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
