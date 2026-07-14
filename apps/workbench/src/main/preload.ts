import type { CameraFeedMetrics, CameraFrame } from "@ue-shed/cameras";
import type { CameraScheduleConfig, CameraStatus } from "@ue-shed/protocol";
import { contextBridge, ipcRenderer } from "electron";

export interface RendererCameraFrame extends Omit<CameraFrame, "pixels" | "sequence"> {
	readonly pixels: Uint8Array;
	readonly sequence: string;
}

export interface WorkbenchCameraMetrics extends CameraFeedMetrics {
	readonly electronPrivateMemoryMb: number;
	readonly gpuProcessPrivateMemoryMb: number;
	readonly presentationBudgetMbPerSecond: number;
	readonly presentationFramesSent: number;
	readonly presentationReplacements: number;
}

contextBridge.exposeInMainWorld("ueShed", {
	configure: (config: CameraScheduleConfig): Promise<CameraStatus> =>
		ipcRenderer.invoke("camera:configure", config),
	getMetrics: (): Promise<WorkbenchCameraMetrics> => ipcRenderer.invoke("camera:metrics"),
	getStatus: (): Promise<CameraStatus> => ipcRenderer.invoke("camera:status"),
	setPresentationBudget: (megabytesPerSecond: number): Promise<number> =>
		ipcRenderer.invoke("camera:presentation-budget", megabytesPerSecond),
	onFrame: (listener: (frame: RendererCameraFrame) => void) => {
		const handler = (_event: Electron.IpcRendererEvent, frame: RendererCameraFrame) =>
			listener(frame);
		ipcRenderer.on("camera:frame", handler);
		return () => ipcRenderer.removeListener("camera:frame", handler);
	}
});
