import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, sep } from "node:path";
import { openDatabase } from "./database.ts";
import { Records } from "./records.ts";
import { json } from "./model.ts";
import { canonical } from "./canonical.ts";
import { canonicalLocalizationJson } from "../../../../packages/game-text/src/localization-fingerprint.ts";

test("relational records retain UTF-16, arbitrary metadata, missing fields and list order", async () => {
	const db = await openDatabase(":memory:", true);
	try {
		const writer = new Records(db, true);
		const scalars = [
			"",
			"\0",
			"\ud800",
			"\udfff",
			"😀",
			"\u{f0000}\u{f0001}\u{f0800}",
			"漢字",
			"ภาษาไทย",
			"İßΣςσ",
			"a'b\"c\\d\n"
		];
		const evidence = json({
			null: null,
			empty: "",
			nested: [[], {}, [false, true, 0, -7, 1.25, null]],
			metadata: Object.fromEntries([
				["__proto__", { retained: true }],
				["\ud800", scalars]
			]),
			flags: ["z", "a", "z"],
			scalarKeys: Object.fromEntries(scalars.map((value, index) => [value, { index, value }]))
		});
		const root = writer.put(evidence);
		assert.equal(canonical(evidence), canonicalLocalizationJson(evidence));
		assert.deepEqual(new Records(db).read([root, root]), [evidence, evidence]);
		assert.deepEqual(new Records(db).project([root], ["null", "metadata", "missing"]), [
			{
				null: null,
				metadata: Object.fromEntries([
					["__proto__", { retained: true }],
					["\ud800", scalars]
				])
			}
		]);
		const strings = db
			.prepare(
				"SELECT length(text)/2 AS units,count(*) AS count FROM value_node WHERE kind=1 GROUP BY units ORDER BY units"
			)
			.all();
		assert(strings.length > 2);
		assert.equal(db.prepare("PRAGMA integrity_check").all()[0]!.integrity_check, "ok");
	} finally {
		db.close();
	}
});

test("broken references fail instead of dropping evidence", async () => {
	const db = await openDatabase(":memory:", true);
	try {
		const writer = new Records(db, true);
		const root = writer.put(["retained", "evidence"]);
		db.exec("UPDATE array_item SET value=999999 WHERE position=1");
		assert.throws(() => new Records(db).read([root]), /Missing retained value node/u);
	} finally {
		db.close();
	}
});

test("complete record replacement is atomic, old readers stay pinned, rollback includes layouts", async () => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-sqlite-records-"));
	const path = join(root, "cache.sqlite");
	const writer = await openDatabase(path, true);
	let reader: Awaited<ReturnType<typeof openDatabase>> | undefined;
	try {
		writer.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
		const original = { source: "Before", evidence: [{ translation: "", po: null }] };
		const old = new Records(writer, true).put(original);
		writer.exec(
			`CREATE TABLE generation(root INTEGER); INSERT INTO generation VALUES (${old})`
		);
		reader = await openDatabase(path);
		reader.exec("BEGIN");
		const pinnedRoot = Number(reader.prepare("SELECT root FROM generation").all()[0]!.root);
		assert.deepEqual(new Records(reader).read([pinnedRoot])[0], original);
		writer.exec("BEGIN IMMEDIATE");
		const replacement = {
			source: "After",
			evidence: [{ translation: "New", po: { flags: ["reviewed"] } }],
			added: { metadata: "retained" }
		};
		const next = new Records(writer, true).put(replacement);
		writer.prepare("UPDATE generation SET root=?").run(next);
		writer.exec("COMMIT");
		assert.equal(Number(reader.prepare("SELECT root FROM generation").all()[0]!.root), old);
		assert.deepEqual(new Records(reader).read([old])[0], original);
		reader.exec("COMMIT");
		assert.deepEqual(new Records(reader).read([next])[0], replacement);
		writer.exec("BEGIN IMMEDIATE");
		const rolledBack = new Records(writer, true).put({
			differentLayout: ["uncommitted", { extra: 7 }]
		});
		writer.prepare("UPDATE generation SET root=?").run(rolledBack);
		writer.exec("ROLLBACK");
		assert.equal(Number(reader.prepare("SELECT root FROM generation").all()[0]!.root), next);
		assert.deepEqual(new Records(reader).read([next])[0], replacement);
		assert.equal(writer.prepare("PRAGMA integrity_check").all()[0]!.integrity_check, "ok");
	} finally {
		reader?.close();
		writer.close();
		assert(resolve(root).startsWith(resolve(tmpdir()) + sep));
		await rm(root, { recursive: true, force: true });
	}
});
