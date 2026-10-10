import { configDefaults, defineProject } from "vitest/config";

export default defineProject({
	test: {
		environment: "node",
		exclude: [...configDefaults.exclude, "**/*.component.test.tsx", "apps/workbench/e2e/**"],
		include: [
			"{apps,extensions,fixtures,packages,tools}/**/*.{test,spec}.{ts,tsx}",
			"scripts/game-text-scale.test.ts",
			"scripts/game-text-dictionary.test.ts",
			"scripts/localization-import.test.ts",
			"scripts/package-text-reader.test.ts",
			"scripts/package-text-record.test.ts",
			"scripts/package-text-layer.test.ts",
			"scripts/columnar-join.test.ts"
		],
		name: "node"
	}
});
