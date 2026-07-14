import type { CameraScheduleConfig, CameraStatus } from "@ue-shed/protocol";
import type {
	RendererCameraFrame,
	ShowcaseContext,
	WorkbenchCameraMetrics
} from "../main/preload.js";

declare global {
	interface Window {
		readonly ueShed: {
			readonly showcase: {
				readonly context: () => Promise<ShowcaseContext>;
				readonly copy: (value: string) => Promise<void>;
			};
			readonly assetAudits: {
				readonly loadConfiguredProject: () => Promise<unknown>;
				readonly chooseProjectAndScan: () => Promise<unknown>;
			};
			readonly configure: (config: CameraScheduleConfig) => Promise<CameraStatus>;
			readonly getMetrics: () => Promise<WorkbenchCameraMetrics>;
			readonly getStatus: () => Promise<CameraStatus>;
			readonly onFrame: (listener: (frame: RendererCameraFrame) => void) => () => void;
			readonly setPresentationBudget: (megabytesPerSecond: number) => Promise<number>;
		};
	}
}

export {};
