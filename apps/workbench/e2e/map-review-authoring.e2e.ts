import { createRequire } from "node:module";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, test } from "./fixtures/workbench-test.js";
import { WorkbenchPage } from "./pages/workbench-page.js";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const enabled = process.env.UE_SHED_MAP_REVIEW_AUTHORING_E2E === "1" && endpoint !== undefined;
const require = createRequire(import.meta.url);
const electronExecutable: unknown = require("electron");
const workbenchRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureProjectRoot = resolve(
	fileURLToPath(new URL("../../../fixtures/unreal-project", import.meta.url))
);
const subjectPath = "/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewSubject";
const authoringSessionsRoot = join(fixtureProjectRoot, ".ue-shed", "review", "authoring-sessions");

if (typeof electronExecutable !== "string") {
	throw new TypeError("The Electron package did not resolve to an executable path");
}
const electronPath: string = electronExecutable;

async function editorActorCall(functionName: string, parameters: object): Promise<void> {
	const response = await fetch(`${endpoint}/remote/object/call`, {
		body: JSON.stringify({
			functionName,
			generateTransaction: false,
			objectPath: "/Script/UnrealEd.Default__EditorActorSubsystem",
			parameters
		}),
		headers: { "content-type": "application/json" },
		method: "PUT"
	});
	if (!response.ok)
		throw new Error(`Could not prepare fixture selection: HTTP ${response.status}`);
}

async function subjectCall(functionName: string, parameters: object): Promise<void> {
	const response = await fetch(`${endpoint}/remote/object/call`, {
		body: JSON.stringify({
			functionName,
			generateTransaction: false,
			objectPath: subjectPath,
			parameters
		}),
		headers: { "content-type": "application/json" },
		method: "PUT"
	});
	if (!response.ok) throw new Error(`Could not update ReviewSubject: HTTP ${response.status}`);
}

async function selectReviewSubject(): Promise<void> {
	await editorActorCall("SelectNothing", {});
	await editorActorCall("SetActorSelectionState", {
		Actor: subjectPath,
		bShouldBeSelected: true
	});
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

async function launchWorkbench(): Promise<{
	readonly application: ElectronApplication;
	readonly sessionRoot: string;
	readonly workbench: WorkbenchPage;
}> {
	const sessionRoot = await mkdtemp(join(tmpdir(), "ue-shed-workbench-e2e-authoring-"));
	const application = await electron.launch({
		args: [workbenchRoot],
		cwd: workbenchRoot,
		env: launchEnvironment({ UE_SHED_AUTHORING_SESSION_ROOT: sessionRoot }),
		executablePath: electronPath
	});
	const page = await application.firstWindow();
	return { application, sessionRoot, workbench: new WorkbenchPage(page) };
}

async function closeWorkbench(args: {
	readonly application: ElectronApplication;
	readonly sessionRoot: string;
}): Promise<void> {
	await args.application.close().catch(() => undefined);
	await rm(args.sessionRoot, { force: true, recursive: true });
}

async function clearAuthoringSessions(): Promise<void> {
	await rm(authoringSessionsRoot, { force: true, recursive: true }).catch(() => undefined);
}

async function startAuthoringFromSelection(workbench: WorkbenchPage): Promise<void> {
	await selectReviewSubject();
	await workbench.openRoute("Map Review");
	await workbench.page.getByRole("button", { name: "REFRAME SELECTED ACTOR" }).click();
	const candidates = workbench.page.getByRole("region", { name: "Framing candidates" });
	await expect(
		candidates.getByRole("button", { name: "Select Context three-quarter" })
	).toBeVisible({ timeout: 60_000 });
}

test.skip(!enabled, "set UE_SHED_MAP_REVIEW_AUTHORING_E2E=1 with a live editor endpoint");
test.setTimeout(90_000);

test("authors real candidate previews from the selected fixture subject", async ({
	workbench
}, testInfo) => {
	await clearAuthoringSessions();
	try {
		await workbench.expectShowcaseReady();
		await workbench.openRoute("Map Review");
		const refreshRate = workbench.page.getByRole("slider", { name: "World refresh rate" });
		await expect(refreshRate).toHaveValue("30");
		await refreshRate.fill("60");
		await expect(refreshRate).toHaveValue("60");
		await startAuthoringFromSelection(workbench);
		const candidates = workbench.page.getByRole("region", { name: "Framing candidates" });
		await expect(candidates.getByRole("button", { name: /^Select / })).toHaveCount(7);
		const preview = candidates.locator("canvas, img").first();
		await expect(preview).toBeVisible({ timeout: 30_000 });
		const width = await preview.evaluate((node) => {
			const previewNode = node as unknown as {
				readonly naturalWidth: number;
				readonly tagName: string;
				readonly width: number;
			};
			return previewNode.tagName === "CANVAS" ? previewNode.width : previewNode.naturalWidth;
		});
		expect(width).toBe(320);
		await workbench.page.screenshot({
			fullPage: true,
			path: testInfo.outputPath("map-review-authoring.png")
		});
	} finally {
		await editorActorCall("SelectNothing", {});
		await clearAuthoringSessions();
	}
});

test("recovers durable draft intent across Workbench restart and requires Reframe after bounds change", async ({
	browserName: _browserName
}, testInfo) => {
	test.setTimeout(180_000);
	await clearAuthoringSessions();
	await subjectCall("SetActorScale3D", { NewScale3D: { X: 4.5, Y: 2.8, Z: 3.6 } });
	let first: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
	let second: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
	try {
		first = await launchWorkbench();
		const { workbench } = first;
		await workbench.expectShowcaseReady();
		await startAuthoringFromSelection(workbench);
		const facade = workbench.page
			.getByRole("article")
			.filter({ has: workbench.page.getByRole("button", { name: "Select Facade front" }) });
		await facade.getByRole("button", { name: "Select Facade front" }).click();
		await facade.getByRole("button", { name: "DISCARD" }).click();
		await expect(
			workbench.page.getByRole("button", { name: "Select Facade front" })
		).toHaveCount(0);
		const note = workbench.page.getByRole("textbox", { name: "MANUAL ADJUSTMENT NOTE" });
		await note.fill("Recovered art direction note");
		await expect(note).toHaveValue("Recovered art direction note");
		const persisted = await readdir(authoringSessionsRoot);
		expect(persisted.some((name) => name.endsWith(".json"))).toBe(true);

		await closeWorkbench(first);
		first = undefined;

		second = await launchWorkbench();
		const recovered = second.workbench;
		await recovered.expectShowcaseReady();
		await recovered.openRoute("Map Review");
		await expect(recovered.page.getByText("Review Subject")).toBeVisible({ timeout: 60_000 });
		await expect(
			recovered.page.getByRole("textbox", { name: "MANUAL ADJUSTMENT NOTE" })
		).toHaveValue("Recovered art direction note");
		await expect(
			recovered.page.getByRole("button", { name: "Select Facade front" })
		).toHaveCount(0);
		await expect(
			recovered.page
				.getByRole("region", { name: "Framing candidates" })
				.locator("canvas, img")
				.first()
		).toBeVisible({ timeout: 60_000 });

		await subjectCall("SetActorScale3D", { NewScale3D: { X: 9, Y: 5.6, Z: 7.2 } });
		await recovered.openRoute("Data Authoring");
		await recovered.openRoute("Map Review");
		await expect(
			recovered.page.getByText(/no longer matches the live subject|Reframe before keeping/i)
		).toBeVisible({ timeout: 60_000 });
		await expect(recovered.page.getByRole("button", { name: "KEEP VIEW" })).toBeDisabled();
		await selectReviewSubject();
		await recovered.page.getByRole("button", { name: "REFRAME SELECTED ACTOR" }).click();
		await expect(recovered.page.getByRole("button", { name: "KEEP VIEW" })).toBeEnabled({
			timeout: 60_000
		});
		await recovered.page.screenshot({
			fullPage: true,
			path: testInfo.outputPath("map-review-recovery.png")
		});
	} finally {
		await subjectCall("SetActorScale3D", { NewScale3D: { X: 4.5, Y: 2.8, Z: 3.6 } }).catch(
			() => undefined
		);
		await editorActorCall("SelectNothing", {}).catch(() => undefined);
		if (first) await closeWorkbench(first);
		if (second) await closeWorkbench(second);
		await clearAuthoringSessions();
	}
});
