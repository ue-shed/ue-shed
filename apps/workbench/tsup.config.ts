import { defineConfig } from "tsup";

export default defineConfig([
	{
		clean: false,
		entry: ["src/main/main.ts"],
		external: [/^electron(?:\/|$)/],
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
