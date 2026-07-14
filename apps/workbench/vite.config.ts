import stylexModule, { type PluginOptions } from "@stylexjs/rollup-plugin";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const stylex = stylexModule as unknown as (options: PluginOptions) => Plugin;

export default defineConfig({
	base: "./",
	build: {
		outDir: "dist/renderer",
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
