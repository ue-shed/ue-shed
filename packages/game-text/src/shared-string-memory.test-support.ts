import { mkdir } from "node:fs/promises";
import { SharedStringFiles } from "./shared-string-file.js";

if (!globalThis.gc || !process.argv[2]) throw new Error("Need exposed GC and a cache directory");
await mkdir(process.argv[2], { recursive: true });
const files = await new SharedStringFiles(process.argv[2], []).open();
globalThis.gc();
const before = process.memoryUsage().heapUsed;
try {
	for (let start = 0; start < 500000; start += 250000)
		await files.copyUnique(
			"source",
			Array.from({ length: 250000 }, (_, row) => `memory-${start + row}:${"x".repeat(128)}`)
		);
	await files.flush();
	await new Promise<void>((done) => setImmediate(done));
	globalThis.gc();
	await new Promise<void>((done) => setImmediate(done));
	globalThis.gc();
	process.stdout.write(
		JSON.stringify({
			strings: files.count,
			segments: files.segments.length,
			retainedGrowth: process.memoryUsage().heapUsed - before
		})
	);
} finally {
	await files.close();
}
