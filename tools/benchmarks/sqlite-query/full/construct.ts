import { resolve } from "node:path";
import { build } from "./store.ts";
import { openDatabase } from "./database.ts";
import { refreshQueryFacts } from "./repair.ts";
import { finalizeQueryTables } from "./finalize.ts";

const root = resolve(process.argv[2]!);
await build(root);
const db = await openDatabase(resolve(root, "complete.sqlite"), true);
try {
	await refreshQueryFacts(db, root);
	finalizeQueryTables(db);
} finally {
	db.close();
}
