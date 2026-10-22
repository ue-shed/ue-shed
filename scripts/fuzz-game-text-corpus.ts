import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { installedEngineRoots, queryWindowsRegistry } from "../packages/engine/dist/index.js";
import { compareGameTextCorpus } from "./compare-game-text-corpus.ts";
import { decodeCorpusPlan } from "./game-text-corpus-plan.ts";
import { corpusPlanName } from "./game-text-corpus-contract.ts";
import { diffCorpus, findingCounts } from "./game-text-corpus-contract.ts";
import { unrealEngineVersion } from "./unreal-plugin-host.ts";

const { values } = parseArgs({
	options: {
		scratch: { type: "string" },
		seed: { type: "string" },
		lines: { type: "string", default: "10000" },
		density: { type: "string" },
		"engine-root": { type: "string" }
	}
});
const seed = values.seed === undefined ? randomInt(2_147_483_647) : Number(values.seed);
if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) throw new Error("Invalid seed.");
const installed = await Effect.runPromise(
	installedEngineRoots({
		platform: process.platform,
		programData: process.env.ProgramData ?? "",
		programFiles: process.env.ProgramFiles ?? "",
		queryRegistry: queryWindowsRegistry
	})
);
const engine =
	values["engine-root"] ?? installed.find((root) => unrealEngineVersion(root)?.label === "5.8");
if (!engine || unrealEngineVersion(engine)?.major !== 5)
	throw new Error("Choose an installed UE5 engine with --engine-root.");
const scratch = resolve(
	values.scratch ?? join(tmpdir(), "ue-shed-corpus-fuzz"),
	`${seed}-${Date.now()}`
);
await mkdir(scratch, { recursive: true });
const project = join(scratch, "Corpus.uproject");
const root = "/Game/Fixture/Corpus";
const runner = fileURLToPath(new URL("generate-game-text-corpus.ts", import.meta.url));
const generated = spawnSync(
	process.execPath,
	[
		runner,
		"--project",
		project,
		"--engine-root",
		engine,
		"--seed",
		String(seed),
		"--lines",
		values.lines!,
		...(values.density ? ["--density", values.density] : []),
		"--root",
		root
	],
	{ stdio: "inherit", windowsHide: true }
);
if (generated.error) throw generated.error;
if (generated.status !== 0)
	throw new Error(`Corpus generation failed (${generated.status}). Scratch: ${scratch}`);
const corpus = join(dirname(project), "Content", "Fixture", "Corpus");
const cacheRoot = join(scratch, "IndexCache");
const result = await compareGameTextCorpus(corpus, undefined, { cacheRoot });
await writeFile(join(scratch, "comparison.json"), JSON.stringify(result.triage, null, "\t"));
process.stdout.write(
	`Initial scan: ${result.triage.unexpected.length} unexpected/${result.triage.stale.length} stale.\n`
);
const patched = spawnSync(
	process.execPath,
	[
		runner,
		"--project",
		project,
		"--engine-root",
		engine,
		"--seed",
		String(seed),
		"--lines",
		values.lines!,
		...(values.density ? ["--density", values.density] : []),
		"--root",
		root,
		"--patch"
	],
	{ stdio: "inherit", windowsHide: true }
);
if (patched.error) throw patched.error;
if (patched.status !== 0) throw new Error(`Incremental patch failed (${patched.status}).`);
const incremental = await compareGameTextCorpus(corpus, undefined, {
	cacheRoot,
	changedFiles: decodeCorpusPlan(await readFile(join(corpus, corpusPlanName), "utf8")).edits
		.changedFiles
});
process.stdout.write(
	`Edited incremental scan: ${incremental.triage.unexpected.length} unexpected/${incremental.triage.stale.length} stale.\n`
);
const full = await compareGameTextCorpus(corpus);
const refreshDifferences = diffCorpus(
	{ ...full.expected, subjects: full.actual, counts: findingCounts(full.actual) },
	incremental.actual
);
await writeFile(
	join(scratch, "refresh-differences.json"),
	JSON.stringify(refreshDifferences, null, "\t")
);
await writeFile(
	join(scratch, "incremental-comparison.json"),
	JSON.stringify(incremental.triage, null, "\t")
);
await writeFile(
	join(scratch, "full-after-comparison.json"),
	JSON.stringify(full.triage, null, "\t")
);
process.stdout.write(
	`Seed ${seed}; ${result.expected.lines} lines; ${result.actual.length} subjects; ` +
		`${result.triage.unexpected.length} unexpected disagreements; ${result.triage.stale.length} stale defects.\n`
);
process.stdout.write(
	`Failing cases: ${[...new Set([...refreshDifferences.map((item) => item.case), ...[result, incremental, full].flatMap((phase) => [...phase.triage.unexpected, ...phase.triage.stale].map((item) => item.case))])].join(", ")}\nScratch: ${scratch}\n`
);
process.stdout.write(
	`After package edit: incremental ${incremental.triage.unexpected.length} unexpected/${incremental.triage.stale.length} stale; ` +
		`full ${full.triage.unexpected.length} unexpected/${full.triage.stale.length} stale.\n`
);
process.stdout.write(`Full versus incremental: ${refreshDifferences.length} differences.\n`);
process.exitCode =
	refreshDifferences.length ||
	[result, incremental, full].some(
		(item) => item.triage.unexpected.length || item.triage.stale.length
	)
		? 1
		: 0;
