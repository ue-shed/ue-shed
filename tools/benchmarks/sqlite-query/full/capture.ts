/** Portable evidence: checked answers, samples, resource measurements and exact source hashes. */
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { createHash } from "node:crypto";
import { openDatabase } from "./database.ts";
import { SqliteQuery } from "./query.ts";
import { fileHash } from "./seal.ts";
import { checksum } from "./canonical.ts";
import { json } from "./model.ts";

const [bundlePath, campaignPath, reportPath, gateLogPath, lifecyclePath, ...controls] =
	process.argv.slice(2);
if (!bundlePath || !campaignPath || !reportPath || !gateLogPath || !lifecyclePath)
	throw new Error("capture.ts BUNDLE CAMPAIGN REPORT GATE_LOG LIFECYCLE [CONTROL_BUNDLES...]");
const root = resolve(bundlePath),
	campaign = resolve(campaignPath),
	report = resolve(reportPath),
	gate = resolve(gateLogPath);
const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const parity = await read(resolve(root, "parity.json")),
	records = await read(resolve(root, "record-parity.json"));
if (!parity.passed || !records.passed) throw new Error("Full-size conformance has not passed");
const measurements = await read(resolve(campaign, "results.json"));
if (measurements.results.length !== 6) throw new Error("Missing independent timing runs");
const original = await read(resolve(root, "expected.json"));
const expectedHashes = new Map(
	original.workload.map((entry: { name: string }, index: number) => [
		entry.name,
		original.hashes[index]
	])
);
for (const run of measurements.results)
	for (const sample of [...run.samples, ...run.warmups])
		if (sample.sha256 !== expectedHashes.get(sample.name))
			throw new Error("Timing result differs from native expected answer");
const controlResults = [];
for (const path of controls) {
	const value = await read(resolve(path, "parity.json"));
	if (!value.passed) throw new Error(`Control conformance failed: ${path}`);
	controlResults.push({
		bundle: relative(process.cwd(), resolve(path)).replaceAll("\\", "/"),
		cases: value.samples.length,
		passed: true,
		workload: (await read(resolve(path, "expected.json"))).workload,
		samples: value.samples
	});
}
const sources: Record<string, string> = {};
for (const directory of [
	"tools/benchmarks/sqlite-query",
	"crates/game-text-index/src",
	"packages/game-text/src"
])
	for (const file of await readdir(directory, { recursive: true })) {
		if (!/\.(?:ts|rs|py|toml|lock|patch)$/u.test(file)) continue;
		const path = resolve(directory, file);
		if (!(await stat(path)).isFile()) continue;
		sources[relative(process.cwd(), path).replaceAll("\\", "/")] = await fileHash(path);
	}
const gateText = await readFile(gate, "utf8");
const gateExitCode = Number((await readFile(gate.replace(/\.log$/u, "-exit.txt"), "utf8")).trim());
if (gateExitCode !== 0) throw new Error("Full repository gate did not pass");
const lifecycle = await read(resolve(lifecyclePath, "results.json"));
if (
	!lifecycle.completeGenerationCommit ||
	!lifecycle.oldReaderPinned ||
	!lifecycle.rollbackIncludingRecordLayouts ||
	!lifecycle.killedUncommittedWriter ||
	lifecycle.uncommittedWalBytes <= 32 ||
	lifecycle.integrity !== "ok"
)
	throw new Error("Complete-generation lifecycle checks did not pass");
const python = await read(resolve(root, "python.json"));
const db = await openDatabase(resolve(root, "complete.sqlite"));
const query = new SqliteQuery(db);
const plans = [];
let store;
try {
	for (const entry of original.workload.filter(
		(entry: { operation: string; name: string }) =>
			entry.operation === "rows" && /first50|selective-text|same-place/u.test(entry.name)
	)) {
		const sql = `${query.matched(entry.request)} ORDER BY rank LIMIT 50`;
		plans.push({
			name: entry.name,
			sqlSha256: createHash("sha256").update(sql).digest("hex"),
			steps: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
		});
	}
	const first = db
		.prepare("SELECT raw FROM row_data WHERE kind='line' ORDER BY rank LIMIT 1")
		.all()[0]!;
	const line = query.records.read([Number(first.raw)])[0]!;
	if (checksum(line) !== checksum(json(python.firstFullLine)))
		throw new Error("Python full evidence read differs");
	store = {
		bytes: (await stat(resolve(root, "complete.sqlite"))).size,
		sqlite: db.prepare("SELECT sqlite_version() AS version").all(),
		compileOptions: db.prepare("PRAGMA compile_options").all(),
		cacheSize: db.prepare("PRAGMA cache_size").all(),
		pageCount: db.prepare("PRAGMA page_count").all(),
		pageSize: db.prepare("PRAGMA page_size").all(),
		freePages: db.prepare("PRAGMA freelist_count").all(),
		rows: db
			.prepare(
				"SELECT kind,count(*) AS total,sum(visible) AS visible FROM row_data GROUP BY kind"
			)
			.all(),
		valueNodes: db.prepare("SELECT kind,count(*) AS count FROM value_node GROUP BY kind").all(),
		python: {
			...python,
			firstFullLine: { sha256: checksum(line), matchesNativeRetainedLine: true }
		},
		plans
	};
} finally {
	db.close();
}
const native = resolve("target/release/uasset.exe");
const readerSha256 = await fileHash(native);
const recordedBaselineReaderSha256 = await fileHash(
	resolve("test-results/sqlite-spike/bin/uasset-baseline.exe")
);
if (readerSha256 !== recordedBaselineReaderSha256)
	throw new Error("The measured reader differs from the recorded shipping baseline");
const fingerprintIndex = original.workload.findIndex(
	(entry: { operation: string }) => entry.operation === "fingerprint"
);
await writeFile(
	report,
	JSON.stringify(
		{
			date: new Date().toISOString(),
			branch: execFileSync("git", ["branch", "--show-current"], {
				encoding: "utf8",
				windowsHide: true
			}).trim(),
			measuredHead: execFileSync("git", ["rev-parse", "HEAD"], {
				encoding: "utf8",
				windowsHide: true
			}).trim(),
			scope: "Complete retained GameText corpus/evidence and the implemented read cases; common native preparation; Bun SQLite versus shipping Rust public host. No SQLite Node or SQLite process lane.",
			host: {
				platform: process.platform,
				arch: process.arch,
				cpu: cpus()[0]?.model,
				logicalCpus: cpus().length,
				memoryBytes: totalmem()
			},
			retention: await read(resolve(root, "retention.json")),
			seal: await read(resolve(root, "seal.json")),
			store,
			records,
			conformance: {
				passed: true,
				cases: parity.samples.length,
				workload: original.workload,
				samples: parity.samples,
				corpusFingerprint: await read(resolve(root, `expected-${fingerprintIndex}.json`))
			},
			controls: controlResults,
			measurements,
			verification: {
				lifecycle,
				gate: {
					command: "pnpm check",
					exitCode: gateExitCode,
					logSha256: await fileHash(gate),
					mainSuite: /Test Files\s+([^\r\n]+)/u.exec(gateText)?.[1],
					tests: /Tests\s+(\d+ passed[^\r\n]+)/u.exec(gateText)?.[1],
					responsiveness: gateText.slice(
						gateText.lastIndexOf("$ node scripts/test-game-text-responsiveness.ts")
					),
					configuredSkips: gateText
						.split(/\r?\n/u)
						.filter((line) => line.trimStart().startsWith("SKIP ")),
					ignoredOrSkippedTests: gateText
						.split(/\r?\n/u)
						.filter((line) => /\.\.\. ignored\b/u.test(line) || line.includes("↓"))
						.map((line) => line.replace(/(\.\.\. ignored).*/u, "$1"))
				}
			},
			provenance: {
				sourceSha256: sources,
				readerSha256,
				recordedBaselineReaderSha256,
				campaignFiles: await Promise.all(
					(await readdir(campaign))
						.filter((name) => name.endsWith(".json"))
						.map(async (name) => ({
							name,
							sha256: await fileHash(resolve(campaign, name))
						}))
				)
			}
		},
		null,
		2
	)
);
console.log(
	JSON.stringify({
		report,
		bytes: (await stat(report)).size,
		cases: parity.samples.length,
		observations: measurements.results.reduce(
			(count: number, run: { samples: readonly unknown[] }) => count + run.samples.length,
			0
		)
	})
);
