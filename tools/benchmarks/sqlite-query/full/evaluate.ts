import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { checksum } from "./canonical.ts";
import { openDatabase } from "./database.ts";
import { SqliteQuery } from "./query.ts";
import { json, type Json } from "./model.ts";
import type { Case } from "./workload.ts";

export const digest = checksum;
export function evaluate(
	query: SqliteQuery,
	entry: Case,
	progress?: (count: number) => void
): Json {
	switch (entry.operation) {
		case "rows":
			return json(query.rows(entry.request));
		case "search":
			return json(query.search(entry.request));
		case "select":
			return query.select(entry.request, entry.fields ?? []);
		case "export":
			return query.export(entry.request);
		case "corpus":
			return query.readCorpus();
		case "fingerprint":
			return query.corpusFingerprint(progress);
		case "lines":
			return query.readLines();
		case "line":
			return query.line(entry.id) ?? null;
		case "detail":
			return query.detail(entry.request) ?? null;
		case "aggregate":
			return query.aggregate(entry.request);
	}
}
const [rootPath, outputPath] = process.argv.slice(2);
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/full/evaluate.ts")) {
	if (!rootPath || !outputPath) throw new Error("evaluate.ts BUNDLE OUTPUT");
	const root = resolve(rootPath);
	const expected: { workload: Case[]; hashes: string[] } = JSON.parse(
		await readFile(resolve(root, "expected.json"), "utf8")
	);
	const db = await openDatabase(resolve(root, "complete.sqlite"));
	const query = new SqliteQuery(db);
	const samples = [];
	try {
		for (const [index, entry] of expected.workload.entries()) {
			console.log(JSON.stringify({ starting: index + 1, name: entry.name }));
			try {
				const at = performance.now();
				const answer = evaluate(query, entry, (records) =>
					console.log(JSON.stringify({ phase: "fingerprint", records }))
				);
				const ms = performance.now() - at;
				const sha256 = digest(answer);
				const matches = sha256 === expected.hashes[index];
				if (!matches)
					await writeFile(resolve(root, `actual-${index}.json`), JSON.stringify(answer));
				samples.push({ name: entry.name, ms, sha256, matches });
			} catch (cause) {
				samples.push({ name: entry.name, error: String(cause), matches: false });
			}
			console.log(JSON.stringify({ complete: index + 1, ...samples.at(-1) }));
		}
	} finally {
		db.close();
	}
	await writeFile(
		outputPath,
		JSON.stringify({ samples, passed: samples.every((sample) => sample.matches) }, null, 2)
	);
	console.log(
		JSON.stringify({
			total: samples.length,
			failed: samples.filter((s) => !s.matches).map((sample) => sample.name)
		})
	);
	if (samples.some((sample) => !sample.matches)) process.exitCode = 1;
}
