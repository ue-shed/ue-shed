import { parentPort } from "node:worker_threads";
import { createWriteStream } from "node:fs";
import { packageTextJsonLines } from "../packages/game-text/src/package-text-ndjson.ts";
import { once } from "node:events";
import { Schema } from "effect";
import { SavedAssetTextOccurrence } from "../packages/unreal-assets/dist/index.js";
import { PackageTextStored } from "../packages/game-text/src/package-text-columns.ts";

const Request = Schema.Struct({ input: Schema.String, output: Schema.String });
const Occurrence = Schema.Struct({
	event: Schema.Literal("text_occurrence"),
	path: Schema.String,
	occurrence: SavedAssetTextOccurrence
});
const decodeOccurrence = Schema.decodeUnknownSync(Occurrence);
const decodeStored = Schema.decodeUnknownSync(PackageTextStored);
const decodeLine = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Union([Occurrence, PackageTextStored]))
);
parentPort?.on("message", async (message: typeof Request.Encoded) => {
	try {
		const request = Schema.decodeUnknownSync(Request)(message);
		const pending = new Map<string, (typeof SavedAssetTextOccurrence.Type)[]>();
		const output = createWriteStream(request.output, { flags: "wx" });
		try {
			for await (const line of packageTextJsonLines(request.input)) {
				const parsed = decodeLine(line);
				if (Schema.is(Occurrence)(parsed)) {
					const event = decodeOccurrence(parsed);
					const occurrences = pending.get(event.path) ?? [];
					occurrences.push(event.occurrence);
					pending.set(event.path, occurrences);
				} else {
					const record = decodeStored(parsed),
						occurrences = pending.get(record.path) ?? [];
					pending.delete(record.path);
					if (record.evidence.event !== "text_package_record" && occurrences.length)
						throw new Error("STOP: excluded generated package contains decoded text");
					const result = {
						...record,
						evidence:
							record.evidence.event === "text_package_record"
								? { ...record.evidence, occurrences }
								: record.evidence
					};
					if (!output.write(JSON.stringify(result) + "\n")) await once(output, "drain");
				}
			}
			if (pending.size) throw new Error("Unfinished generated occurrences");
			output.end();
			await once(output, "finish");
		} finally {
			output.destroy();
		}
		parentPort?.postMessage("ok");
	} catch (cause) {
		parentPort?.postMessage(String(cause));
	}
});
