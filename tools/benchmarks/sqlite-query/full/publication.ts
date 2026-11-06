import type { Database } from "./database.ts";
import { q } from "./store.ts";

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
/** Stage a complete generation in one transaction; the caller commits or rolls it back. */
export function stageGeneration(db: Database, incoming: string): void {
	db.exec(`ATTACH DATABASE ${q(incoming)} AS incoming`);
	db.exec("BEGIN IMMEDIATE");
	try {
		for (const view of db
			.prepare("SELECT name FROM main.sqlite_master WHERE type='view'")
			.all())
			db.exec(`DROP VIEW main.${identifier(String(view.name))}`);
		const previous = db
			.prepare(
				"SELECT name,sql FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
			)
			.all();
		const next = db
			.prepare(
				"SELECT name,sql FROM incoming.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
			)
			.all();
		const virtual = (sql: string) => /^CREATE VIRTUAL TABLE/iu.test(sql);
		const previousVirtual = previous.filter((table) => virtual(String(table.sql)));
		const nextVirtual = next.filter((table) => virtual(String(table.sql)));
		const shadow = (name: string, owners: typeof nextVirtual) =>
			owners.some((owner) => name.startsWith(String(owner.name) + "_"));
		for (const table of previousVirtual)
			db.exec(`DROP TABLE main.${identifier(String(table.name))}`);
		for (const table of previous.filter(
			(table) => !virtual(String(table.sql)) && !shadow(String(table.name), previousVirtual)
		))
			db.exec(`DROP TABLE main.${identifier(String(table.name))}`);
		for (const table of next.filter(
			(table) => !virtual(String(table.sql)) && !shadow(String(table.name), nextVirtual)
		)) {
			db.exec(String(table.sql));
			db.exec(
				`INSERT INTO main.${identifier(String(table.name))} SELECT * FROM incoming.${identifier(String(table.name))}`
			);
		}
		for (const table of nextVirtual) {
			if (!String(table.sql).includes("fts5"))
				throw new Error("Unexpected virtual table in the pilot generation");
			db.exec(String(table.sql));
			db.exec(
				`INSERT INTO ${identifier(String(table.name))}(${identifier(String(table.name))}) VALUES ('rebuild')`
			);
		}
		for (const index of db
			.prepare(
				"SELECT sql FROM incoming.sqlite_master WHERE type='index' AND sql IS NOT NULL"
			)
			.all())
			db.exec(String(index.sql));
		for (const view of db
			.prepare("SELECT sql FROM incoming.sqlite_master WHERE type='view'")
			.all())
			db.exec(String(view.sql));
	} catch (cause) {
		db.exec("ROLLBACK; DETACH DATABASE incoming");
		throw cause;
	}
}
