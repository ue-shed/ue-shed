import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/camera-authoring-crash.recovery.test.ts"],
		maxWorkers: 1
	}
});
