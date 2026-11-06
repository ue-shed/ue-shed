import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./database.ts";
import { SqliteQuery } from "./query.ts";
import { digest } from "./evaluate.ts";
import { stageGeneration } from "./publication.ts";
import { Schema } from "effect";
import { TextCorpusSearchRequest } from "../../../../packages/game-text/src/schema.ts";
import { json } from "./model.ts";

const [beforePath, afterPath, outputPath] = process.argv.slice(2);
if (!beforePath || !afterPath || !outputPath)
	throw new Error("lifecycle.ts BEFORE AFTER NEW_OUTPUT");
const before = resolve(beforePath, "complete.sqlite"),
	after = resolve(afterPath, "complete.sqlite"),
	output = resolve(outputPath);
await mkdir(output);
const path = resolve(output, "published.sqlite");
await copyFile(before, path);
const writer = await openDatabase(path, true);
writer.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
const pinned = await openDatabase(path),
	expected = await openDatabase(after);
try {
	pinned.exec("BEGIN");
	const oldQuery = new SqliteQuery(pinned);
	const oldHash = digest(oldQuery.readLines());
	const request = Schema.decodeUnknownSync(TextCorpusSearchRequest)({
		query: "Unique",
		capability: "all",
		pageSize: 5,
		localization: { target: oldQuery.input.target }
	});
	const oldPage = digest(json(oldQuery.search(request)));
	const newHash = digest(new SqliteQuery(expected).readLines());
	assert.notEqual(oldHash, newHash);
	stageGeneration(writer, after);
	writer.exec("COMMIT; DETACH DATABASE incoming");
	assert.equal(digest(oldQuery.readLines()), oldHash);
	assert.equal(digest(json(oldQuery.search(request))), oldPage);
	const fresh = await openDatabase(path);
	try {
		assert.equal(digest(new SqliteQuery(fresh).readLines()), newHash);
	} finally {
		fresh.close();
	}
	pinned.exec("COMMIT");
	stageGeneration(writer, before);
	writer.exec("ROLLBACK; DETACH DATABASE incoming");
	assert.equal(digest(new SqliteQuery(writer).readLines()), newHash);
} finally {
	pinned.close();
	expected.close();
	writer.close();
}
const child = spawn(
	process.execPath,
	[fileURLToPath(new URL("./crash.ts", import.meta.url)), path, before],
	{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
);
const ended = once(child, "exit");
let uncommittedWalBytes = 0;
try {
	const [ready] = await once(child.stdout, "data", { signal: AbortSignal.timeout(30000) });
	const staged = JSON.parse(String(ready));
	assert.equal(staged.ready, true);
	uncommittedWalBytes = Number(staged.uncommittedWalBytes);
	assert(uncommittedWalBytes > 32);
	child.kill("SIGKILL");
	await ended;
} finally {
	if (child.exitCode === null) child.kill("SIGKILL");
}
const recovered = await openDatabase(path),
	reference = await openDatabase(after);
try {
	assert.equal(
		digest(new SqliteQuery(recovered).readLines()),
		digest(new SqliteQuery(reference).readLines())
	);
	assert.equal(recovered.prepare("PRAGMA integrity_check").all()[0]!.integrity_check, "ok");
} finally {
	recovered.close();
	reference.close();
}
await writeFile(
	resolve(output, "results.json"),
	JSON.stringify({
		completeGenerationCommit: true,
		oldReaderPinned: true,
		rollbackIncludingRecordLayouts: true,
		killedUncommittedWriter: true,
		uncommittedWalBytes,
		integrity: "ok"
	})
);
console.log("Complete-generation publication, pinning, rollback and crash recovery passed.");
