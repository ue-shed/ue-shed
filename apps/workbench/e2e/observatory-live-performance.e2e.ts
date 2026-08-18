import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/workbench-test.js";

const enabled = process.env.UE_SHED_OBSERVATORY_LIVE_E2E === "1";
const measurementDurationMs = 10_000;
const minimumPresentationHz = 10;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const resultsPath = resolve(repoRoot, "test-results/observatory-workbench-live-benchmark.json");

interface WorldScoutPaintSample {
	readonly actorsChanged: number;
	readonly actorsObserved: number;
	readonly durationMs: number;
	readonly sequence: string;
}

interface Measurement {
	readonly animationFrames: number;
	readonly elapsedMs: number;
	readonly ipcEvents: ReadonlyArray<{
		readonly actorsChanged: number | undefined;
		readonly kind: string;
		readonly revision: string | undefined;
		readonly sequence: string | undefined;
		readonly sessionId: string | undefined;
		readonly status: string | undefined;
		readonly transformCount: number | undefined;
	}>;
	readonly samples: ReadonlyArray<WorldScoutPaintSample>;
}

function percentile(samples: ReadonlyArray<number>, ratio: number): number {
	const sorted = [...samples].sort((left, right) => left - right);
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
	return sorted[index] ?? 0;
}

test.skip(
	!enabled,
	"set UE_SHED_OBSERVATORY_LIVE_E2E=1 with the fixture editor in PIE and Remote Control reachable"
);
test.setTimeout(90_000);

test("presents live L_CameraLoad transforms through Workbench at at least 10 FPS", async ({
	workbench
}) => {
	await workbench.expectShowcaseReady();
	await workbench.page.evaluate(() => {
		type Sample = {
			readonly actorsChanged: number;
			readonly actorsObserved: number;
			readonly durationMs: number;
			readonly sequence: string;
		};
		// SAFETY: this runs in the Workbench renderer, whose preload and test setup install these globals.
		const target = globalThis as typeof globalThis & {
			__ueShedWorldScoutPaintSamples?: Sample[];
			__ueShedWorldObservationEvents?: Array<{
				readonly actorsChanged: number | undefined;
				readonly kind: string;
				readonly revision: string | undefined;
				readonly sequence: string | undefined;
				readonly sessionId: string | undefined;
				readonly status: string | undefined;
				readonly transformCount: number | undefined;
			}>;
			addEventListener: (
				name: string,
				listener: (event: { readonly detail: unknown }) => void
			) => void;
			ueShed: {
				onWorldObservation: (
					listener: (event: {
						readonly actorsChanged?: number;
						readonly kind: string;
						readonly revision?: string;
						readonly sequence?: string;
						readonly sessionId?: string;
						readonly status?: string;
						readonly transforms?: ReadonlyArray<unknown>;
					}) => void
				) => () => void;
			};
		};
		const samples: Sample[] = [];
		const ipcEvents: Array<{
			readonly actorsChanged: number | undefined;
			readonly kind: string;
			readonly revision: string | undefined;
			readonly sequence: string | undefined;
			readonly sessionId: string | undefined;
			readonly status: string | undefined;
			readonly transformCount: number | undefined;
		}> = [];
		target.__ueShedWorldScoutPaintSamples = samples;
		target.__ueShedWorldObservationEvents = ipcEvents;
		target.ueShed.onWorldObservation((event) => {
			ipcEvents.push({
				actorsChanged: event.actorsChanged,
				kind: event.kind,
				revision: event.revision,
				sequence: event.sequence,
				sessionId: event.sessionId,
				status: event.status,
				transformCount: event.transforms?.length
			});
		});
		target.addEventListener("ue-shed:world-scout-painted", (event) => {
			const detail = event.detail;
			const isNumber = <Value>(value: Value): value is Value & number =>
				Object.prototype.toString.call(value) === "[object Number]";
			const isString = <Value>(value: Value): value is Value & string =>
				Object.prototype.toString.call(value) === "[object String]";
			const isSample = <Value>(value: Value): value is Value & Sample =>
				value instanceof Object &&
				"actorsChanged" in value &&
				isNumber(value.actorsChanged) &&
				"actorsObserved" in value &&
				isNumber(value.actorsObserved) &&
				"durationMs" in value &&
				isNumber(value.durationMs) &&
				"sequence" in value &&
				isString(value.sequence);
			if (isSample(detail)) samples.push(detail);
		});
	});
	await workbench.openRoute("Map Review");
	const actorMap = workbench.page.getByRole("application", { name: "Top-down actor map" });
	await expect(actorMap).toBeVisible();
	await expect(workbench.page.getByText(/UEDPIE_0_L_CameraLoad/)).toBeVisible({
		timeout: 60_000
	});
	await workbench.page.waitForFunction(
		() => {
			// SAFETY: this runs in the Workbench renderer, whose preload and test setup install these globals.
			const target = globalThis as typeof globalThis & {
				__ueShedWorldScoutPaintSamples?: Array<{
					readonly actorsObserved: number;
					readonly sequence: string;
				}>;
			};
			return target.__ueShedWorldScoutPaintSamples?.some(
				(sample) => sample.actorsObserved >= 4_096
			);
		},
		undefined,
		{ timeout: 60_000 }
	);
	const sequenceBeforeCadenceChange = await workbench.page.evaluate(() => {
		// SAFETY: this runs in the Workbench renderer, whose preload and test setup install these globals.
		const target = globalThis as typeof globalThis & {
			__ueShedWorldScoutPaintSamples?: WorldScoutPaintSample[];
		};
		return target.__ueShedWorldScoutPaintSamples?.at(-1)?.sequence;
	});
	await workbench.page.evaluate(() => {
		// SAFETY: this runs in the Workbench renderer, whose preload and test setup install these globals.
		const target = globalThis as typeof globalThis & {
			__ueShedWorldObservationEvents?: Measurement["ipcEvents"] extends ReadonlyArray<
				infer Event
			>
				? Event[]
				: never;
		};
		target.__ueShedWorldObservationEvents?.splice(0);
	});
	const refreshRate = workbench.page.getByRole("slider", { name: "World refresh rate" });
	await refreshRate.fill("20");
	await expect(refreshRate).toHaveValue("20");
	await workbench.page.waitForFunction(
		(sequenceBefore) => {
			// SAFETY: this runs in the Workbench renderer, whose preload and test setup install these globals.
			const target = globalThis as typeof globalThis & {
				__ueShedWorldScoutPaintSamples?: WorldScoutPaintSample[];
			};
			return target.__ueShedWorldScoutPaintSamples?.some(
				(sample) => sample.sequence !== sequenceBefore
			);
		},
		sequenceBeforeCadenceChange,
		{ timeout: 5_000 }
	);
	const lifecycleEventsAfterCadenceChange = await workbench.page.evaluate(() => {
		// SAFETY: this runs in the Workbench renderer, whose preload and test setup install these globals.
		const target = globalThis as typeof globalThis & {
			__ueShedWorldObservationEvents?: Measurement["ipcEvents"] extends ReadonlyArray<
				infer Event
			>
				? Event[]
				: never;
		};
		return (target.__ueShedWorldObservationEvents ?? []).filter(
			(event) => event.kind !== "transforms"
		);
	});
	expect(lifecycleEventsAfterCadenceChange).toEqual([]);
	// The fixture has a dense actor lattice, so the map centre is guaranteed to be
	// within the normal pick radius of an observed actor. Exercise the actual
	// pointer-selection path before testing the Remote Control focus request.
	const mapBounds = await actorMap.boundingBox();
	if (mapBounds === null) throw new Error("The World Scout canvas has no layout bounds.");
	await actorMap.click({
		position: {
			x: Math.round(mapBounds.width / 2),
			y: Math.round(mapBounds.height / 2)
		}
	});
	await expect(workbench.page.getByRole("button", { name: /GO TO ACTOR/ })).toBeVisible();
	const sequenceBeforeFocus = await workbench.page.evaluate(() => {
		// SAFETY: this runs in the Workbench renderer, whose preload and test setup install these globals.
		const target = globalThis as typeof globalThis & {
			__ueShedWorldScoutPaintSamples?: WorldScoutPaintSample[];
		};
		return target.__ueShedWorldScoutPaintSamples?.at(-1)?.sequence;
	});
	await workbench.page.evaluate(() => {
		// SAFETY: this runs in the Workbench renderer, whose preload and test setup install these globals.
		const target = globalThis as typeof globalThis & {
			__ueShedWorldScoutPaintSamples?: WorldScoutPaintSample[];
			__ueShedWorldObservationEvents?: Measurement["ipcEvents"] extends ReadonlyArray<
				infer Event
			>
				? Event[]
				: never;
		};
		target.__ueShedWorldScoutPaintSamples?.splice(0);
		target.__ueShedWorldObservationEvents?.splice(0);
	});
	await workbench.page.getByRole("button", { name: /GO TO ACTOR/ }).click();
	await expect(workbench.page.getByText(/FOCUSED (IN UNREAL|RUNTIME ACTOR)/)).toBeVisible();
	await workbench.page.waitForFunction(
		(sequenceBefore) => {
			// SAFETY: this runs in the Workbench renderer, whose preload and test setup install these globals.
			const target = globalThis as typeof globalThis & {
				__ueShedWorldScoutPaintSamples?: WorldScoutPaintSample[];
			};
			return target.__ueShedWorldScoutPaintSamples?.some(
				(sample) => sample.sequence !== sequenceBefore
			);
		},
		sequenceBeforeFocus,
		{ timeout: 5_000 }
	);
	const staleEventsAfterFocus = await workbench.page.evaluate(() => {
		// SAFETY: this runs in the Workbench renderer, whose preload and test setup install these globals.
		const target = globalThis as typeof globalThis & {
			__ueShedWorldObservationEvents?: Measurement["ipcEvents"] extends ReadonlyArray<
				infer Event
			>
				? Event[]
				: never;
		};
		return (target.__ueShedWorldObservationEvents ?? []).filter(
			(event) => event.kind === "catalog" && event.status === "stale"
		).length;
	});
	expect(staleEventsAfterFocus).toBe(0);

	const measurement = await workbench.page.evaluate(
		(durationMs): Promise<Measurement> =>
			new Promise((resolveMeasurement) => {
				// SAFETY: this runs in the Workbench renderer, whose preload and test setup install these globals.
				const target = globalThis as typeof globalThis & {
					__ueShedWorldScoutPaintSamples?: WorldScoutPaintSample[];
					__ueShedWorldObservationEvents?: Array<{
						readonly actorsChanged: number | undefined;
						readonly kind: string;
						readonly revision: string | undefined;
						readonly sequence: string | undefined;
						readonly sessionId: string | undefined;
						readonly status: string | undefined;
						readonly transformCount: number | undefined;
					}>;
					cancelAnimationFrame: (handle: number) => void;
					requestAnimationFrame: (callback: () => void) => number;
					setTimeout: (callback: () => void, delayMs: number) => number;
				};
				const samples = target.__ueShedWorldScoutPaintSamples;
				const ipcEvents = target.__ueShedWorldObservationEvents;
				if (samples === undefined)
					throw new Error("World Scout paint listener was not installed.");
				if (ipcEvents === undefined)
					throw new Error("World observation listener was not installed.");
				samples.length = 0;
				ipcEvents.length = 0;
				let animationFrames = 0;
				let animationFrameHandle = 0;
				const countAnimationFrame = () => {
					animationFrames += 1;
					animationFrameHandle = target.requestAnimationFrame(countAnimationFrame);
				};
				animationFrameHandle = target.requestAnimationFrame(countAnimationFrame);
				const startedAt = performance.now();
				target.setTimeout(() => {
					target.cancelAnimationFrame(animationFrameHandle);
					resolveMeasurement({
						animationFrames,
						elapsedMs: performance.now() - startedAt,
						ipcEvents: [...ipcEvents],
						samples: [...samples]
					});
				}, durationMs);
			}),
		measurementDurationMs
	);

	const uniqueSequenceSamples = measurement.samples.filter(
		(sample, index, all) => index === 0 || sample.sequence !== all[index - 1]?.sequence
	);
	const effectiveHz = uniqueSequenceSamples.length / (measurement.elapsedMs / 1_000);
	const paintP95Ms = percentile(
		measurement.samples.map((sample) => sample.durationMs),
		0.95
	);
	const catalogSize = Math.max(...measurement.samples.map((sample) => sample.actorsObserved));
	const changedP95 = percentile(
		uniqueSequenceSamples.map((sample) => sample.actorsChanged),
		0.95
	);
	const ipcTransformEvents = measurement.ipcEvents.filter((event) => event.kind === "transforms");
	const ipcSequences = ipcTransformEvents
		.map((event) => event.sequence)
		.filter((sequence): sequence is string => sequence !== undefined);
	const result = {
		animationFrames: measurement.animationFrames,
		catalogSize,
		changedP95,
		effectiveHz,
		elapsedMs: measurement.elapsedMs,
		ipcChangedP95: percentile(
			ipcTransformEvents.map((event) => event.actorsChanged ?? 0),
			0.95
		),
		ipcFirstSequence: ipcSequences[0] ?? null,
		ipcLastSequence: ipcSequences.at(-1) ?? null,
		ipcTransformP95: percentile(
			ipcTransformEvents.map((event) => event.transformCount ?? 0),
			0.95
		),
		ipcTransformEvents: ipcTransformEvents.length,
		paintP95Ms,
		paintedSequences: uniqueSequenceSamples.length
	};
	mkdirSync(dirname(resultsPath), { recursive: true });
	writeFileSync(resultsPath, `${JSON.stringify(result, null, "\t")}\n`, "utf8");
	process.stdout.write(
		`workbench catalog=${catalogSize} painted=${result.paintedSequences} ` +
			`effective=${effectiveHz.toFixed(1)} Hz changed.p95=${changedP95.toFixed(0)} ` +
			`paint.p95=${paintP95Ms.toFixed(3)} ms ipc.transforms=${ipcTransformEvents.length} ` +
			`raf=${result.animationFrames} ` +
			`ipc.changed.p95=${result.ipcChangedP95.toFixed(0)} ` +
			`ipc.batch.p95=${result.ipcTransformP95.toFixed(0)} ` +
			`ipc.sequence=${result.ipcFirstSequence ?? "—"}..${result.ipcLastSequence ?? "—"}\n`
	);

	expect(catalogSize).toBeGreaterThanOrEqual(4_096);
	expect(uniqueSequenceSamples.length).toBeGreaterThan(0);
	expect(effectiveHz).toBeGreaterThanOrEqual(minimumPresentationHz);
	expect(paintP95Ms).toBeLessThanOrEqual(100);
	expect(ipcTransformEvents.length).toBeGreaterThanOrEqual(minimumPresentationHz);
	expect(
		ipcTransformEvents.every(
			(event) =>
				event.transformCount !== undefined &&
				event.transformCount <= (event.actorsChanged ?? 0)
		)
	).toBe(true);
});
