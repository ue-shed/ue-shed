export * from "./types.js";

export declare function createBrowserRuntime(
	options?: import("./types.js").BrowserRuntimeOptions
): Promise<import("./types.js").WasmRuntime>;

export declare const initBrowser: typeof createBrowserRuntime;
export declare const limits: import("./types.js").RuntimeLimits;
export declare function inspect(
	path: string,
	bytes: Uint8Array
): Promise<import("./types.js").InspectionResult>;
export declare function extractText(
	path: string,
	bytes: Uint8Array
): Promise<import("./types.js").TextResult>;
export declare function extractTextures(
	path: string,
	bytes: Uint8Array
): Promise<import("./types.js").TextureResult>;
export declare function version(): Promise<string>;
