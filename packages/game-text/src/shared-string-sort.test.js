import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotColumnsSource } from "./snapshot-file.js";
import { encodeStringBlock } from "./snapshot-format.js";
import { SharedStringFiles } from "./shared-string-file.js";
import { prepareColdStringRuns, sortColdStrings } from "./shared-string-sort.js";
import { mkdir } from "node:fs/promises";
describe("cold external string sort", () => {
    it("worker runs preserve mappings and reuse hashes across domains, Unicode and existing IDs", async () => {
        const root = await mkdtemp(join(tmpdir(), "ue-shed-prepared-sort-"));
        const values = [
            ["", "repeat", "é", "\ud800", "😀"],
            ["repeat", "\udc00", "é", "new"]
        ];
        const entries = values.map((strings, row) => ({
            name: `Content/Localization/Invented/fr/file-${row}.po`,
            key: `key-${row}`,
            source: snapshotColumnsSource([
                { name: "file.meta", kind: "bytes", values: new Uint8Array() },
                {
                    name: "source.b0",
                    kind: "strings",
                    domain: "source",
                    stringCount: strings.length,
                    values: encodeStringBlock(strings)
                },
                {
                    name: "translation.b0",
                    kind: "strings",
                    domain: "translation",
                    stringCount: strings.length,
                    values: encodeStringBlock([...strings].reverse())
                }
            ])
        }));
        try {
            for (const existing of [false, true]) {
                const beforeRoot = join(root, `before-${existing}`), afterRoot = join(root, `after-${existing}`);
                await mkdir(beforeRoot);
                await mkdir(afterRoot);
                const before = await new SharedStringFiles(beforeRoot, []).open(), after = await new SharedStringFiles(afterRoot, []).open();
                try {
                    if (existing) {
                        await before.intern("identity", ["repeat", "existing"]);
                        await after.intern("identity", ["repeat", "existing"]);
                    }
                    const expected = await sortColdStrings(entries, before, beforeRoot, 64);
                    const prepared = await Promise.all(entries.map(async (entry, row) => {
                        const staging = join(afterRoot, `worker-${row}`);
                        await mkdir(staging);
                        const preparedStrings = await prepareColdStringRuns(entry.source, staging, 64);
                        return {
                            ...entry,
                            preparedStrings,
                            source: {
                                columns: entry.source.columns.map((column) => ({
                                    ...column,
                                    load: async () => {
                                        throw new Error("Coordinator must not reread worker string blocks");
                                    }
                                }))
                            }
                        };
                    }));
                    const actual = await sortColdStrings(prepared, after, afterRoot, 64);
                    expect(actual).toEqual(expected);
                    expect(after.count).toBe(before.count);
                    for (let row = 0; row < entries.length; row++)
                        expect(await after.strings(Array.from(actual[row].maps.get("source")))).toEqual(values[row]);
                }
                finally {
                    await before.close();
                    await after.close();
                }
            }
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    it("synchronous query strings read cold blocks and share the bounded asynchronous cache", async () => {
        const root = await mkdtemp(join(tmpdir(), "ue-shed-query-strings-"));
        const writer = await new SharedStringFiles(root, []).open();
        const values = Array.from({ length: 500 }, (_, row) => `${row}: first\u2028second é 😀`);
        const ids = await writer.intern("source", values);
        const reader = await new SharedStringFiles(root, writer.segments).open();
        try {
            const selected = [ids[0], ids[67], ids[499], ids[0]];
            expect(reader.stringsSync(selected)).toEqual([
                values[0],
                values[67],
                values[499],
                values[0]
            ]);
            const loaded = reader.blocksLoaded;
            expect(await reader.strings(selected)).toEqual(reader.stringsSync(selected));
            expect(reader.blocksLoaded).toBe(loaded);
            expect(() => reader.stringsSync([-1])).toThrow("Invalid shared ID");
        }
        finally {
            await reader.close();
            await writer.close();
            await rm(root, { recursive: true, force: true });
        }
        expect(() => reader.stringsSync([0])).toThrow("Shared string scope is closed");
    });
    it("synchronous lookups follow appended segments and alternate blocks exactly", async () => {
        const root = await mkdtemp(join(tmpdir(), "ue-shed-query-segments-"));
        const files = await new SharedStringFiles(root, []).open();
        try {
            const first = Array.from({ length: 200 }, (_, row) => `first ${row} é`);
            const firstIds = await files.intern("source", first);
            // Caches the segment starts before the next append adds a segment.
            expect(files.stringsSync([firstIds[0]])).toEqual([first[0]]);
            const second = Array.from({ length: 200 }, (_, row) => `second ${row} 😀`);
            const secondIds = await files.intern("source", second);
            expect(files.segments.length).toBeGreaterThan(1);
            // Single lookups that leave a block and come back must not reuse the wrong block.
            const picks = [0, 199, 1, 64, 0, 130, 63, 64, 199];
            for (const row of picks) {
                expect(files.bytesSync(firstIds[row]).toString("utf8")).toBe(first[row]);
                expect(files.bytesSync(secondIds[row]).toString("utf8")).toBe(second[row]);
                expect(files.bytesSync(firstIds[row]).toString("utf8")).toBe(first[row]);
            }
            const all = [...secondIds, ...firstIds];
            expect(files.stringsSync(all)).toEqual([...second, ...first]);
        }
        finally {
            await files.close();
            await rm(root, { recursive: true, force: true });
        }
        expect(() => files.bytesSync(0)).toThrow("Shared string scope is closed");
    });
    it("scans packed bytes with entry bounds and folds Unicode only when needed", async () => {
        const root = await mkdtemp(join(tmpdir(), "ue-shed-domain-scan-"));
        const files = await new SharedStringFiles(root, []).open();
        const strings = ["ab", "cd", "ABC", "é", "É", "İ", "K", "😀/place", "", "x/y/z"];
        try {
            await files.intern("source", strings);
            const [domain] = await files.domain("source");
            expect(domain.offsets.length).toBe(strings.length + 1);
            for (const query of ["", "bc", "ABC", "é", "i", "k", "/", "😀"])
                expect(domain.scanSubstring(query)).toBe(strings.filter((value) => value.toLowerCase().includes(query.toLowerCase()))
                    .length);
            const before = files.blocksLoaded;
            await files.strings([0, 1, 2]);
            const coldBlocks = files.blocksLoaded;
            await files.strings([0, 1, 2]);
            expect(files.blocksLoaded).toBe(coldBlocks);
            expect(coldBlocks - before).toBeLessThanOrEqual(1);
        }
        finally {
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
                    domain: domains[row],
                    stringCount: strings.length,
                    values: encodeStringBlock(strings)
                }
            ])
        }));
        try {
            const mappings = await sortColdStrings(entries, files, root, 64);
            const maps = mappings.map((mapping) => mapping.maps);
            for (let row = 0; row < entries.length; row++)
                expect(await files.strings(Array.from(maps[row].get(domains[row])))).toEqual(values[row]);
            expect(files.count).toBe(new Set(values.flat()).size);
            expect(files.probePasses).toBe(0);
            expect(files.segments.map((segment) => segment.domains)).toEqual([
                ["source"],
                ["culture.fr"],
                ["paths"]
            ]);
            expect((await files.domain("culture.fr")).flatMap((domain) => Array.from({ length: domain.count }, (_, id) => domain.string(id)))).toEqual(["translation", "é"]);
        }
        finally {
            await files.close();
            await rm(root, { recursive: true, force: true });
        }
    });
});
