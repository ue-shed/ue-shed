/** Live Unreal -> USOT pipe -> Observatory host benchmark. Requires the fixture editor in PIE. */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { Config, Deferred, Duration, Effect, Fiber, Layer, Stream } from "effect";
import {
	Observatory,
	ObservatoryLive,
	type ActorObservationDiagnostic,
	type WorldObservationState
} from "../src/index.js";

const warmupDuration = Duration.seconds(2);
const measurementDuration = Duration.seconds(10);
const defaultRemoteControlEndpoint = "http://127.0.0.1:30001";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const expectedClasses = new Map([
	["UEShedFixtureStationary", 3278],
	["UEShedFixtureFlying", 409],
	["UEShedFixtureIntermittent", 409]
]);

interface Distribution {
	readonly mean: number;
	readonly p50: number;
	readonly p95: number;
	readonly max: number;
}

function percentile(sorted: ReadonlyArray<number>, ratio: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
	return sorted[index] ?? 0;
}

function distribution(values: ReadonlyArray<number>): Distribution {
	const sorted = [...values].sort((left, right) => left - right);
	const total = sorted.reduce((sum, value) => sum + value, 0);
	return {
		mean: sorted.length === 0 ? 0 : total / sorted.length,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		max: sorted.at(-1) ?? 0
	};
}

function assertFixtureCatalog(state: WorldObservationState): number | undefined {
	if (state.status !== "live") return undefined;
	const { catalog } = state.sample;
	if (!catalog.mapPath.endsWith("L_CameraLoad")) {
		throw new Error(
			`Live Observatory benchmark requires L_CameraLoad, received ${catalog.mapPath}.`
		);
	}
	if (catalog.worldKind !== "pie") {
		throw new Error(
			"Live Observatory benchmark requires PIE so fixture mover transforms are active."
		);
	}
	const classCounts = new Map<string, number>();
	for (const entry of catalog.entries) {
		classCounts.set(entry.className, (classCounts.get(entry.className) ?? 0) + 1);
	}
	for (const [className, expected] of expectedClasses) {
		const actual = classCounts.get(className) ?? 0;
		if (actual !== expected) {
			throw new Error(`Expected ${expected} ${className} actors, received ${actual}.`);
		}
	}
	return catalog.entries.length;
}

function runWorkbenchLiveBenchmark(): void {
	const result = spawnSync(
		process.execPath,
		["scripts/benchmark-observatory-workbench-live.ts"],
		{
			cwd: repoRoot,
			stdio: "inherit",
			windowsHide: true
		}
	);
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`Workbench live Observatory benchmark failed with status ${result.status}.`
		);
	}
}

const benchmark = Effect.scoped(
	Effect.gen(function* () {
		const endpoint = yield* Config.string("UE_SHED_REMOTE_CONTROL_ENDPOINT").pipe(
			Config.withDefault(defaultRemoteControlEndpoint)
		);
		const observatory = yield* Observatory;
		const ready = yield* Deferred.make<number>();
		const diagnostics: ActorObservationDiagnostic[] = [];
		let validatedCatalogSize: number | undefined;
		let measuring = false;

		const fiber = yield* observatory
			.observe(endpoint, {
				cadenceHz: 30,
				onDiagnostic: (diagnostic) =>
					Effect.sync(() => {
						if (measuring) diagnostics.push(diagnostic);
					})
			})
			.pipe(
				Stream.runForEach((state) =>
					Effect.sync(() => {
						if (validatedCatalogSize !== undefined) return undefined;
						validatedCatalogSize = assertFixtureCatalog(state);
						return validatedCatalogSize;
					}).pipe(
						Effect.flatMap((catalogSize) =>
							catalogSize === undefined
								? Effect.void
								: Deferred.succeed(ready, catalogSize).pipe(Effect.ignore)
						)
					)
				),
				Effect.forkScoped
			);

		const catalogSize = yield* Deferred.await(ready).pipe(Effect.timeout(Duration.seconds(20)));
		yield* Effect.sleep(warmupDuration);
		diagnostics.length = 0;
		measuring = true;
		const started = performance.now();
		yield* Effect.sleep(measurementDuration);
		const elapsedSeconds = (performance.now() - started) / 1_000;
		measuring = false;
		yield* Fiber.interrupt(fiber);

		if (diagnostics.length === 0) {
			return yield* Effect.fail(
				new Error("The live Observatory stream produced no packets during measurement.")
			);
		}

		const decodeApply = distribution(diagnostics.map((sample) => sample.decodeApplyMs));
		const producerSampling = distribution(
			diagnostics.map((sample) => sample.samplingDurationMicros / 1_000)
		);
		const actorSamples = distribution(diagnostics.map((sample) => sample.actorsSampled));
		const actorChanges = distribution(diagnostics.map((sample) => sample.actorsChanged));
		const gapEvents = diagnostics.filter((sample) => sample.missingSequences > 0).length;
		const missingSequences = diagnostics.reduce(
			(total, sample) => total + sample.missingSequences,
			0
		);
		const first = diagnostics[0];
		const last = diagnostics.at(-1);
		if (first === undefined || last === undefined) {
			return yield* Effect.fail(new Error("Missing live Observatory diagnostic bounds."));
		}

		return {
			actorChanges,
			actorSamples,
			catalogSize,
			decodeApply,
			effectiveHz: diagnostics.length / elapsedSeconds,
			gapEvents,
			missingSequences,
			packets: diagnostics.length,
			producerReplacements: Math.max(
				0,
				last.producerReplacements - first.producerReplacements
			),
			producerSampling,
			receiverReplacements: Math.max(
				0,
				last.receiverReplacements - first.receiverReplacements
			)
		};
	}).pipe(Effect.provide(ObservatoryLive.pipe(Layer.provide(RemoteControlClientLive))))
);

Effect.runPromise(benchmark).then(
	(result) => {
		process.stdout.write(
			`live   catalog=${result.catalogSize} packets=${result.packets} ` +
				`effective=${result.effectiveHz.toFixed(1)} Hz\n`
		);
		process.stdout.write(
			`actors sampled.avg=${result.actorSamples.mean.toFixed(1)} ` +
				`changed.avg=${result.actorChanges.mean.toFixed(1)} ` +
				`changed.p95=${result.actorChanges.p95.toFixed(0)}\n`
		);
		process.stdout.write(
			`timing producer-sample.p95=${result.producerSampling.p95.toFixed(3)} ms ` +
				`decode+apply.p95=${result.decodeApply.p95.toFixed(3)} ms\n`
		);
		process.stdout.write(
			`health gap-events=${result.gapEvents} missing-sequences=${result.missingSequences} ` +
				`producer-replacements=${result.producerReplacements} ` +
				`receiver-replacements=${result.receiverReplacements}\n`
		);
		try {
			runWorkbenchLiveBenchmark();
		} catch (error) {
			process.stderr.write(
				`Live Observatory Workbench benchmark failed: ${
					error instanceof Error ? error.message : String(error)
				}\n`
			);
			process.exitCode = 1;
		}
	},
	(error) => {
		process.stderr.write(
			`Live Observatory benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exitCode = 1;
	}
);
