import { createReadStream } from "node:fs";
import { snapshotCheck } from "./snapshot-format.js";

/** NDJSON framing is LF only. Node readline also splits authored U+2028/U+2029 on Node 24+. */
export async function* packageTextJsonLines(path: string) {
	const input = createReadStream(path, { highWaterMark: 256 * 1024 });
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let pending = "";
	try {
		for await (const chunk of input) {
			pending += decoder.decode(chunk, { stream: true });
			let start = 0;
			for (
				let end = pending.indexOf("\n", start);
				end >= 0;
				end = pending.indexOf("\n", start)
			) {
				const line = pending.slice(start, end);
				if (line) yield line;
				start = end + 1;
			}
			pending = pending.slice(start);
			snapshotCheck(
				pending.length <= 128 * 1024 ** 2,
				"package-text.ndjson",
				"Record exceeds cap"
			);
		}
		pending += decoder.decode();
		if (pending) yield pending;
	} finally {
		input.destroy();
	}
}
