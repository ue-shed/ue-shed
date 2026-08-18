import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createServer as createViteServer } from "vite";

const fixturesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const resultsPath = resolve(repoRoot, "test-results/observatory-paint-benchmark.json");

interface PaintScenarioResult {
	readonly actorCount: number;
	readonly canvasCount: number;
	readonly changeRatio: number;
	readonly frames: number;
	readonly maxPendingAfterBurst: number;
	readonly paintMs: {
		readonly count: number;
		readonly max: number;
		readonly mean: number;
		readonly p50: number;
		readonly p95: number;
	};
	readonly scheduledPaints: number;
}

interface ObservatoryPaintOptions {
	readonly actorCount: number;
	readonly changeRatio: number;
	readonly durationMs: number;
	readonly producerHz: number;
}

interface ObservatoryPaintHarnessResult {
	readonly actorCount: number;
	readonly canvasCount: number;
	readonly changeRatio: number;
	readonly frames: number;
	readonly maxPendingAfterBurst: number;
	readonly paintMs: number[];
	readonly scheduledPaints: number;
}

interface ObservatoryPaintWindow {
	readonly __runObservatoryPaintBench?: (
		options: ObservatoryPaintOptions
	) => Promise<ObservatoryPaintHarnessResult>;
}

declare const window: ObservatoryPaintWindow;

function percentile(sorted: ReadonlyArray<number>, ratio: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
	return sorted[index] ?? 0;
}

function distribution(samples: ReadonlyArray<number>): PaintScenarioResult["paintMs"] {
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

/**
 * Canvas presenter performance evidence. Timing budgets are asserted by
 * `pnpm benchmark:observatory`, not by ordinary Workbench correctness CI.
 */
test.describe("observatory canvas performance", () => {
	test("feeds the production Canvas presenter across synthetic densities", async ({ page }) => {
		const vite = await createViteServer({
			appType: "mpa",
			configFile: false,
			root: fixturesRoot,
			server: { middlewareMode: true },
			resolve: {
				alias: {
					"@ue-shed/observatory/presentation": resolve(
						repoRoot,
						"packages/observatory/src/presentation.ts"
					),
					"@ue-shed/observability": resolve(
						repoRoot,
						"packages/observability/src/index.ts"
					)
				}
			},
			optimizeDeps: { include: ["effect"] }
		});
		const server = createServer((request, response) => {
			vite.middlewares(request, response, () => {
				response.statusCode = 404;
				response.end("Not found");
			});
		});
		await new Promise<void>((resolveListen) => {
			server.listen(0, "127.0.0.1", () => resolveListen());
		});
		const address = server.address();
		if (!(address instanceof Object)) {
			throw new Error("Failed to bind Observatory paint harness");
		}

		const scenarios = [
			{ actorCount: 32, changeRatio: 0.1, durationMs: 2_000 },
			{ actorCount: 32, changeRatio: 0.5, durationMs: 2_000 },
			{ actorCount: 32, changeRatio: 1, durationMs: 2_000 },
			{ actorCount: 1_000, changeRatio: 0.1, durationMs: 3_000 },
			{ actorCount: 1_000, changeRatio: 0.5, durationMs: 10_000 },
			{ actorCount: 1_000, changeRatio: 1, durationMs: 3_000 },
			{ actorCount: 4_096, changeRatio: 0.1, durationMs: 3_000 },
			{ actorCount: 4_096, changeRatio: 0.5, durationMs: 3_000 },
			{ actorCount: 4_096, changeRatio: 1, durationMs: 10_000 }
		] as const;

		const results: PaintScenarioResult[] = [];
		try {
			await page.goto(`http://127.0.0.1:${address.port}/observatory-paint.html`, {
				waitUntil: "networkidle"
			});
			await page.waitForFunction(() => window.__runObservatoryPaintBench !== undefined);

			for (const scenario of scenarios) {
				const raw = await page.evaluate(async (input) => {
					const run = window.__runObservatoryPaintBench;
					if (run === undefined) throw new Error("The paint benchmark is not ready.");
					return run({
						...input,
						producerHz: 60
					});
				}, scenario);
				expect(raw.canvasCount).toBe(1);
				expect(raw.maxPendingAfterBurst).toBeLessThanOrEqual(1);
				expect(raw.frames).toBeGreaterThan(5);
				const paintMs = distribution(raw.paintMs);
				results.push({
					actorCount: raw.actorCount,
					canvasCount: raw.canvasCount,
					changeRatio: raw.changeRatio,
					frames: raw.frames,
					maxPendingAfterBurst: raw.maxPendingAfterBurst,
					paintMs,
					scheduledPaints: raw.scheduledPaints
				});
				process.stdout.write(
					`paint  actors=${raw.actorCount} change=${Math.round(raw.changeRatio * 100)}% ` +
						`frames=${raw.frames} paint.p50=${paintMs.p50.toFixed(3)} ms ` +
						`paint.p95=${paintMs.p95.toFixed(3)} ms ` +
						`canvas=${raw.canvasCount} scheduled=${raw.scheduledPaints}\n`
				);
			}
		} finally {
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => (error ? rejectClose(error) : resolveClose()));
			});
			await vite.close();
		}

		writeFileSync(resultsPath, `${JSON.stringify({ results }, null, "\t")}\n`, "utf8");
	});
});
