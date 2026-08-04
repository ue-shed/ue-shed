import stylexModule, { type PluginOptions } from "@stylexjs/rollup-plugin";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";
import { defineProject } from "vitest/config";

const stylex = stylexModule as unknown as (options: PluginOptions) => Plugin;

export default defineProject({
	plugins: [solid({ hot: false }), stylex({ fileName: "stylex.css" })],
	ssr: { noExternal: ["peculiar-sheets"] },
	test: {
		environment: "jsdom",
		include: [
			"apps/workbench/**/*.component.test.tsx",
			"extensions/**/*.component.test.tsx",
			"packages/ui/**/*.component.test.tsx"
		],
		name: "component"
	}
});
