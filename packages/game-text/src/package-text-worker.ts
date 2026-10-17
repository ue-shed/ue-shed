import { parentPort } from "node:worker_threads";
import { packageTextJsonLines } from "./package-text-ndjson.js";
import { Schema } from "effect";
import { PackageTextStored, packageTextColumns } from "./package-text-columns.js";
import { writeSnapshotFile } from "./snapshot-file.js";
import { mkdir } from "node:fs/promises";
import { prepareColdStringRuns } from "./shared-string-sort.js";
import { encodeWtf8 } from "./wtf8.js";
import { PackageTextWorkerReply } from "./package-text-worker-protocol.js";
import { snapshotStoreFailure } from "./snapshot-store.js";
import { snapshotFailure } from "./snapshot-format.js";

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
		records.sort((a, b) => Buffer.compare(encodeWtf8(a.path), encodeWtf8(b.path)));
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
			throw snapshotFailure(
				"package-text.inventory",
				"Cold records differ from their signature/header inventory."
			);
		const source = packageTextColumns(records);
		const staging = `${output}.strings`;
		await mkdir(staging);
		const preparedStrings = await prepareColdStringRuns(source, staging);
		await writeSnapshotFile(output, source, 1);
		parentPort?.postMessage({ ok: true, preparedStrings });
	} catch (cause) {
		const error = snapshotStoreFailure(
			"package-text.worker",
			cause,
			"Rebuild the derived package layer from its validated inventory."
		);
		parentPort?.postMessage(
			Schema.encodeUnknownSync(PackageTextWorkerReply)({ ok: false, error })
		);
	}
});
