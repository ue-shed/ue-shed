import { expect, test, type TestInfo } from "@playwright/test";
import { Effect } from "effect";
import { runMapReviewAuthoringRoundtrip } from "../src/main/map-review-flow.js";
import {
	createMapReviewFlowHarness,
	makeMapReviewCheckpointCollector
} from "./map-review-flow-driver.js";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const enabled = process.env.UE_SHED_MAP_REVIEW_FLOW_E2E === "1" && endpoint !== undefined;
const keepViewsName = /^KEEP(?: \d+)? VIEWS?$/;

test.skip(
	!enabled,
	"run pnpm test:flow:map-review with a live fixture editor on the Map Review gallery"
);
test.setTimeout(600_000);

async function runFlow(
	flow: "authoring-roundtrip" | "high-count-rig",
	testInfo: TestInfo
): Promise<void> {
	if (endpoint === undefined) throw new Error("The live Map Review endpoint is unavailable.");
	const harness = await createMapReviewFlowHarness({
		artifactRoot: testInfo.outputDir,
		collection: flow === "authoring-roundtrip",
		endpoint,
		flow
	});
	const collector = makeMapReviewCheckpointCollector({
		harness,
		recording: false,
		testInfo
	});

	await Effect.runPromise(
		runMapReviewAuthoringRoundtrip({ driver: harness.driver, sink: collector.sink })
	);

	expect(collector.checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
		"fixture-ready",
		"subject-selected",
		"rig-generated",
		"rig-tuned",
		"candidate-previewed",
		"view-approved",
		"persistence-verified",
		"workbench-restarted",
		"view-loaded",
		"capture-completed",
		"evidence-inspected",
		"cleanup-verified"
	]);
	const evidence = collector.checkpoints.find(
		(checkpoint) => checkpoint.id === "evidence-inspected"
	);
	expect(evidence?.attachments).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				height: 720,
				kind: "raw-capture",
				width: 1280
			})
		])
	);
}

async function setActorScale(actorPath: string, scale: { x: number; y: number; z: number }) {
	if (endpoint === undefined) throw new Error("The live Map Review endpoint is unavailable.");
	const response = await fetch(`${endpoint}/remote/object/call`, {
		body: JSON.stringify({
			functionName: "SetActorScale3D",
			generateTransaction: false,
			objectPath: actorPath,
			parameters: { NewScale3D: { X: scale.x, Y: scale.y, Z: scale.z } }
		}),
		headers: { "content-type": "application/json" },
		method: "PUT",
		signal: AbortSignal.timeout(30_000)
	});
	if (!response.ok)
		throw new Error(`Could not scale the recovery subject: HTTP ${response.status}.`);
}

async function selectActor(actorPath: string): Promise<void> {
	if (endpoint === undefined) throw new Error("The live Map Review endpoint is unavailable.");
	for (const request of [
		{ functionName: "SelectNothing", parameters: {} },
		{
			functionName: "SetActorSelectionState",
			parameters: { Actor: actorPath, bShouldBeSelected: true }
		}
	]) {
		const response = await fetch(`${endpoint}/remote/object/call`, {
			body: JSON.stringify({
				...request,
				generateTransaction: false,
				objectPath: "/Script/UnrealEd.Default__EditorActorSubsystem"
			}),
			headers: { "content-type": "application/json" },
			method: "PUT",
			signal: AbortSignal.timeout(30_000)
		});
		if (!response.ok) {
			throw new Error(`Could not select the recovery subject: HTTP ${response.status}.`);
		}
	}
}

test("runs the complete Map Review authoring and persistence journey", async ({
	browserName: _browserName
}, testInfo) => {
	await runFlow("authoring-roundtrip", testInfo);
});

test("keeps a 37-candidate rig permissive through restart and capture", async ({
	browserName: _browserName
}, testInfo) => {
	await runFlow("high-count-rig", testInfo);
});

test("recovers persisted tuning after live subject bounds change", async ({
	browserName: _browserName
}, testInfo) => {
	if (endpoint === undefined) throw new Error("The live Map Review endpoint is unavailable.");
	const harness = await createMapReviewFlowHarness({
		artifactRoot: testInfo.outputDir,
		endpoint
	});
	const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
	const changedScale = {
		x: harness.subjectScale.x * 1.6,
		y: harness.subjectScale.y * 1.6,
		z: harness.subjectScale.z * 1.6
	};
	try {
		await run(harness.driver.prepareFixture());
		await run(harness.driver.selectSubject());
		await run(harness.driver.generateRig());
		await run(harness.driver.tuneRig());
		await run(harness.driver.previewCandidate());
		const authoringPage = harness.page();
		await authoringPage.getByRole("button", { exact: true, name: "Stop" }).click();
		await expect(authoringPage.getByRole("button", { exact: true, name: "Play" })).toBeVisible({
			timeout: 30_000
		});
		await run(harness.driver.relaunchWorkbench());
		await setActorScale(harness.subjectActorPath, changedScale);

		const page = harness.page();
		await page.getByRole("link", { exact: true, name: "Map Review" }).click();
		await page.getByRole("tab", { name: "Live session" }).click();
		await expect(
			page.getByText(/no longer matches the live subject|Reframe before keeping/i)
		).toBeVisible({ timeout: 60_000 });
		await expect(page.getByRole("button", { name: keepViewsName })).toBeDisabled();
		await selectActor(harness.subjectActorPath);
		await page.getByRole("button", { name: "REFRAME SELECTED ACTOR" }).click();
		await expect(page.getByRole("button", { name: keepViewsName })).toBeEnabled({
			timeout: 60_000
		});
		await expect(
			page.getByRole("spinbutton", { exact: true, name: "FOV OVERRIDE" })
		).toHaveValue("");
		await page.screenshot({
			fullPage: true,
			path: testInfo.outputPath("reframed-recovery.png")
		});
		await expect(
			page.getByRole("region", { name: "Framing candidates" }).locator("canvas, img").first()
		).toBeVisible({ timeout: 60_000 });
		await run(harness.driver.approveView());
		await run(harness.driver.verifyPersistence());
		await run(harness.driver.loadView());
		await run(harness.driver.captureView());
		await run(harness.driver.inspectEvidence());
	} finally {
		await setActorScale(harness.subjectActorPath, harness.subjectScale).catch(() => undefined);
		const cleanup = await run(harness.driver.cleanup());
		expect(cleanup).toMatchObject({
			mapDirtyAfter: false,
			provisionedCameraCountAfter: 0,
			status: "verified"
		});
	}
});
