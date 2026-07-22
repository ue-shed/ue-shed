import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
	createFakeFixtureLaunchHarness,
	type FakeFixtureLaunchHarness
} from "./fake-fixture-launch.js";

interface WorkbenchFixtures {
	readonly workbench: WorkbenchPage;
}

interface DemandLaunchFixtures {
	readonly demandLaunch: {
		readonly application: ElectronApplication;
		readonly harness: FakeFixtureLaunchHarness;
		readonly workbench: WorkbenchPage;
	};
}

const require = createRequire(import.meta.url);
const electronExecutable: unknown = require("electron");
const workbenchRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

if (typeof electronExecutable !== "string") {
	throw new TypeError("The Electron package did not resolve to an executable path");
}

async function closeApplication(application: ElectronApplication): Promise<void> {
	await application.close().catch(() => undefined);
}

function launchEnvironment(overrides: Readonly<Record<string, string>> = {}): {
	[key: string]: string;
} {
	if (!process.env.UE_SHED_UASSET_EXECUTABLE) {
		throw new Error("Launch Workbench E2E through pnpm test:e2e:workbench");
	}
	const environment: { [key: string]: string } = {
		ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
		...overrides
	};
	for (const [key, value] of Object.entries(process.env)) {
		if (key === "ELECTRON_RUN_AS_NODE" || value === undefined) continue;
		if (!(key in environment)) environment[key] = value;
	}
	return environment;
}

export const test = base.extend<WorkbenchFixtures>({
	workbench: async ({ browserName: _browserName }, use, testInfo) => {
		const sessionRoot = await mkdtemp(join(tmpdir(), "ue-shed-workbench-e2e-authoring-"));
		const application = await electron.launch({
			args: [workbenchRoot],
			cwd: workbenchRoot,
			env: launchEnvironment({ UE_SHED_AUTHORING_SESSION_ROOT: sessionRoot }),
			executablePath: electronExecutable
		});
		const page = await application.firstWindow();
		const workbench = new WorkbenchPage(page);
		await application
			.context()
			.tracing.start({ screenshots: true, snapshots: true, sources: true });

		try {
			await use(workbench);
		} finally {
			const failed = testInfo.status !== testInfo.expectedStatus;
			if (failed) {
				await page.screenshot({
					fullPage: true,
					path: testInfo.outputPath("workbench.png")
				});
				await application
					.context()
					.tracing.stop({ path: testInfo.outputPath("trace.zip") });
			} else {
				await application.context().tracing.stop();
			}
			await closeApplication(application);
			await rm(sessionRoot, { force: true, recursive: true });
		}
	}
});

export const demandLaunchTest = base.extend<DemandLaunchFixtures>({
	demandLaunch: async ({ browserName: _browserName }, use, testInfo) => {
		const sessionRoot = await mkdtemp(join(tmpdir(), "ue-shed-workbench-e2e-authoring-"));
		const harness = await createFakeFixtureLaunchHarness({
			launchDelayMs: 2_000,
			projectName: process.env.UE_SHED_PROJECT_NAME ?? "UEShedFixture"
		});
		const application = await electron.launch({
			args: [workbenchRoot],
			cwd: workbenchRoot,
			env: launchEnvironment({
				...harness.environment,
				UE_SHED_AUTHORING_SESSION_ROOT: sessionRoot
			}),
			executablePath: electronExecutable
		});
		const page = await application.firstWindow();
		const workbench = new WorkbenchPage(page);
		await application
			.context()
			.tracing.start({ screenshots: true, snapshots: true, sources: true });

		try {
			await use({ application, harness, workbench });
		} finally {
			const failed = testInfo.status !== testInfo.expectedStatus;
			try {
				if (failed) {
					await page
						.screenshot({
							fullPage: true,
							path: testInfo.outputPath("demand-launch.png")
						})
						.catch(() => undefined);
					await application
						.context()
						.tracing.stop({ path: testInfo.outputPath("trace.zip") })
						.catch(() => undefined);
				} else {
					await application
						.context()
						.tracing.stop()
						.catch(() => undefined);
				}
			} finally {
				await closeApplication(application);
				await harness.close();
				await rm(sessionRoot, { force: true, recursive: true });
			}
		}
	}
});

export { expect } from "@playwright/test";
