import stylexModule, { type PluginOptions } from "@stylexjs/rollup-plugin";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { isBuiltin } from "node:module";

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
		outDir: "dist/renderer",
		emptyOutDir: true
	},
	plugins: [
		{
			name: "ue-shed-browser-boundary",
			enforce: "pre",
			resolveId(source, importer) {
				if (isBuiltin(source) || source === "electron") {
					this.error(
						`Browser code imported ${source} from ${importer ?? "entry"}. Use a browser contract or host client.`
					);
				}
				return null;
			}
		},
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
