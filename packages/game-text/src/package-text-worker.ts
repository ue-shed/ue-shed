import { parentPort } from "node:worker_threads";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { Exit, Schema } from "effect";
import { SavedAssetPackageTextEvent } from "@ue-shed/unreal-assets";
import { packageTextJsonLines } from "./package-text-ndjson.js";
import { PackageTextStored, packageTextColumns } from "./package-text-columns.js";
import { mountPackageTextEvent } from "./package-object-path.js";
import { writeSnapshotFile } from "./snapshot-file.js";
import { prepareColdStringRuns, type PreparedColdStrings } from "./shared-string-sort.js";
import { encodeWtf8 } from "./wtf8.js";
import { PackageTextWorkerReply } from "./package-text-worker-protocol.js";
import { snapshotStoreFailure } from "./snapshot-store.js";
import { snapshotFailure } from "./snapshot-format.js";

const Expected = Schema.Array(
	Schema.Struct({ path: Schema.String, signature: Schema.String, selected: Schema.Boolean })
);
/** One shard whose records the host staged as `PackageTextStored` NDJSON. */
const ShardRequest = Schema.Struct({
	input: Schema.String,
	output: Schema.String,
	/** Sort the shard's string runs for a writer that publishes from prepared runs. */
	prepareStrings: Schema.Boolean,
	expected: Expected
});
/**
 * The shards of one reader staging group: `input` holds the reader's own record lines for the
 * group's selected packages, still absolute and unmounted; unselected packages have no line.
 */
const GroupRequest = Schema.Struct({
	group: Schema.String,
	projectRoot: Schema.String,
	prepareStrings: Schema.Boolean,
	shards: Schema.Array(
		Schema.Struct({ name: Schema.String, output: Schema.String, expected: Expected })
	)
});
const Request = Schema.Union([ShardRequest, GroupRequest]);
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(PackageTextStored));
// The reader's own lines get the validation the host applies to its protocol stream: a
// type-side check, which accepts values that already satisfy the decoded type, then the full
// decoder for anything that needs normalizing or is invalid.
const validateStagedEvent = Schema.decodeUnknownExit(Schema.toType(SavedAssetPackageTextEvent), {
	onExcessProperty: "error"
});
const decodeStagedEvent = Schema.decodeUnknownSync(SavedAssetPackageTextEvent, {
	onExcessProperty: "error"
});
function stagedEvent(line: string): typeof SavedAssetPackageTextEvent.Type {
	const value: unknown = JSON.parse(line);
	const validated = validateStagedEvent(value);
	return Exit.isSuccess(validated) ? validated.value : decodeStagedEvent(value);
}

/** Sorted, inventory-checked columns of one shard, written as its staged snapshot. */
async function writeShard(
	records: PackageTextStored[],
	expected: typeof Expected.Type,
	output: string,
	prepareStrings: boolean
) {
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
	let preparedStrings: PreparedColdStrings | undefined;
	if (prepareStrings) {
		const staging = `${output}.strings`;
		await mkdir(staging);
		preparedStrings = await prepareColdStringRuns(source, staging);
	}
	// A staged input, uncompressed and unsynced: the writer reads it in this session and
	// publishes compressed, durable layers from it.
	await writeSnapshotFile(output, source, 0, undefined, undefined, { durable: false });
	return preparedStrings;
}

async function convertGroup(request: typeof GroupRequest.Type) {
	const staged = new Map<
		string,
		Exclude<typeof SavedAssetPackageTextEvent.Type, { readonly event: "text_summary" }>
	>();
	if (existsSync(request.group))
		for await (const line of packageTextJsonLines(request.group)) {
			const event = stagedEvent(line);
			if (event.event === "text_summary")
				throw snapshotFailure("package-text.read", "A staged line is not a package");
			// As the host's stream does: project-relative paths, then Unreal's object paths.
			const path = relative(
				request.projectRoot,
				resolve(request.projectRoot, event.path)
			).replaceAll("\\", "/");
			if (staged.has(path))
				throw snapshotFailure("package-text.read", "Unexpected or duplicate package");
			const mounted = mountPackageTextEvent(request.projectRoot, { ...event, path });
			if (mounted.event === "text_summary")
				throw snapshotFailure("package-text.read", "A staged line is not a package");
			staged.set(path, mounted);
		}
	const shards: { name: string; preparedStrings?: PreparedColdStrings }[] = [];
	let used = 0;
	for (const shard of request.shards) {
		const records = shard.expected.map(({ path, signature, selected }): PackageTextStored => {
			if (!selected) return { path, signature, evidence: { event: "not_gatherable", path } };
			const evidence = staged.get(path);
			if (evidence === undefined)
				throw snapshotFailure("package-text.read", "Reader omitted requested packages");
			used++;
			return { path, signature, evidence };
		});
		const preparedStrings = await writeShard(
			records,
			shard.expected,
			shard.output,
			request.prepareStrings
		);
		shards.push(preparedStrings ? { name: shard.name, preparedStrings } : { name: shard.name });
	}
	if (used !== staged.size)
		throw snapshotFailure("package-text.read", "Unexpected or duplicate package");
	return shards;
}

parentPort?.on("message", async (message: typeof Request.Encoded) => {
	try {
		const request = Schema.decodeUnknownSync(Request)(message);
		if ("group" in request) {
			parentPort?.postMessage({ ok: true, shards: await convertGroup(request) });
			return;
		}
		const records: PackageTextStored[] = [];
		for await (const line of packageTextJsonLines(request.input))
			records.push(decodeRecord(line));
		const preparedStrings = await writeShard(
			records,
			request.expected,
			request.output,
			request.prepareStrings
		);
		parentPort?.postMessage(preparedStrings ? { ok: true, preparedStrings } : { ok: true });
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
