/** Bun-only adapter; the historical Node and SQLite process lanes are not part of this pilot. */
export type Parameter = string | number | null | Uint8Array;
export type Row = Record<string, string | number | null | Uint8Array>;
export interface Statement {
	all(...parameters: Parameter[]): Row[];
	run(...parameters: Parameter[]): void;
}
export interface Database {
	exec(sql: string): void;
	prepare(sql: string): Statement;
	close(): void;
}
export async function openDatabase(path: string, write = false): Promise<Database> {
	const moduleName = "bun:sqlite";
	const { Database } = await import(moduleName);
	const db = new Database(path, { create: write, readonly: !write, strict: true });
	db.exec("PRAGMA cache_size=-131072; PRAGMA foreign_keys=ON");
	interface Prepared extends Statement {
		finalize(): void;
	}
	const prepared = new Map<string, Prepared>();
	const statement = (sql: string): Prepared => {
		const previous = prepared.get(sql);
		if (previous) {
			prepared.delete(sql);
			prepared.set(sql, previous);
			return previous;
		}
		if (prepared.size >= 256) {
			const oldest = prepared.keys().next().value!;
			prepared.get(oldest)!.finalize();
			prepared.delete(oldest);
		}
		const next: Prepared = db.prepare(sql);
		prepared.set(sql, next);
		return next;
	};
	return {
		exec: (sql) => db.exec(sql),
		prepare: (sql) => ({
			all: (...parameters) => statement(sql).all(...parameters),
			run: (...parameters) => {
				statement(sql).run(...parameters);
			}
		}),
		close: () => {
			for (const value of prepared.values()) value.finalize();
			prepared.clear();
			db.close();
		}
	};
}
