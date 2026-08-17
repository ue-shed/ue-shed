import { defineConfig } from "tsup";

export default defineConfig([
	{
		banner: {
			js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
		},
		clean: false,
		entry: ["src/main/main.ts"],
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
