import type { Database, SqlRow } from "./sqlite.ts";

/** The driver boundary only: the workload and schema remain identical across JavaScript runtimes. */
export async function openSqlite(
	path: string,
	runtime: "node" | "bun",
	write = false
): Promise<Database> {
	if (runtime === "bun") {
		const specifier = "bun:sqlite";
		const module = await import(specifier);
		return new module.Database(path, { create: write, readonly: !write });
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(path, { readOnly: !write });
	return {
		exec: (sql) => db.exec(sql),
		close: () => db.close(),
		prepare: (sql) => {
			const statement = db.prepare(sql);
			return {
				// SAFETY: workload SQL selects TEXT, NULL and safe-size counts/IDs, never BLOB or bigint.
				// Verified by: sqlite.test.ts compares every workload result against its independent oracle.
				all: (...parameters) => statement.all(...parameters) as SqlRow[],
				run: (...parameters) => {
					statement.run(...parameters);
				}
			};
		}
	};
}
