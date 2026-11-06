import { deepStrictEqual, equal, throws } from "node:assert";
import { test } from "node:test";
import { openSqlite } from "./driver.ts";
import { cases, lines, populate, textRows, sqlText, hostText } from "./sqlite.ts";
import { expected } from "./oracle.ts";
import { controlFacts as facts } from "./controls.ts";

test("every SQL workload equals independently planted Unicode, identity, state and grouping answers", async () => {
	const db = await openSqlite(":memory:", "node", true);
	try {
		populate(db, facts);
		for (const entry of cases(facts)) {
			const raw = db.prepare(entry.sql).all(...entry.parameters);
			deepStrictEqual(
				entry.output === "lines" ? lines(raw) : textRows(raw),
				expected(entry, facts),
				entry.name
			);
		}
		equal(db.prepare("PRAGMA integrity_check").all()[0]!.integrity_check, "ok");
	} finally {
		db.close();
	}
});

test("reversible SQLite text distinguishes lone surrogates, real reserved scalars and NUL", () => {
	for (const text of [
		"",
		"abc",
		"é",
		"中文",
		"🙂",
		"\ud800",
		"\udfff",
		"\udfff\ud800",
		"\u{f0000}",
		"\u{f0001}",
		"\0"
	])
		equal(hostText(sqlText(text)), text);
	throws(() => hostText("\u{f0000}"), /Truncated/u);
});

test("a transaction rolls back a source change and culture edit together", async () => {
	const db = await openSqlite(":memory:", "node", true);
	try {
		populate(db, facts);
		const before = db.prepare("SELECT * FROM text_lines ORDER BY rank").all();
		db.exec(
			"BEGIN IMMEDIATE; UPDATE line SET source=(SELECT id FROM string WHERE value='taluma') WHERE rank=0; UPDATE line_culture SET state='needs_update' WHERE line=0; ROLLBACK"
		);
		deepStrictEqual(db.prepare("SELECT * FROM text_lines ORDER BY rank").all(), before);
		equal(
			db.prepare("SELECT state FROM line_culture WHERE line=0").all()[0]!.state,
			"translated"
		);
	} finally {
		db.close();
	}
});
