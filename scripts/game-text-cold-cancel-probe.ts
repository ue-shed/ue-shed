/**
 * Interrupts a cold Game Text refresh during one named progress phase and measures:
 * how long the interrupt takes to return, how long until every native child has
 * exited or gone idle, and whether an immediate second refresh on the same cache
 * succeeds. Each repetition uses a fresh cache so the interrupted stage is cold.
 *
 * node --import tsx scripts/game-text-cold-cancel-probe.ts --project <dir> \
 *   --cache-root <dir> --phase localization|packages|joining --reps 3 --out <json>
 */
import { execFile } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect";
import * as currentIndex from "../packages/game-text/dist/entry-index.js";
import * as currentAssets from "../packages/unreal-assets/dist/index.js";
import * as currentLocalization from "../packages/localization/dist/index.js";
import { withEngineBenchmarkLock } from "./game-text-engine-lock.ts";

const { values } = parseArgs({
	options: {
		project: { type: "string" },
		"cache-root": { type: "string" },
		phase: { type: "string", default: "packages" },
		reps: { type: "string", default: "3" },
		"delay-ms": { type: "string" },
		out: { type: "string" }
	}
});
if (!values.project || !values["cache-root"] || !values.out)
	throw new Error("Provide --project, --cache-root and --out.");
const project = values.project;
const targetPhase = values.phase!;
const reps = Number(values.reps);
const delayMs = values["delay-ms"]
	? Number(values["delay-ms"])
	: targetPhase === "joining"
		? 500
		: targetPhase === "packages"
			? 5000
			: 1000;
const run = promisify(execFile);

interface RepetitionResult {
	rep: number;
	phase: string;
	delayMs: number;
	interrupted: boolean;
	interruptMs: number;
	idleMs: number;
	secondRefreshOk: boolean;
	secondRefreshMs: number;
	interruptError?: string;
	secondError?: string;
}

const { GameTextIndexBuilderLive, gameTextIndexRefreshLayer, gameTextIndexSourceNodeLayer } =
	currentIndex;
const { AssetReaderLive } = currentAssets;
const { LocalizationEvidence, LocalizationEvidenceNodeLive } = currentLocalization;
const { GameTextIndexRefresh } = await import("../packages/game-text/dist/index-refresh.js");
const { GameTextIndexProgressReporter } = currentIndex;

async function nativeChildren(): Promise<{ count: number; cpuMs: number }> {
	const script =
		"$ErrorActionPreference='Stop'; $all = @(Get-CimInstance Win32_Process); " +
		`$owned = [System.Collections.Generic.HashSet[uint32]]::new(); [void]$owned.Add(${process.pid}); ` +
		"do { $added = $false; foreach ($item in $all) { if ($owned.Contains($item.ParentProcessId) -and $owned.Add($item.ProcessId)) { $added = $true } } } while ($added); " +
		"$count = 0; $cpu = 0.0; foreach ($item in $all) { if ($owned.Contains($item.ProcessId) -and $item.ProcessId -ne " +
		`${process.pid}) { $count++; $cpu += ([double]$item.KernelModeTime + [double]$item.UserModeTime) / 10000 } }; ` +
		"[pscustomobject]@{ count = $count; cpuMs = $cpu } | ConvertTo-Json -Compress";
	const { stdout } = await run(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", script],
		{ windowsHide: true, timeout: 10000 }
	);
	// SAFETY: the sampler above builds this exact shape with ConvertTo-Json.
	return JSON.parse(stdout) as { count: number; cpuMs: number };
}

async function buildContext(cache: string, scope: Scope.Scope) {
	const source = gameTextIndexSourceNodeLayer(cache).pipe(Layer.provide(AssetReaderLive));
	const layer = gameTextIndexRefreshLayer(cache).pipe(
		Layer.provide(source),
		Layer.provide(GameTextIndexBuilderLive.pipe(Layer.provide(AssetReaderLive))),
		Layer.provide(LocalizationEvidenceNodeLive)
	);
	return Effect.runPromise(Layer.buildWithScope(layer, scope));
}

async function repetition(rep: number, targetName: string) {
	const cache = join(values["cache-root"]!, `rep-${rep}`);
	await mkdir(cache, { recursive: true });
	const scope = await Effect.runPromise(Scope.make());
	try {
		const context = await buildContext(cache, scope);
		const refresh = Context.get(context, GameTextIndexRefresh);
		let triggered = false;
		let interruptMs = -1;
		let idleMs = -1;
		let interruptError: string | undefined;
		const running = Effect.scoped(refresh.refresh({ projectRoot: project, targetName })).pipe(
			Effect.provideService(GameTextIndexProgressReporter, (value: { phase: string }) => {
				if (value.phase === targetPhase && !triggered) {
					triggered = true;
					setTimeout(() => {
						const started = performance.now();
						Effect.runPromise(Fiber.interrupt(fiber))
							.then(() => {
								interruptMs = performance.now() - started;
							})
							.catch((cause: unknown) => {
								interruptError = String(cause);
								interruptMs = performance.now() - started;
							});
					}, delayMs);
				}
			}),
			Effect.provide(context)
		);
		const fiber = Effect.runFork(running);
		const exit = await Effect.runPromise(Fiber.await(fiber));
		if (!triggered) throw new Error(`Phase ${targetPhase} was never reported.`);
		while (interruptMs < 0) await new Promise((resolve) => setTimeout(resolve, 25));
		// Idle: no native children left, or their CPU stops advancing.
		const idleStarted = performance.now();
		let previous: { count: number; cpuMs: number } | undefined;
		let stillSince = performance.now();
		for (;;) {
			const current = await nativeChildren().catch(() => ({ count: 0, cpuMs: 0 }));
			if (current.count === 0) {
				idleMs = performance.now() - idleStarted;
				break;
			}
			if (previous && Math.abs(current.cpuMs - previous.cpuMs) < 50) {
				if (performance.now() - stillSince >= 500) {
					idleMs = performance.now() - idleStarted;
					break;
				}
			} else stillSince = performance.now();
			previous = current;
			if (performance.now() - idleStarted > 120000) {
				idleMs = performance.now() - idleStarted;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const secondStarted = performance.now();
		let secondOk = false;
		let secondError: string | undefined;
		try {
			await Effect.runPromise(
				Effect.scoped(refresh.refresh({ projectRoot: project, targetName })).pipe(
					Effect.provide(context)
				)
			);
			secondOk = true;
		} catch (cause) {
			secondError =
				cause instanceof Error ? cause.message.slice(0, 300) : String(cause).slice(0, 300);
		}
		const result: RepetitionResult = {
			rep,
			phase: targetPhase,
			delayMs,
			interrupted: Exit.isFailure(exit),
			interruptMs: Math.round(interruptMs),
			idleMs: Math.round(idleMs),
			secondRefreshOk: secondOk,
			secondRefreshMs: Math.round(performance.now() - secondStarted)
		};
		if (interruptError) result.interruptError = interruptError;
		if (secondError) result.secondError = secondError;
		return result;
	} finally {
		await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
	}
}

await withEngineBenchmarkLock(async () => {
	const discoveryScope = await Effect.runPromise(Scope.make());
	const discovery = await Effect.runPromise(
		Effect.flatMap(LocalizationEvidence, (reader) =>
			reader.discover({ projectRoot: project })
		).pipe(Effect.provide(LocalizationEvidenceNodeLive))
	);
	await Effect.runPromise(Scope.close(discoveryScope, Exit.void)).catch(() => undefined);
	const targetName = discovery.targets[0]?.name;
	if (!targetName) throw new Error("The project has no localization target.");
	const results = [];
	for (let rep = 1; rep <= reps; rep++) {
		const result = await repetition(rep, targetName);
		results.push(result);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	}
	await mkdir(dirname(values.out!), { recursive: true });
	await writeFile(
		values.out!,
		JSON.stringify({ phase: targetPhase, results }, null, "\t") + "\n"
	);
});
