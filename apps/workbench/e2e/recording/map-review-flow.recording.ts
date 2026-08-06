import { spawnSync } from "node:child_process";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { Effect } from "effect";
import type { ElectronApplication } from "playwright";
import {
	decodeMapReviewFlowRecordingManifest,
	type MapReviewFlowRecordingManifest
} from "../../src/main/map-review-flow-contract.js";
import { runMapReviewAuthoringRoundtrip } from "../../src/main/map-review-flow.js";
import {
	createMapReviewFlowHarness,
	makeMapReviewCheckpointCollector
} from "../map-review-flow-driver.js";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const enabled = process.env.UE_SHED_MAP_REVIEW_FLOW_RECORDING === "1" && endpoint !== undefined;
const flow: "authoring-roundtrip" | "high-count-rig" =
	process.env.UE_SHED_MAP_REVIEW_FLOW === "high-count-rig"
		? "high-count-rig"
		: "authoring-roundtrip";

test.skip(!enabled, "launch through pnpm record:flow:map-review with a live fixture editor");
test.setTimeout(300_000);

function message(cause: unknown): string {
	return cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
}

async function startScreencast(page: Page, path: string): Promise<void> {
	const screenshot = await page.screenshot({ type: "png" });
	const size = {
		height: screenshot.readUInt32BE(20) & ~1,
		width: screenshot.readUInt32BE(16) & ~1
	};
	await page.screencast.start({
		annotate: { duration: 700, fontSize: 18, position: "top-right" },
		path,
		size
	});
}

async function concatenateVideos(
	segmentPaths: readonly string[],
	outputPath: string
): Promise<void> {
	if (segmentPaths.length === 1) {
		await copyFile(segmentPaths[0]!, outputPath);
		return;
	}
	const inputs = segmentPaths.flatMap((path) => ["-i", path]);
	const streams = segmentPaths.map((_, index) => `[${index}:v:0]`).join("");
	const result = spawnSync(
		"ffmpeg",
		[
			"-y",
			...inputs,
			"-filter_complex",
			`${streams}concat=n=${segmentPaths.length}:v=1:a=0[outv]`,
			"-map",
			"[outv]",
			"-c:v",
			"libvpx-vp9",
			"-deadline",
			"realtime",
			"-cpu-used",
			"8",
			outputPath
		],
		{ encoding: "utf8", windowsHide: true }
	);
	if (result.status !== 0) {
		throw new Error(`FFmpeg could not join the flow segments: ${result.stderr.trim()}`);
	}
}

test(`records the Map Review ${flow} flow`, async ({ browserName: _browserName }, testInfo) => {
	if (endpoint === undefined) throw new Error("The live Map Review endpoint is unavailable.");
	const startedAt = new Date().toISOString();
	const logs: string[] = [];
	const videoSegments: string[] = [];
	const traceArtifacts: string[] = [];
	const tracePaths = new Map<number, string>();
	const lifecycle = {
		afterLaunch: async ({
			application,
			page,
			segment
		}: {
			readonly application: ElectronApplication;
			readonly page: Page;
			readonly segment: number;
		}) => {
			const sequence = String(segment).padStart(2, "0");
			const videoRelative = `video/segment-${sequence}.webm`;
			const traceRelative = `traces/segment-${sequence}.zip`;
			await mkdir(testInfo.outputPath("video"), { recursive: true });
			await mkdir(testInfo.outputPath("traces"), { recursive: true });
			page.on("console", (entry) =>
				logs.push(`[renderer:${segment}:${entry.type()}] ${entry.text()}`)
			);
			page.on("pageerror", (error) =>
				logs.push(`[renderer:${segment}:error] ${message(error)}`)
			);
			const child = application.process();
			child.stdout?.on("data", (chunk: Buffer) =>
				logs.push(`[main:${segment}:stdout] ${chunk.toString()}`)
			);
			child.stderr?.on("data", (chunk: Buffer) =>
				logs.push(`[main:${segment}:stderr] ${chunk.toString()}`)
			);
			await startScreencast(page, testInfo.outputPath(videoRelative));
			await application.context().tracing.start({
				screenshots: true,
				snapshots: true,
				sources: true
			});
			videoSegments.push(testInfo.outputPath(videoRelative));
			traceArtifacts.push(traceRelative);
			tracePaths.set(segment, testInfo.outputPath(traceRelative));
		},
		beforeClose: async ({
			application,
			page,
			segment
		}: {
			readonly application: ElectronApplication;
			readonly page: Page;
			readonly segment: number;
		}) => {
			await page.screencast.stop();
			const tracePath = tracePaths.get(segment);
			if (tracePath === undefined) throw new Error(`No trace path for segment ${segment}.`);
			await application.context().tracing.stop({ path: tracePath });
		}
	};
	const harness = await createMapReviewFlowHarness({
		artifactRoot: testInfo.outputDir,
		endpoint,
		flow,
		lifecycle
	});
	const collector = makeMapReviewCheckpointCollector({
		harness,
		recording: true,
		testInfo
	});
	let failure: unknown;

	try {
		await Effect.runPromise(
			runMapReviewAuthoringRoundtrip({ driver: harness.driver, sink: collector.sink })
		);
	} catch (cause) {
		failure = cause;
		logs.push(`[flow:error] ${message(cause)}`);
	}

	const videoPath = testInfo.outputPath("flow.webm");
	await concatenateVideos(videoSegments, videoPath);
	await expect.poll(async () => (await stat(videoPath)).size).toBeGreaterThan(0);
	await writeFile(testInfo.outputPath("logs.txt"), `${logs.join("\n")}\n`, "utf8");
	const finishedAt = new Date().toISOString();
	const base = {
		artifacts: { logs: "logs.txt", traces: traceArtifacts, video: "flow.webm" },
		checkpoints: collector.checkpoints,
		cleanup:
			failure === undefined
				? {
						mapDirtyAfter: false,
						provisionedCameraCountAfter: 0,
						status: "verified" as const
					}
				: { status: "not_run" as const },
		commit: process.env.UE_SHED_RECORDING_COMMIT ?? "unknown",
		contract: { name: "ue-shed-map-review-flow-recording" as const, version: 1 as const },
		dirty: process.env.UE_SHED_RECORDING_DIRTY === "true",
		finishedAt,
		fixture: { map: harness.fixtureMap, subjectKey: harness.subjectKey },
		flow,
		id: process.env.UE_SHED_RECORDING_ID ?? `manual-${Date.now()}`,
		startedAt
	};
	const manifest: MapReviewFlowRecordingManifest =
		failure === undefined
			? { ...base, status: "passed" }
			: {
					...base,
					failure: {
						message: message(failure),
						name: failure instanceof Error ? failure.name : "UnknownError"
					},
					status: "failed"
				};
	const decoded = decodeMapReviewFlowRecordingManifest(manifest);
	await writeFile(testInfo.outputPath("manifest.json"), `${JSON.stringify(decoded, null, 2)}\n`);

	if (failure !== undefined) throw failure;
	expect(decoded.status).toBe("passed");
});
