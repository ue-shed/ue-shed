import { parentPort } from "node:worker_threads";
import { packageTextJsonLines } from "./package-text-ndjson.js";
import { Schema } from "effect";
import { PackageTextStored, packageTextColumns } from "./package-text-columns.js";
import { writeSnapshotFile } from "./snapshot-file.js";

const Request = Schema.Struct({
	input: Schema.String,
	output: Schema.String,
	expected: Schema.Array(
		Schema.Struct({ path: Schema.String, signature: Schema.String, selected: Schema.Boolean })
	)
});
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(PackageTextStored));
parentPort?.on("message", async (request: typeof Request.Encoded) => {
	try {
		const { input, output, expected } = Schema.decodeUnknownSync(Request)(request);
		const records: PackageTextStored[] = [];
		for await (const line of packageTextJsonLines(input)) records.push(decodeRecord(line));
		records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		if (
			records.length !== expected.length ||
			records.some((record, row) => {
				const entry = expected[row]!;
				return (
					record.path !== entry.path ||
					record.evidence.path !== entry.path ||
					record.signature !== entry.signature ||
					entry.selected === (record.evidence.event === "not_gatherable")
				);
			})
		)
			throw new Error("Cold records differ from their signature/header inventory");
		await writeSnapshotFile(output, packageTextColumns(records), 1);
		parentPort?.postMessage("ok");
	} catch (cause) {
		parentPort?.postMessage(String(cause));
	}
});
