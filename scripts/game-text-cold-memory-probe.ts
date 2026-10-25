/**
 * Runs one cold Game Text refresh in-process and samples the whole process tree's
 * working set every 250 ms, classified by role (Node main, native one-shot reader,
 * native session). Phase changes from the index progress reporter are timestamped
 * on the same clock so the peak can be attributed to a stage and a process.
 * Process command lines are classified in the sampler and never recorded.
 *
 * node --import tsx scripts/game-text-cold-memory-probe.ts --project <dir> --cache <new dir> --out <json>
 */
import { execFile } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { Context, Effect, Layer, Scope } from "effect";
import * as currentIndex from "../packages/game-text/dist/entry-index.js";
import * as currentAssets from "../packages/unreal-assets/dist/index.js";
import * as currentLocalization from "../packages/localization/dist/index.js";
import { withEngineBenchmarkLock } from "./game-text-engine-lock.ts";
import { makeStageRecorder } from "./game-text-stage-timings.ts";

const { values } = parseArgs({
	options: {
		project: { type: "string" },
		cache: { type: "string" },
		out: { type: "string" },
		records: { type: "string" }
	}
});
if (!values.project || !values.cache || !values.out)
	throw new Error("Provide --project, --cache and --out.");
const project = values.project;
const cache = values.cache;
const out = values.out;

const run = promisify(execFile);
const startedAt = performance.now();
const now = () => Math.round(performance.now() - startedAt);
let phase = "starting";
const phases: { t: number; phase: string }[] = [{ t: 0, phase }];
const samples: {
	t: number;
	phase: string;
	totalBytes: number;
	roles: Record<string, number>;
	counts: Record<string, number>;
}[] = [];
let sampling = false;

async function sampleTree() {
	if (sampling) return;
	sampling = true;
	try {
		const script =
			"$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | ForEach-Object { " +
			"$role = if ($_.Name -like 'node*') { 'native-none' } " +
			"elseif ($_.CommandLine -like '*protocol-session*') { 'native-session' } " +
			"elseif ($_.CommandLine -like '*protocol*') { 'native-oneshot' } else { 'other' }; " +
			"[pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=$_.Name; role=$role; ws=[long]$_.WorkingSetSize } } | ConvertTo-Json -Compress";
		const { stdout } = await run(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 }
		);
		// SAFETY: the sampler above builds these exact fields with ConvertTo-Json.
		const rows = JSON.parse(stdout) as {
			pid: number;
			ppid: number;
			name: string;
			role: string;
			ws: number;
		}[];
		const list = Array.isArray(rows) ? rows : [rows];
		const owned = new Set([process.pid]);
		let added = true;
		while (added) {
			added = false;
			for (const row of list)
				if (owned.has(row.ppid) && !owned.has(row.pid)) {
					owned.add(row.pid);
					added = true;
				}
		}
		const roles: Record<string, number> = {};
		const counts: Record<string, number> = {};
		let totalBytes = 0;
		for (const row of list) {
			if (!owned.has(row.pid)) continue;
			const role =
				row.pid === process.pid
					? "node-main"
					: row.name.startsWith("node")
						? "node-child"
						: row.role;
			roles[role] = (roles[role] ?? 0) + row.ws;
			counts[role] = (counts[role] ?? 0) + 1;
			totalBytes += row.ws;
		}
		samples.push({ t: now(), phase, totalBytes, roles, counts });
	} catch {
		// A missed sample is a gap, not a zero.
	} finally {
		sampling = false;
	}
}

const { GameTextIndexBuilderLive, gameTextIndexRefreshLayer, gameTextIndexSourceNodeLayer } =
	currentIndex;
const { AssetReaderLive } = currentAssets;
const { LocalizationEvidence, LocalizationEvidenceNodeLive } = currentLocalization;
const { GameTextIndexRefresh } = await import("../packages/game-text/dist/index-refresh.js");
const { GameTextIndexProgressReporter } = currentIndex;
const { retainedPackageSource } = await import("./game-text-scale-quality.ts");

await withEngineBenchmarkLock(async () => {
	const recorder = makeStageRecorder();
	const traced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.withTracer(effect, recorder.tracer);
	const scope = await Effect.runPromise(Scope.make());
	const timer = setInterval(() => void sampleTree(), 250);
	try {
		const source = values.records
			? retainedPackageSource(values.records)
			: gameTextIndexSourceNodeLayer(cache).pipe(Layer.provide(AssetReaderLive));
		const layer = gameTextIndexRefreshLayer(cache).pipe(
			Layer.provide(source),
			Layer.provide(GameTextIndexBuilderLive.pipe(Layer.provide(AssetReaderLive))),
			Layer.provide(LocalizationEvidenceNodeLive)
		);
		const context = await Effect.runPromise(traced(Layer.buildWithScope(layer, scope)));
		const discovery = await Effect.runPromise(
			traced(
				Effect.flatMap(LocalizationEvidence, (reader) =>
					reader.discover({ projectRoot: project })
				).pipe(Effect.provide(LocalizationEvidenceNodeLive))
			)
		);
		const targetName = discovery.targets[0]?.name;
		if (!targetName) throw new Error("The project has no localization target.");
		const refresh = Context.get(context, GameTextIndexRefresh);
		const report = (value: { phase: string }) => {
			if (value.phase !== phase) {
				phase = value.phase;
				phases.push({ t: now(), phase });
			}
		};
		await sampleTree();
		const result = await Effect.runPromise(
			traced(
				Effect.scoped(
					refresh
						.refresh({ projectRoot: project, targetName })
						.pipe(Effect.provideService(GameTextIndexProgressReporter, report))
				).pipe(Effect.provide(context))
			)
		);
		phase = "done";
		phases.push({ t: now(), phase });
		await sampleTree();
		const peak = samples.reduce(
			(best, s) => (s.totalBytes > best.totalBytes ? s : best),
			samples[0]!
		);
		const peakByRole: Record<string, number> = {};
		for (const s of samples)
			for (const [role, bytes] of Object.entries(s.roles))
				peakByRole[role] = Math.max(peakByRole[role] ?? 0, bytes);
		await mkdir(dirname(out), { recursive: true });
		await writeFile(
			out,
			JSON.stringify(
				{
					projectLabel: values.records ? "generated" : "released",
					targetName,
					refreshStatus: result ? "ready" : "missing",
					phases,
					peak: {
						t: peak.t,
						phase: peak.phase,
						totalBytes: peak.totalBytes,
						roles: peak.roles,
						counts: peak.counts
					},
					peakByRole,
					stages: recorder.counts(),
					samples
				},
				null,
				"\t"
			) + "\n"
		);
		process.stdout.write(
			`peak ${Math.round(peak.totalBytes / 2 ** 20)} MiB at ${peak.t} ms (${peak.phase})\n`
		);
	} finally {
		clearInterval(timer);
	}
});
