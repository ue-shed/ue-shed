import {
	configureCameras,
	getCameraStatus,
	openCameraFeedServer,
	type CameraFeedServer,
	type CameraFrame
} from "@ue-shed/cameras";
import type { CameraScheduleConfig } from "@ue-shed/protocol";
import { Effect } from "effect";
import electron, { type BrowserWindow as BrowserWindowInstance } from "electron/main";
import { join } from "node:path";

const remoteControlEndpoint =
	process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT ?? "http://127.0.0.1:30001";
const { app, BrowserWindow, ipcMain } = electron;
let feed: CameraFeedServer | undefined;
let window: BrowserWindowInstance | undefined;
const pendingPresentationFrames = new Map<number, CameraFrame>();
let presentationTimer: NodeJS.Timeout | undefined;
let presentationFramesSent = 0;
let presentationReplacements = 0;
let presentationBudgetMbPerSecond = 80;
let nextPresentationAt = 0;

function schedulePresentationFrame() {
	if (presentationTimer || pendingPresentationFrames.size === 0) return;
	const delay = Math.max(0, nextPresentationAt - performance.now());
	presentationTimer = setTimeout(flushPresentationFrame, delay);
}

function flushPresentationFrame() {
	presentationTimer = undefined;
	const frame = pendingPresentationFrames.values().next().value;
	if (!frame) return;
	pendingPresentationFrames.delete(frame.cameraIndex);
	window?.webContents.send("camera:frame", {
		...frame,
		pixels: frame.pixels,
		sequence: frame.sequence.toString()
	});
	presentationFramesSent += 1;
	const now = performance.now();
	nextPresentationAt =
		Math.max(now, nextPresentationAt) +
		(frame.pixels.byteLength / (presentationBudgetMbPerSecond * 1_000_000)) * 1_000;
	schedulePresentationFrame();
}

async function createWindow() {
	feed = await Effect.runPromise(openCameraFeedServer());
	window = new BrowserWindow({
		backgroundColor: "#0b0d0d",
		height: 940,
		minHeight: 720,
		minWidth: 1120,
		show: false,
		title: "UE Shed · Camera Load Lab",
		webPreferences: {
			contextIsolation: true,
			preload: join(import.meta.dirname, "preload.cjs"),
			sandbox: true
		},
		width: 1540
	});
	feed.subscribe((frame) => {
		if (pendingPresentationFrames.has(frame.cameraIndex)) presentationReplacements += 1;
		pendingPresentationFrames.set(frame.cameraIndex, frame);
		schedulePresentationFrame();
	});
	window.once("ready-to-show", () => window?.show());
	await window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

ipcMain.handle("camera:metrics", () => {
	const metrics = feed?.getMetrics();
	if (!metrics) return undefined;
	const processMetrics = app.getAppMetrics();
	const electronPrivateMemoryMb =
		processMetrics.reduce(
			(sum, metric) => sum + (metric.memory.privateBytes ?? metric.memory.workingSetSize),
			0
		) / 1024;
	const gpuProcessPrivateMemoryMb =
		(() => {
			const memory = processMetrics.find((metric) => metric.type === "GPU")?.memory;
			return memory ? (memory.privateBytes ?? memory.workingSetSize) : 0;
		})() / 1024;
	return {
		...metrics,
		electronPrivateMemoryMb,
		gpuProcessPrivateMemoryMb,
		presentationBudgetMbPerSecond,
		presentationFramesSent,
		presentationReplacements
	};
});
ipcMain.handle("camera:presentation-budget", (_event, value: unknown) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError("Presentation budget must be a finite number");
	}
	presentationBudgetMbPerSecond = Math.min(500, Math.max(25, value));
	return presentationBudgetMbPerSecond;
});
ipcMain.handle("camera:status", () => getCameraStatus(remoteControlEndpoint));
ipcMain.handle("camera:configure", (_event, config: CameraScheduleConfig) =>
	configureCameras(remoteControlEndpoint, config)
);

app.whenReady()
	.then(createWindow)
	.catch((error) => {
		console.error(error);
		app.quit();
	});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
	void feed?.close();
});
