import stylexModule, { type PluginOptions } from "@stylexjs/rollup-plugin";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

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

export default defineConfig({
	base: "./",
	build: {
		outDir: "dist/demo",
		emptyOutDir: true
	},
	plugins: [
		solid(),
		stylex({ fileName: "stylex.css" }),
		{
			enforce: "post",
			name: "ue-shed-link-stylex",
			transformIndexHtml: () => [
				{
					attrs: { href: "./stylex.css", rel: "stylesheet" },
					tag: "link",
					injectTo: "head"
				}
			]
		}
	]
});
