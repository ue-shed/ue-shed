export * from "./types.js";

export declare function createNodeRuntime(
	options?: import("./types.js").RuntimeOptions
): import("./types.js").WasmRuntime;

export declare const limits: import("./types.js").RuntimeLimits;
export declare const inspect: import("./types.js").WasmRuntime["inspect"];
export declare const extractText: import("./types.js").WasmRuntime["extractText"];
export declare const extractTextures: import("./types.js").WasmRuntime["extractTextures"];
export declare const extractLevelSequences: import("./types.js").WasmRuntime["extractLevelSequences"];
export declare const extractBlueprints: import("./types.js").WasmRuntime["extractBlueprints"];
export declare const version: import("./types.js").WasmRuntime["version"];
