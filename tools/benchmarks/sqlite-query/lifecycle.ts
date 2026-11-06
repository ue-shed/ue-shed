/** Structural SQLite lifecycle checks; these do not reimplement the Unreal join's edit semantics. */
import { equal, deepStrictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { openSqlite } from "./driver.ts";
import { sqlText, type Database } from "./sqlite.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("lifecycle.ts INPUT_DB NEW_OUTPUT_DIRECTORY");
await mkdir(resolve(output), { recursive: false });
const file = resolve(output, "lifecycle.sqlite");
await copyFile(resolve(input), file);
const db = await openSqlite(file, "node", true);
const changes: { operation: string; ms: number }[] = [];
function intern(text: string) {
	const raw = Buffer.from(text, "utf16le");
	return Number(
		db
			.prepare("INSERT INTO string(value,folded,utf16) VALUES (?,?,?) RETURNING id")
			.all(sqlText(text), sqlText(text.toLowerCase()), raw.swap16())[0]!.id
	);
}
const read = (connection: Database) =>
	connection
		.prepare(
			"SELECT l.id,s.value AS source,l.audience FROM line l JOIN string s ON s.id=l.source WHERE l.rank=0"
		)
		.all();
try {
	const before = read(db);
	let at = performance.now();
	db.exec("BEGIN IMMEDIATE");
	const source = intern("SQLite spike edited source");
	db.prepare("UPDATE line SET source=? WHERE rank=0").run(source);
	db.prepare("UPDATE line_culture SET state='needs_update' WHERE line=0").run();
	db.exec("COMMIT");
	changes.push({ operation: "normalized-line-and-culture-edit", ms: performance.now() - at });
	equal(read(db)[0]!.source, "SQLite spike edited source");
	equal(
		db.prepare("SELECT count(*) AS n FROM text_fts WHERE folded GLOB '*spike*'").all()[0]!.n,
		1
	);
	const edited = read(db);
	at = performance.now();
	db.exec("BEGIN IMMEDIATE; UPDATE line SET audience='editor' WHERE rank=0; ROLLBACK");
	changes.push({ operation: "rollback", ms: performance.now() - at });
	deepStrictEqual(read(db), edited);
	at = performance.now();
	const rank = Number(db.prepare("SELECT max(rank)+1 AS rank FROM line").all()[0]!.rank);
	db.exec("BEGIN IMMEDIATE");
	db.prepare(
		"INSERT INTO line SELECT ?,?,namespace,key,source,audience FROM line WHERE rank=0"
	).run(rank, "spike-added-line");
	db.prepare(
		"INSERT INTO line_culture SELECT ?,culture,state,translation FROM line_culture WHERE line=0"
	).run(rank);
	db.exec("COMMIT");
	changes.push({ operation: "normalized-line-insert", ms: performance.now() - at });
	equal(db.prepare("SELECT count(*) AS n FROM line WHERE rank=?").all(rank)[0]!.n, 1);
	at = performance.now();
	db.exec("BEGIN IMMEDIATE");
	db.prepare("DELETE FROM line WHERE rank=?").run(rank);
	db.exec("COMMIT");
	changes.push({ operation: "normalized-line-delete", ms: performance.now() - at });
	equal(db.prepare("SELECT count(*) AS n FROM line_culture WHERE line=?").all(rank)[0]!.n, 0);
	// Reader-generation proof uses WAL on this disposable copy only, not the measured source DB.
	db.exec("PRAGMA journal_mode=WAL");
	const reader = await openSqlite(file, "node");
	try {
		reader.exec("BEGIN");
		const pinned = read(reader);
		db.exec("BEGIN IMMEDIATE; UPDATE line SET audience='editor' WHERE rank=0; COMMIT");
		deepStrictEqual(read(reader), pinned);
		reader.exec("ROLLBACK");
		equal(read(reader)[0]!.audience, "editor");
	} finally {
		reader.close();
	}
	// Commit a known value, then kill a separate writer after it acknowledges an uncommitted edit.
	db.exec("UPDATE line SET audience='unknown' WHERE rank=0");
	const child = spawn(
		process.execPath,
		["--import", "tsx", fileURLToPath(new URL("./crash.ts", import.meta.url)), file],
		{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
	);
	const exited = once(child, "close");
	const watchdog = setTimeout(() => child.kill(), 10000);
	try {
		await Promise.race([
			once(child.stdout, "data"),
			exited.then(() => {
				throw new Error("Crash-test writer exited before staging.");
			})
		]);
		child.kill();
		await exited;
	} finally {
		clearTimeout(watchdog);
		child.kill();
	}
	equal(read(db)[0]!.audience, "unknown");
	equal(db.prepare("PRAGMA integrity_check").all()[0]!.integrity_check, "ok");
	await writeFile(
		resolve(output, "results.json"),
		JSON.stringify(
			{
				changes,
				rollback: "passed",
				oldReader: "passed",
				killedUncommittedWriter: "passed",
				integrity: "ok",
				initialId: before[0]!.id,
				scope: "normalized SQLite facts; no native incremental join or power-loss equivalence claim"
			},
			null,
			2
		)
	);
} finally {
	db.close();
}
