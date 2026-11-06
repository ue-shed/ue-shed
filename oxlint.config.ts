import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";

import { effectCatchAllBaseline } from "./tools/oxlint/effect-catch-all-baseline.ts";

export default defineConfig({
	extends: [recommended],
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
		"tools/oxlint/anti-slop/**",
		"tools/oxlint/t3code/**",
		"**/*.generated.ts"
	],
	jsPlugins: [
		{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
		{ name: "t3code", specifier: "./tools/oxlint/t3code/index.ts" }
	],
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
		"anti-slop/require-safety-verification": "error",
		"t3code/no-inline-schema-compile": "error",
		"t3code/no-low-value-comments": "error",
		"t3code/prefer-effect-fn": "error",
		"t3code/require-suppression-reason": "error"
	},
	overrides: [
		{
			// Tests build Effect programs inline; a span per test helper adds noise, not signal.
			files: [
				"**/*.{test,spec,testkit}.{ts,tsx}",
				"**/*.test-support.{ts,tsx}",
				"**/{test,tests,testkit,testing,fixtures,integration}/**"
			],
			rules: { "t3code/prefer-effect-fn": "off" }
		},
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
