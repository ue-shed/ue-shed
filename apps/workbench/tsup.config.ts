import { defineConfig } from "tsup";

export default defineConfig([
	{
		banner: {
			js: 'import { createRequire as createWorkbenchRequire } from "node:module"; const require = createWorkbenchRequire(import.meta.url);'
		},
		clean: false,
		entry: {
			main: "src/main/main.ts",
			"localization-import-worker":
				"../../packages/game-text/src/localization-import-worker.ts",
			"cold-layer-worker": "../../packages/game-text/src/cold-layer-worker.ts"
		},
		external: [/^electron(?:\/|$)/, "trash"],
		format: ["esm"],
		noExternal: [/^@ue-shed\//, "effect"],
		outDir: "dist/main",
		platform: "node",
		sourcemap: true,
		target: "node22"
	},
	{
		clean: false,
		entry: { preload: "src/main/preload.ts" },
		external: [/^electron(?:\/|$)/],
		format: ["cjs"],
		noExternal: [/^@ue-shed\//],
		outDir: "dist/main",
		outExtension: () => ({ js: ".cjs" }),
		platform: "node",
		sourcemap: true,
		target: "node22"
	}
]);
