import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Schema } from "effect";
import { gameTextEngineContract } from "../../../../packages/protocol/dist/index.js";

const files = ["input.json", "units.ndjson", "lines.ndjson", "raw-lines.ndjson"];
const Seal = Schema.Struct({
	contractHash: Schema.String,
	files: Schema.Record(Schema.String, Schema.String)
});
export async function fileHash(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(path)) hash.update(bytes);
	return hash.digest("hex");
}
export async function seal(root: string): Promise<void> {
	const hashes: Record<string, string> = {};
	for (const name of files) hashes[name] = await fileHash(resolve(root, name));
	await writeFile(
		resolve(root, "seal.json"),
		JSON.stringify({ contractHash: gameTextEngineContract.contractHash, files: hashes })
	);
}
export async function verify(root: string): Promise<void> {
	const sealed = Schema.decodeUnknownSync(Schema.fromJsonString(Seal))(
		await readFile(resolve(root, "seal.json"), "utf8")
	);
	if (sealed.contractHash !== gameTextEngineContract.contractHash)
		throw new Error("Retained bundle belongs to another engine contract; regenerate it");
	for (const name of files)
		if ((await fileHash(resolve(root, name))) !== sealed.files[name])
			throw new Error(`Retained file changed: ${name}; regenerate the bundle`);
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/full/seal.ts"))
	await seal(resolve(process.argv[2]!));
