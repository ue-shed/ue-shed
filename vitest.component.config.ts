import stylexModule, { type PluginOptions } from "@stylexjs/rollup-plugin";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";
import { defineProject } from "vitest/config";

function isStylexPluginFactory<Value>(
	value: Value
): value is Value & ((options: PluginOptions) => Plugin) {
	return value instanceof Function;
}

const stylex = (options: PluginOptions): Plugin => {
	if (!isStylexPluginFactory(stylexModule)) {
		throw new TypeError("The StyleX Rollup plugin did not export its plugin factory.");
	}
	return stylexModule(options);
};

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
