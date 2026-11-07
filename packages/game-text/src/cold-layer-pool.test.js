import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareColdLayers } from "./cold-layer-pool.js";
import { SharedStringFiles } from "./shared-string-file.js";
import { encodeStringBlock, SnapshotFormatError } from "./snapshot-format.js";
import { openSnapshotFile, snapshotColumnsSource, writeSnapshotFile } from "./snapshot-file.js";
describe("cold layer conversion workers", () => {
    it.each([false, true])("preserves global IDs and typed failures; corrupt mapping: %s", async (corrupt) => {
        const root = await mkdtemp(join(tmpdir(), "ue-shed-cold-layers-"));
        const strings = await new SharedStringFiles(root, []).open();
        try {
            const ids = await strings.intern("source", ["exact \ud800 source"]);
            const source = snapshotColumnsSource([
                {
                    name: "source.b0",
                    kind: "strings",
                    domain: "source",
                    stringCount: 1,
                    values: encodeStringBlock(["exact \ud800 source"])
                },
                { name: "source.starts", kind: "u32", values: Uint32Array.of(0) },
                {
                    name: "source.refs",
                    kind: "stringIds",
                    domain: "source",
                    stringCount: 1,
                    values: Uint32Array.of(0)
                }
            ]);
            const entries = [];
            for (let row = 0; row < 2; row++) {
                const stagedFile = join(root, `input-${row}.snapshot`);
                await writeSnapshotFile(stagedFile, source);
                entries.push({ name: `file-${row}`, key: `key-${row}`, source, stagedFile });
            }
            const mappings = entries.map((_, row) => ({
                maps: new Map([
                    ["source", corrupt && row === 1 ? Uint32Array.of(ids[0], ids[0]) : ids]
                ]),
                hashes: {}
            }));
            const pending = prepareColdLayers(root, "test-generation", strings.segments, entries, mappings);
            if (corrupt)
                await expect(pending).rejects.toBeInstanceOf(SnapshotFormatError);
            else {
                const records = await pending;
                expect(records.size).toBe(2);
                for (const { record } of records.values()) {
                    expect(record.storeGeneration).toBe("test-generation");
                    expect(record.segmentCount).toBe(strings.segments.length);
                    const reader = await openSnapshotFile(join(root, record.file));
                    try {
                        await reader.verify();
                        expect(await reader.load("source.refs")).toEqual(Uint32Array.of(ids[0] * 2));
                    }
                    finally {
                        await reader.close();
                    }
                }
            }
        }
        finally {
            await strings.close();
            await rm(root, { recursive: true, force: true });
        }
    }, 15000);
});
