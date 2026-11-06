/** Test aggregating indexed IDs before hydrating labels, over an identical copied database. */
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSqlite } from "./driver.ts";
import type { Case } from "./sqlite.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("tune-counts.ts INPUT_DIRECTORY NEW_DIRECTORY");
const source = resolve(input),
	destination = resolve(output);
await mkdir(destination, { recursive: false });
for (const file of ["facts.sqlite", "facts.json", "input.json", "build.json"])
	await copyFile(resolve(source, file), resolve(destination, file));
const original: Case[] = JSON.parse(await readFile(resolve(source, "cases.json"), "utf8"));
const workload = original
	.filter((entry) => entry.name === "namespace-counts" || entry.name === "culture-state-counts")
	.map((entry) => ({
		...entry,
		sql:
			entry.name === "namespace-counts"
				? "SELECT coalesce(n.value,'') AS key,sum(c.n) AS n FROM (SELECT namespace,count(*) AS n FROM line GROUP BY namespace) c LEFT JOIN string n ON n.id=c.namespace GROUP BY coalesce(n.value,'') ORDER BY n.utf16"
				: "SELECT t.name AS culture,c.state AS state,c.n AS n FROM (SELECT culture,state,count(*) AS n FROM line_culture GROUP BY culture,state) c JOIN culture t ON t.id=c.culture ORDER BY culture,state"
	}));
await writeFile(resolve(destination, "cases.json"), JSON.stringify(workload));
const db = await openSqlite(resolve(destination, "facts.sqlite"), "node");
try {
	const plans = Object.fromEntries(
		workload.map((entry) => [
			entry.name,
			db.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...entry.parameters)
		])
	);
	await writeFile(
		resolve(destination, "tuning.json"),
		JSON.stringify({ workload, plans }, null, 2)
	);
} finally {
	db.close();
}
