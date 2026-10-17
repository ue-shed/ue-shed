import { configDefaults, defineProject } from "vitest/config";

export default defineProject({
	test: {
		maxWorkers: 4,
		// Tests that build a Game Text index take 2-3 s alone but pass 5 s on a hosted runner
		// running the whole suite in parallel; the slow ones already asked for 30 s one by one.
		testTimeout: 30_000,
		environment: "node",
		exclude: [...configDefaults.exclude, "**/*.component.test.tsx", "apps/workbench/e2e/**"],
		include: [
			"{apps,extensions,fixtures,packages,tools}/**/*.{test,spec}.{ts,tsx}",
			"scripts/game-text-scale.test.ts",
			"scripts/game-text-stage-timings.test.ts",
			"scripts/game-text-dictionary.test.ts",
			"scripts/localization-import.test.ts",
			"scripts/package-text-reader.test.ts",
			"scripts/package-import-usages.test.ts",
			"scripts/package-text-record.test.ts",
			"scripts/package-text-layer.test.ts",
			"scripts/columnar-join.test.ts",
			"scripts/columnar-join-fuzz.test.ts",
			"scripts/native-game-text-join.test.ts",
			"scripts/columnar-join-regressions.test.ts",
			"scripts/joined-column-chunks.test.ts"
		],
		name: "node"
	}
});
