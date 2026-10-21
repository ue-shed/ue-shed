import { configDefaults, defineProject } from "vitest/config";

export default defineProject({
	test: {
		maxWorkers: 4,
		// Tests that build a Game Text index take 2-3 s alone but pass 5 s on a hosted runner
		// running the whole suite in parallel; the slow ones already asked for 30 s one by one.
		testTimeout: 30_000,
		environment: "node",
		exclude: [
			...configDefaults.exclude,
			"**/*.component.test.tsx",
			"**/*.recovery.test.ts",
			"**/*.perf.test.ts",
			"apps/workbench/e2e/**",
			...(process.env.UE_SHED_HOST_RESPONSIVENESS === "1"
				? []
				: ["packages/game-text/src/host-responsiveness.test.ts"])
		],
		include: [
			"{apps,extensions,fixtures,packages,tools}/**/*.{test,spec}.{ts,tsx}",
			"scripts/game-text-corpus.test.ts",
			"scripts/game-text-scale.test.ts",
			"scripts/game-text-stage-timings.test.ts",
			"scripts/game-text-scale-safety.test.ts",
			...(process.env.UE_SHED_GAME_TEXT_BENCHMARK === "1"
				? ["scripts/game-text-benchmark.integration.test.ts"]
				: []),
			"scripts/localization-import.test.ts",
			"scripts/package-text-reader.test.ts",
			"scripts/package-import-usages.test.ts",
			"scripts/package-text-record.test.ts",
			"scripts/package-text-layer.test.ts",
			"scripts/columnar-join.test.ts",
			"scripts/generate-text-problem-rules.test.ts",
			"scripts/columnar-join-fuzz.test.ts",
			// `pnpm test:game-text:fuzz` sets this to run the seeded sweep outside the ordinary suite.
			...(process.env.UE_SHED_JOIN_FUZZ_SWEEP === "1"
				? ["scripts/columnar-join-fuzz-sweep.test.ts"]
				: []),
			"scripts/native-game-text-join.test.ts",
			"scripts/native-game-text-fixtures.integration.test.ts",
			"scripts/columnar-join-regressions.test.ts",
			"scripts/joined-column-chunks.test.ts"
		],
		name: "node"
	}
});
