import { expect, demandLaunchTest as test } from "./fixtures/workbench-test.js";

test("startup does not invoke the fixture launcher", async ({ demandLaunch }) => {
	const { harness, workbench } = demandLaunch;
	await workbench.expectShowcaseReady();
	await expect.poll(async () => harness.markerExists()).toBe(false);
	expect(await harness.launchCount()).toBe(0);
});

test("concurrent launch clicks invoke the fixture launcher once", async ({ demandLaunch }) => {
	const { harness, workbench } = demandLaunch;
	await workbench.expectShowcaseReady();
	expect(await harness.markerExists()).toBe(false);

	await workbench.openRoute("Camera Lab");
	const launch = workbench.page.getByRole("button", { name: "LAUNCH CAMERA FIXTURE" });
	await expect(launch).toBeVisible();
	// Drive the same preload API twice before either call settles so Cache dedupe is forced.
	await workbench.page.evaluate(
		"Promise.all([window.ueShed.fixture.launch(), window.ueShed.fixture.launch()])"
	);

	await expect.poll(async () => harness.launchCount(), { timeout: 30_000 }).toBe(1);
	await expect(launch).toBeVisible();
});

test("closing during an in-flight launch exits cleanly", async ({ demandLaunch }) => {
	test.setTimeout(60_000);
	const { application, harness, workbench } = demandLaunch;
	await workbench.expectShowcaseReady();
	await workbench.openRoute("Camera Lab");
	const launch = workbench.page.getByRole("button", { name: "LAUNCH CAMERA FIXTURE" });
	await expect(launch).toBeVisible();
	await launch.click();
	await expect(workbench.page.getByRole("button", { name: "Launching fixture…" })).toBeVisible();

	await application.close();
	await expect
		.poll(async () => {
			try {
				return application.windows().length;
			} catch {
				return 0;
			}
		})
		.toBe(0);
	// Launch may or may not have finished writing the marker; the invariant is clean exit.
	expect(await harness.launchCount()).toBeLessThanOrEqual(1);
});
