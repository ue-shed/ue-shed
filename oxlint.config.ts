import { defineConfig } from "oxlint";

import { effectCatchAllBaseline } from "./tools/oxlint/effect-catch-all-baseline.ts";

export default defineConfig({
	ignorePatterns: [
		".agent/**",
		".agents/**",
		".claude/**",
		".codex/**",
		".continue/**",
		".cursor/**",
		".gemini/**",
		".opencode/**",
		".pi/**",
		".roo/**",
		".windsurf/**",
		"tools/oxlint/anti-slop/**"
	],
	jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
	rules: {
		"anti-slop/no-chained-effect-flat-map": "error",
		"anti-slop/no-chained-type-assertions": "error",
		"anti-slop/no-conditional-empty-object-spread": "error",
		"anti-slop/no-effect-catch-all": "error",
		"anti-slop/no-known-value-widening": "error",
		"anti-slop/no-module-mocking": "error",
		"anti-slop/no-object-parameters": "error",
		"anti-slop/no-plan-phase-comments": "error",
		"anti-slop/no-reflect-apply": "error",
		"anti-slop/no-reflect-get": "error",
		"anti-slop/no-runtime-typeof": "error",
		"anti-slop/no-shape-in-symbol-names": "error",
		"anti-slop/no-stringified-cause-in-error": "error",
		"anti-slop/no-unknown-parameters": "error",
		"anti-slop/no-unknown-returns": "error",
		"anti-slop/no-unknown-type-aliases": "error",
		"anti-slop/no-unsafe-dictionary-type": "error",
		"anti-slop/no-widen-then-assert": "error",
		"anti-slop/prefer-effect-fn-pipeables": "error",
		"anti-slop/require-safety-comment-for-type-assertion": "error",
		"anti-slop/require-safety-verification": "error"
	},
	overrides: [
		{
			files: [...effectCatchAllBaseline],
			rules: { "anti-slop/no-effect-catch-all": "warn" }
		},
		{
			files: ["packages/protocol/src/**/*.ts", "packages/unreal-connection/src/**/*.ts"],
			rules: { "anti-slop/require-jsdoc-on-exports": "error" }
		},
		{
			files: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test-support.ts"],
			rules: { "anti-slop/require-jsdoc-on-exports": "off" }
		},
		{
			// No test reaches these deck.gl casts without a Deck factory seam, which would change the
			// component's API. Remove this override once a component test covers them.
			files: ["packages/ui/src/point-map-deck.tsx"],
			rules: { "anti-slop/require-safety-verification": "off" }
		}
	]
});
