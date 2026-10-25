/**
 * Interrupts a cold Game Text refresh during one named progress phase and measures:
 * how long the interrupt takes to return, how long until every native child has
 * exited, and whether an immediate second refresh on the same cache
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
	childrenRemaining: number;
	inventoryChildrenRemaining: number;
	childObservations: readonly ChildObservation[];
	secondRefreshOk: boolean;
	secondRefreshMs: number;
	interruptError?: string;
	secondError?: string;
}

interface ChildObservation {
	elapsedMs: number;
	children: readonly { pid: number; role: string; cpuMs: number }[];
}

const { GameTextIndexBuilderLive, gameTextIndexRefreshLayer, gameTextIndexSourceNodeLayer } =
	currentIndex;
const { GameTextIndexSource } = currentIndex;
const { AssetReaderLive } = currentAssets;
const { LocalizationEvidence, LocalizationEvidenceNodeLive } = currentLocalization;
const { GameTextIndexRefresh } = await import("../packages/game-text/dist/index-refresh.js");
const { GameTextIndexProgressReporter } = currentIndex;

async function nativeChildren(): Promise<ChildObservation["children"]> {
	const script =
		"$ErrorActionPreference='Stop'; $all = @(Get-CimInstance Win32_Process); " +
		`$owned = [System.Collections.Generic.HashSet[uint32]]::new(); [void]$owned.Add(${process.pid}); ` +
		"do { $added = $false; foreach ($item in $all) { if ($owned.Contains($item.ParentProcessId) -and $owned.Add($item.ProcessId)) { $added = $true } } } while ($added); " +
		"$children = @(foreach ($item in $all) { if ($owned.Contains($item.ProcessId) -and $item.ProcessId -ne " +
		`${process.pid} -and $item.Name -notin @('powershell.exe', 'pwsh.exe', 'conhost.exe', 'cmd.exe')) { ` +
		"$role = if ($item.CommandLine -like '*protocol-session*') { 'native-session' } elseif ($item.CommandLine -like '*protocol*') { 'native-oneshot' } elseif ($item.Name -eq 'esbuild.exe') { 'loader' } else { 'other' }; " +
		"[pscustomobject]@{ pid=[int]$item.ProcessId; role=$role; cpuMs=([double]$item.KernelModeTime+[double]$item.UserModeTime)/10000 } } }); " +
		"ConvertTo-Json -InputObject $children -Compress";
	const { stdout } = await run(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", script],
		{ windowsHide: true, timeout: 10000 }
	);
	// SAFETY: the sampler above builds this exact shape with ConvertTo-Json.
	return JSON.parse(stdout) as ChildObservation["children"];
}

async function prepareInventory(cache: string) {
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const source = yield* GameTextIndexSource;
				return yield* source.inventory({ projectRoot: project });
			}).pipe(
				Effect.provide(
					gameTextIndexSourceNodeLayer(cache).pipe(Layer.provide(AssetReaderLive))
				)
			)
		)
	);
}

async function buildContext(
	cache: string,
	scope: Scope.Scope,
	inventory: Awaited<ReturnType<typeof prepareInventory>>
) {
	const source = Layer.effect(
		GameTextIndexSource,
		Effect.gen(function* () {
			const live = yield* GameTextIndexSource;
			return GameTextIndexSource.of({
				...live,
				inventory: () => Effect.succeed(inventory)
			});
		})
	).pipe(Layer.provide(gameTextIndexSourceNodeLayer(cache).pipe(Layer.provide(AssetReaderLive))));
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
	// Inventory belongs to the host; close its native query session before the timed refresh.
	const inventory = await prepareInventory(cache);
	const inventoryChildrenRemaining = (await nativeChildren()).length;
	if (inventoryChildrenRemaining)
		throw new Error("Inventory preparation left descendants alive.");
	const scope = await Effect.runPromise(Scope.make());
	try {
		const context = await buildContext(cache, scope, inventory);
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
		// Sampler shells are excluded; an idle engine still counts as a live child.
		const idleStarted = performance.now();
		let childrenRemaining = -1;
		const childObservations: ChildObservation[] = [];
		for (;;) {
			const children = await nativeChildren();
			childrenRemaining = children.length;
			const elapsedMs = Math.round(performance.now() - idleStarted);
			if (
				!childObservations.length ||
				(childObservations.length === 1 && elapsedMs >= 3000) ||
				childrenRemaining === 0
			) {
				const observation = { elapsedMs, children };
				childObservations.push(observation);
				process.stdout.write(`${JSON.stringify({ phase: targetPhase, ...observation })}\n`);
			}
			if (childrenRemaining === 0) {
				idleMs = performance.now() - idleStarted;
				break;
			}
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
			childrenRemaining,
			inventoryChildrenRemaining,
			childObservations,
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
