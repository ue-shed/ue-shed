import { configDefaults, defineProject } from "vitest/config";

export default defineProject({
	test: {
		environment: "node",
		exclude: [...configDefaults.exclude, "**/*.component.test.tsx", "apps/workbench/e2e/**"],
		include: ["{apps,extensions,fixtures,packages,tools}/**/*.{test,spec}.{ts,tsx}"],
		name: "node"
	}
});
