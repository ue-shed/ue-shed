import { cloudflare } from "@cloudflare/vite-plugin";
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

export default defineConfig(({ command }) => ({
	plugins: [
		solid(),
		stylex({
			fileName: "stylex.css",
			// The extracted stylesheet only exists for builds; inject rules at runtime in dev.
			runtimeInjection: command === "serve"
		}),
		{
			apply: "build",
			enforce: "post",
			name: "ue-shed-link-stylex",
			transformIndexHtml: () => [
				{
					attrs: { href: "./stylex.css", rel: "stylesheet" },
					tag: "link",
					injectTo: "head"
				}
			]
		},
		cloudflare()
	]
}));
