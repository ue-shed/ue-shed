/** Every retained native object is checked, with bounded host memory, outside query timings. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { openDatabase } from "./database.ts";
import { Records } from "./records.ts";
import { ndjson } from "./store.ts";
import { canonical } from "./canonical.ts";
import { json } from "./model.ts";

const root = resolve(process.argv[2]!);
const db = await openDatabase(resolve(root, "complete.sqlite"));
const records = new Records(db);
const results = [];
let verifiedLineDigest: string | undefined;
try {
	for (const kind of ["units", "lines", "raw-lines"]) {
		if (kind === "raw-lines" && verifiedLineDigest) {
			const count = Number(db.prepare("SELECT count(*) AS n FROM raw_line").all()[0]!.n);
			const lineCount = Number(
				db.prepare("SELECT count(*) AS n FROM row_data WHERE kind='line'").all()[0]!.n
			);
			const mismatches = Number(
				db
					.prepare(
						"SELECT count(*) AS n FROM raw_line raw LEFT JOIN row_data r ON r.kind='line' AND r.key=raw.key WHERE r.id IS NULL OR raw.value<>r.raw OR raw.rank<>r.rank"
					)
					.all()[0]!.n
			);
			if (count === lineCount && mismatches === 0) {
				const rawHash = createHash("sha256");
				let actual = 0;
				for await (const value of ndjson(resolve(root, "raw-lines.ndjson"))) {
					rawHash.update(canonical(json(value))).update("\n");
					actual++;
				}
				const expectedSha256 = rawHash.digest("hex");
				assert.equal(actual, count);
				assert.equal(verifiedLineDigest, expectedSha256);
				results.push({
					kind,
					records: count,
					expectedSha256,
					actualSha256: verifiedLineDigest,
					proof: "Every raw reference and rank equals a previously decoded and verified full line; independent raw stream hash matches"
				});
				continue;
			}
		}
		let rank = 0;
		let pending: unknown[] = [];
		const expected = createHash("sha256"),
			actual = createHash("sha256");
		const bareLines = createHash("sha256");
		const check = () => {
			if (!pending.length) return;
			const rows =
				kind === "raw-lines"
					? db
							.prepare(
								"SELECT value AS raw FROM raw_line WHERE rank>=? AND rank<? ORDER BY rank"
							)
							.all(rank, rank + pending.length)
					: db
							.prepare(
								"SELECT r.raw,r.preview,r.view,p.unit AS unit_preview FROM row_data r LEFT JOIN line_preview p ON p.owner=r.id WHERE kind=? AND rank>=? AND rank<? ORDER BY rank"
							)
							.all(kind === "units" ? "unit" : "line", rank, rank + pending.length);
			assert.equal(rows.length, pending.length);
			const refs = rows.flatMap((row) =>
				[row.raw, row.preview, row.view, row.unit_preview]
					.filter((value) => value != null)
					.map(Number)
			);
			const values = new Map(refs.map((ref, i) => [ref, i]));
			const decoded = records.read(refs);
			const get = (ref: number) => decoded[values.get(ref)!]!;
			for (const [i, row] of rows.entries()) {
				const value =
					kind === "raw-lines"
						? get(Number(row.raw))
						: kind === "units"
							? {
									unit: get(Number(row.raw)),
									preview: row.preview == null ? null : get(Number(row.preview))
								}
							: {
									line: get(Number(row.raw)),
									view: get(Number(row.view)),
									preview: get(Number(row.preview)),
									...(row.unit_preview != null && {
										unitPreview: get(Number(row.unit_preview))
									})
								};
				const a = canonical(json(pending[i])),
					b = canonical(json(value));
				assert.equal(b, a, `${kind} record ${rank + i} differs`);
				expected.update(a).update("\n");
				actual.update(b).update("\n");
				if (kind === "lines")
					bareLines.update(canonical(get(Number(row.raw)))).update("\n");
			}
			rank += pending.length;
			pending = [];
			if (rank % 25000 === 0)
				console.log(JSON.stringify({ phase: `verify-${kind}`, count: rank }));
		};
		for await (const value of ndjson(resolve(root, `${kind}.ndjson`))) {
			pending.push(value);
			if (pending.length === 1000) check();
		}
		check();
		if (kind === "lines") verifiedLineDigest = bareLines.digest("hex");
		results.push({
			kind,
			records: rank,
			expectedSha256: expected.digest("hex"),
			actualSha256: actual.digest("hex")
		});
	}
	assert.equal(db.prepare("PRAGMA integrity_check").all()[0]!.integrity_check, "ok");
} finally {
	db.close();
}
await writeFile(
	resolve(root, "record-parity.json"),
	JSON.stringify({ results, passed: true, integrity: "ok" })
);
console.log(JSON.stringify({ passed: true, results }));
