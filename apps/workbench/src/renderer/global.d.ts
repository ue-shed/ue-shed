import type { WorkbenchRendererApi } from "../main/preload-contract.js";

declare global {
	interface Window {
		readonly ueShed: WorkbenchRendererApi;
	}
}

export {};
