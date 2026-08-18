/**
 * Repeatable Observatory host + Canvas paint benchmark.
 *
 * Host path: real USOT encoder → incremental decoder → retained world-observation apply.
 * Paint path: production World Scout Canvas presenter via Playwright + Vite harness.
 *
 * Budgets (local reference machine; not portable CI assertions):
 * - 1,000 actors / 50% change / 60 Hz: decode+apply p95 ≤ 4 ms, paint p95 ≤ 8 ms
 * - 4,096 actors / 100% change / 60 Hz: decode+apply p95 ≤ 8 ms, paint p95 ≤ 16.7 ms
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ActorId,
	ActorStreamDecoder,
	actorStreamPacketToTransformBatch,
	applyWorldObservationEvent,
	CatalogRevision,
	connectingState,
	encodeActorStreamPacket,
	ObservationSessionId,
	StreamActorIndex,
	WorldTransform,
	type ActorStreamRecord,
	type WorldObservationState
} from "../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workbenchRoot = resolve(repoRoot, "apps/workbench");
const paintResultsPath = resolve(repoRoot, "test-results/observatory-paint-benchmark.json");
const sessionId = "0123456789abcdef0123456789abcdef";
const revision = 1n;
const producerHz = 60;

const actorCounts = [32, 1_000, 4_096] as const;
const changeRatios = [0.1, 0.5, 1] as const;

interface Distribution {
	readonly count: number;
	readonly max: number;
	readonly mean: number;
	readonly p50: number;
	readonly p95: number;
}

interface HostScenarioResult {
	readonly actorCount: number;
	readonly bytesPerSecond: number;
	readonly changeRatio: number;
	readonly decodeApplyMs: Distribution;
	readonly packetsPerSecond: number;
	readonly producerReplacements: number;
	readonly sequenceGaps: number;
}

interface PaintScenarioResult {
	readonly actorCount: number;
	readonly canvasCount: number;
	readonly changeRatio: number;
	readonly frames: number;
	readonly maxPendingAfterBurst: number;
	readonly paintMs: Distribution;
	readonly scheduledPaints: number;
}

interface BudgetCheck {
	readonly label: string;
	readonly actual: number;
	readonly limit: number;
	readonly ok: boolean;
}

function mulberry32(seed: number): () => number {
	return () => {
		let value = (seed += 0x6d2b79f5);
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function percentile(sorted: ReadonlyArray<number>, ratio: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
	return sorted[index] ?? 0;
}

function distribution(samples: ReadonlyArray<number>): Distribution {
	const sorted = [...samples].sort((left, right) => left - right);
	const sum = sorted.reduce((total, value) => total + value, 0);
	return {
		count: sorted.length,
		max: sorted[sorted.length - 1] ?? 0,
		mean: sorted.length === 0 ? 0 : sum / sorted.length,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95)
	};
}

function formatMs(value: number): string {
	return `${value.toFixed(3)} ms`;
}

function formatRatio(value: number): string {
	return `${Math.round(value * 100)}%`;
}

function installCatalog(actorCount: number): WorldObservationState {
	const entries = Array.from({ length: actorCount }, (_, index) => {
		const x = (index % 64) * 250;
		const y = Math.floor(index / 64) * 250;
		return {
			bounds: {
				center: { x, y, z: 0 },
				extent: { x: 40, y: 40, z: 40 }
			},
			className: index % 3 === 0 ? "Mover" : "StaticMeshActor",
			displayName: `Actor_${index}`,
			id: ActorId.make(`actor-${index}`),
			path: `/Game/Map.Map:PersistentLevel.Actor_${index}`,
			streamIndex: StreamActorIndex.make(index)
		};
	});
	const transforms = entries.map((entry) => ({
		streamIndex: entry.streamIndex,
		transform: WorldTransform.make({
			location: {
				x: entry.bounds.center.x,
				y: entry.bounds.center.y,
				z: 0
			},
			rotation: { x: 0, y: 0, z: 0 }
		})
	}));
	const result = applyWorldObservationEvent(connectingState(), {
		_tag: "catalog",
		catalog: {
			capturedAt: "2026-07-21T00:00:00.000Z",
			entries,
			mapPath: "/Game/Map.Map",
			revision: CatalogRevision.make(revision),
			sessionId: ObservationSessionId.make(sessionId),
			worldKind: "pie",
			worldSeconds: 0
		},
		initialTransforms: transforms
	});
	if (!result.accepted || result.state.status !== "live") {
		throw new Error("Failed to install synthetic catalog");
	}
	return result.state;
}

function changedRecords(
	actorCount: number,
	changeRatio: number,
	random: () => number,
	worldSeconds: number
): ActorStreamRecord[] {
	const changedCount = Math.max(1, Math.round(actorCount * changeRatio));
	const records: ActorStreamRecord[] = [];
	const seen = new Set<number>();
	while (records.length < changedCount) {
		const streamIndex = Math.floor(random() * actorCount);
		if (seen.has(streamIndex)) continue;
		seen.add(streamIndex);
		const baseX = (streamIndex % 64) * 250;
		const baseY = Math.floor(streamIndex / 64) * 250;
		records.push({
			flags: 0,
			location: {
				x: baseX + random() * 40,
				y: baseY + random() * 40,
				z: Math.sin(worldSeconds + streamIndex) * 10
			},
			rotation: { pitch: 0, roll: 0, yaw: random() * 360 },
			streamIndex
		});
	}
	return records;
}

function runHostScenario(
	actorCount: number,
	changeRatio: number,
	durationMs: number
): HostScenarioResult {
	let state = installCatalog(actorCount);
	const decoder = new ActorStreamDecoder();
	const random = mulberry32(actorCount * 1_000 + Math.round(changeRatio * 100));
	const decodeApplySamples: number[] = [];
	let sequence = 1n;
	let bytes = 0;
	let packets = 0;
	let sequenceGaps = 0;
	let producerReplacements = 0;
	const intervalMs = 1_000 / producerHz;
	const endAt = performance.now() + durationMs;

	while (performance.now() < endAt) {
		const worldSeconds = Number(sequence) / producerHz;
		const records = changedRecords(actorCount, changeRatio, random, worldSeconds);
		const encoded = encodeActorStreamPacket({
			actorsChanged: records.length,
			actorsSampled: actorCount,
			catalogRevision: revision,
			producerMonotonicMs: worldSeconds * 1_000,
			producerReplacements,
			records,
			sequence,
			sessionId,
			worldSeconds
		});
		const started = performance.now();
		const decoded = decoder.push(encoded);
		for (const packet of decoded.packets) {
			const applied = applyWorldObservationEvent(state, {
				_tag: "transforms",
				batch: actorStreamPacketToTransformBatch(packet)
			});
			state = applied.state;
			if (applied.sequenceGap) sequenceGaps += 1;
			producerReplacements = Math.max(producerReplacements, packet.producerReplacements);
			packets += 1;
		}
		decodeApplySamples.push(performance.now() - started);
		bytes += encoded.byteLength;
		sequence += 1n;
		const remaining = intervalMs - (performance.now() % intervalMs);
		if (remaining > 0.05) {
			const spinUntil = performance.now() + Math.min(remaining, intervalMs);
			while (performance.now() < spinUntil) {
				// Busy-wait to approximate producer cadence without timer drift on short runs.
			}
		}
	}

	const elapsedSeconds = durationMs / 1_000;
	return {
		actorCount,
		bytesPerSecond: bytes / elapsedSeconds,
		changeRatio,
		decodeApplyMs: distribution(decodeApplySamples),
		packetsPerSecond: packets / elapsedSeconds,
		producerReplacements,
		sequenceGaps
	};
}

async function runPaintScenarios(): Promise<ReadonlyArray<PaintScenarioResult>> {
	mkdirSync(dirname(paintResultsPath), { recursive: true });
	const result = spawnSync(
		process.platform === "win32" ? "pnpm.cmd" : "pnpm",
		["exec", "playwright", "test", "--config", "e2e/playwright.performance.config.ts"],
		{
			cwd: workbenchRoot,
			encoding: "utf8",
			env: process.env,
			shell: process.platform === "win32"
		}
	);
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.status !== 0) {
		throw new Error(
			`Observatory paint Playwright scenario failed with status ${result.status}`
		);
	}
	// SAFETY: the Playwright benchmark writes this private PaintScenarioResult envelope.
	const payload = JSON.parse(readFileSync(paintResultsPath, "utf8")) as {
		readonly results: ReadonlyArray<PaintScenarioResult>;
	};
	return payload.results;
}

function printHostResult(result: HostScenarioResult): void {
	process.stdout.write(
		`host   actors=${result.actorCount} change=${formatRatio(result.changeRatio)} ` +
			`pkt/s=${result.packetsPerSecond.toFixed(1)} ` +
			`bytes/s=${Math.round(result.bytesPerSecond)} ` +
			`decode+apply.p50=${formatMs(result.decodeApplyMs.p50)} ` +
			`decode+apply.p95=${formatMs(result.decodeApplyMs.p95)} ` +
			`gaps=${result.sequenceGaps} replacements=${result.producerReplacements}\n`
	);
}

function evaluateBudgets(
	host: ReadonlyArray<HostScenarioResult>,
	paint: ReadonlyArray<PaintScenarioResult>
): ReadonlyArray<BudgetCheck> {
	const host1k = host.find((row) => row.actorCount === 1_000 && row.changeRatio === 0.5);
	const host4k = host.find((row) => row.actorCount === 4_096 && row.changeRatio === 1);
	const paint1k = paint.find((row) => row.actorCount === 1_000 && row.changeRatio === 0.5);
	const paint4k = paint.find((row) => row.actorCount === 4_096 && row.changeRatio === 1);
	if (
		host1k === undefined ||
		host4k === undefined ||
		paint1k === undefined ||
		paint4k === undefined
	) {
		throw new Error("Missing budget scenario results");
	}
	return [
		{
			label: "1k/50% decode+apply p95",
			actual: host1k.decodeApplyMs.p95,
			limit: 4,
			ok: host1k.decodeApplyMs.p95 <= 4
		},
		{
			label: "1k/50% paint p95",
			actual: paint1k.paintMs.p95,
			limit: 8,
			ok: paint1k.paintMs.p95 <= 8
		},
		{
			label: "4k/100% decode+apply p95",
			actual: host4k.decodeApplyMs.p95,
			limit: 8,
			ok: host4k.decodeApplyMs.p95 <= 8
		},
		{
			label: "4k/100% paint p95",
			actual: paint4k.paintMs.p95,
			limit: 16.7,
			ok: paint4k.paintMs.p95 <= 16.7
		},
		{
			label: "paint uses one canvas",
			actual: paint4k.canvasCount,
			limit: 1,
			ok: paint.every((row) => row.canvasCount === 1)
		},
		{
			label: "paint pending work stays bounded",
			actual: Math.max(...paint.map((row) => row.maxPendingAfterBurst)),
			limit: 1,
			ok: paint.every((row) => row.maxPendingAfterBurst <= 1)
		}
	];
}

async function main(): Promise<void> {
	process.stdout.write("Observatory benchmark (host decode+apply)\n");
	const hostResults: HostScenarioResult[] = [];
	for (const actorCount of actorCounts) {
		for (const changeRatio of changeRatios) {
			const durationMs =
				(actorCount === 1_000 && changeRatio === 0.5) ||
				(actorCount === 4_096 && changeRatio === 1)
					? 3_000
					: 1_500;
			const result = runHostScenario(actorCount, changeRatio, durationMs);
			hostResults.push(result);
			printHostResult(result);
		}
	}

	process.stdout.write("\nObservatory benchmark (Canvas paint)\n");
	const paintResults = await runPaintScenarios();

	process.stdout.write("\nBudget checks\n");
	const budgets = evaluateBudgets(hostResults, paintResults);
	let failed = false;
	for (const check of budgets) {
		const status = check.ok ? "PASS" : "FAIL";
		if (!check.ok) failed = true;
		process.stdout.write(
			`${status} ${check.label}: actual=${check.actual.toFixed(3)} limit=${check.limit}\n`
		);
	}
	if (failed) {
		process.exitCode = 1;
		process.stderr.write(
			"\nOne or more Observatory reference budgets were missed. Do not lower actor counts or cadence; stop and report.\n"
		);
	}
}

await main();
