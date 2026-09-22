import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { Schema } from "effect";
import {
	ReviewSet,
	CameraBridgeResponse,
	CameraArrangementId,
	CameraAuthoringDocument,
	type CameraBridgeRequest,
	ReviewSetId,
	CaptureProfileId,
	defaultNaturalOnlyVisibilityPolicy
} from "@ue-shed/cameras";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const enabled = process.env.UE_SHED_MAP_REVIEW_AUTHORING_E2E === "1" && endpoint !== undefined;
const workbenchRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(
	process.env.UE_SHED_PROJECT_ROOT ?? join(workbenchRoot, "../../fixtures/unreal-project")
);
const mapPath =
	process.env.UE_SHED_CAMERA_WORKSPACE_TEST_MAP ?? "/Game/Fixture/Cameras/L_CameraLoad";
const subjectPath =
	process.env.UE_SHED_CAMERA_WORKSPACE_TEST_ACTOR ??
	`${mapPath}.L_CameraLoad:PersistentLevel.ReviewSubject`;
const electronPath = Schema.decodeUnknownSync(Schema.String)(
	createRequire(import.meta.url)("electron")
);

test.skip(
	!enabled,
	"Requires the fixture editor with Camera Authoring plugins and UE_SHED_MAP_REVIEW_AUTHORING_E2E=1"
);
test.setTimeout(180_000);

test("first camera set creates its destination and can be reopened through the Review Set library", async ({
	browserName: _browserName
}, testInfo) => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-first-camera-set-"));
	const descriptor = (await readdir(projectRoot)).find((name) => name.endsWith(".uproject"));
	if (!descriptor) throw new Error("Fixture project descriptor missing");
	await copyFile(join(projectRoot, descriptor), join(root, descriptor));
	await mkdir(join(root, "Content"));
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env))
		if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE" && key !== "UE_SHED_REVIEW_SET")
			env[key] = value;
	Object.assign(env, {
		UE_SHED_PROJECT_ROOT: root,
		UE_SHED_REMEMBER_PROJECTS: "false",
		// This journey verifies authoring persistence, not frames; leave any user's feed alone.
		UE_SHED_CAMERA_PIPE_NAME: `\\\\.\\pipe\\ue-shed-first-set-${randomUUID()}`
	});
	let app: ElectronApplication | undefined;
	const launch = async () => {
		app = await electron.launch({
			executablePath: electronPath,
			args: [workbenchRoot, `--user-data-dir=${join(root, "profile")}`],
			cwd: workbenchRoot,
			env
		});
		const page = await app.firstWindow();
		await page.waitForURL("file://**");
		await page.goto(page.url().split("#")[0] + "#/map-review");
		await page.getByRole("tab", { name: "Live session", exact: true }).click();
		return page;
	};
	try {
		const selected = await fetch(`${endpoint}/remote/object/call`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				objectPath: "/Script/UnrealEd.Default__EditorActorSubsystem",
				functionName: "SetSelectedLevelActors",
				parameters: { ActorsToSelect: [subjectPath] },
				generateTransaction: false
			})
		});
		expect(selected.ok).toBe(true);
		let page = await launch();
		let workspace = page.getByRole("region", { name: "Camera workspace" });
		await expect(workspace.getByText("Choose a Review Set first.")).toHaveCount(0);
		await workspace
			.getByRole("button", { name: "Choose capture collection…", exact: true })
			.click();
		let library = page.getByRole("dialog", { name: "Saved views & captures" });
		await expect(library.getByRole("textbox", { name: "New review set name" })).toHaveCount(0);
		await library.getByRole("button", { name: "New camera set", exact: true }).click();
		await workspace.getByLabel("Set name", { exact: true }).fill("First camera setup");
		await workspace.getByLabel("Camera preset", { exact: true }).selectOption("Single");
		await workspace
			.getByRole("button", { name: "Create from Unreal selection", exact: true })
			.click();
		await expect(
			workspace.getByRole("button", { name: "Edit in Unreal ↗", exact: true })
		).toBeVisible({ timeout: 30_000 });
		await expect(workspace.getByRole("alert")).toHaveCount(0);
		const setsRoot = join(root, ".ue-shed/review/sets");
		expect(await readdir(setsRoot)).toHaveLength(1);
		await workspace.screenshot({ path: testInfo.outputPath("first-camera-set.png") });
		await workspace.getByRole("button", { name: "Close", exact: true }).click();
		await app!.close();
		app = undefined;
		page = await launch();
		workspace = page.getByRole("region", { name: "Camera workspace" });
		await workspace
			.getByRole("button", { name: "Choose capture collection…", exact: true })
			.click();
		library = page.getByRole("dialog", { name: "Saved views & captures" });
		await library.getByRole("button", { name: "Open set", exact: true }).click();
		await expect(library).toBeHidden();
		await workspace.getByRole("button", { name: /First camera setup.*1 cameras/ }).click();
		await expect(
			workspace.getByRole("button", { name: "Edit in Unreal ↗", exact: true })
		).toBeVisible();
		await workspace.getByRole("button", { name: "Close", exact: true }).click();
		await workspace
			.getByRole("button", { name: "Choose capture collection…", exact: true })
			.click();
		await expect(library.getByRole("textbox", { name: "New review set name" })).toBeEnabled();
		await library.screenshot({ path: testInfo.outputPath("review-set-library.png") });
		await library.getByRole("button", { name: "Return to set", exact: true }).click();
		await expect(library).toBeHidden();
		await page.goto(page.url().split("#")[0] + "#/showcase");
		// The Unreal menu submits this same public request: no Workbench Create/Layout clicks.
		const bridge = async (request: CameraBridgeRequest) => {
			const response = await fetch(`${endpoint}/remote/object/call`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					objectPath:
						"/Script/UEShedCameraAuthoringBridge.Default__UEShedCameraAuthoringBridgeLibrary",
					functionName: "ExecuteCameraAuthoring",
					parameters: { RequestJson: JSON.stringify(request) },
					generateTransaction: false
				})
			});
			expect(response.ok).toBe(true);
			const wire = Schema.decodeUnknownSync(Schema.Struct({ ResultJson: Schema.String }))(
				await response.json()
			);
			return Schema.decodeUnknownSync(CameraBridgeResponse)(JSON.parse(wire.ResultJson));
		};
		await expect
			.poll(async () => {
				const state = await bridge({ version: 1, operation: "setup_status" });
				return state.status === "setup" && state.connected;
			})
			.toBe(true);
		const queued = await bridge({
			version: 1,
			operation: "setup_create",
			intent: {
				id: CameraArrangementId.make(randomUUID()),
				actorPath: subjectPath,
				mapPath,
				name: "Native preset setup",
				layout: {
					kind: "orbit",
					count: 4,
					startDegrees: 0,
					spanDegrees: 360,
					orientation: "world"
				}
			}
		});
		expect(queued.status).toBe("setup");
		await expect
			.poll(async () => {
				const state = await bridge({ version: 1, operation: "setup_status" });
				return state.status !== "setup" || Boolean(state.request);
			})
			.toBe(false);
		await page.goto(page.url().split("#")[0] + "#/map-review");
		await page.getByRole("tab", { name: "Live session", exact: true }).click();
		await expect(
			workspace.getByText("Native preset setup", { exact: true }).first()
		).toBeVisible();
		const reviewDocument = Schema.decodeUnknownSync(Schema.Struct({ id: ReviewSetId }))(
			JSON.parse(await readFile(join(setsRoot, (await readdir(setsRoot))[0]!), "utf8"))
		);
		const cameraDirectory = join(
			root,
			".ue-shed/camera-sets",
			createHash("sha256").update(reviewDocument.id).digest("hex").slice(0, 20)
		);
		const documents = await Promise.all(
			(await readdir(cameraDirectory))
				.filter((name) => name.endsWith(".json"))
				.map(async (name) =>
					Schema.decodeUnknownSync(CameraAuthoringDocument)(
						JSON.parse(await readFile(join(cameraDirectory, name), "utf8"))
					)
				)
		);
		expect(
			documents.find((document) => document.arrangement.displayName === "Native preset setup")
				?.arrangement.cameras
		).toHaveLength(4);
		await workspace.getByRole("button", { name: "Close", exact: true }).click();
	} finally {
		await app?.close().catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
});

for (const cameraCount of [4, 37]) {
	test(`${cameraCount}-camera sets survive Workbench restart and capture their saved revisions`, async () => {
		test.setTimeout(360_000);
		const root = await mkdtemp(join(tmpdir(), "ue-shed-camera-workspace-"));
		const id = ReviewSetId.make(randomUUID());
		const reviewPath = join(root, "review.json");
		await writeFile(
			reviewPath,
			JSON.stringify(
				ReviewSet.make({
					contract: { name: "ue-shed-review-set", version: { major: 1, minor: 5 } },
					id,
					displayName: "Camera workspace journey",
					project: { id: "fixture", mapPath },
					captureProfiles: [
						{
							id: CaptureProfileId.make("capture"),
							imageFormat: "png",
							renderProfile: "full_fidelity",
							resolution: { width: 1280, height: 720 }
						}
					],
					visibilityPolicies: [defaultNaturalOnlyVisibilityPolicy()],
					views: []
				})
			)
		);
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env))
			if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
		Object.assign(env, {
			UE_SHED_PROJECT_ROOT: projectRoot,
			UE_SHED_REVIEW_SET: reviewPath,
			UE_SHED_REMEMBER_PROJECTS: "false"
		});
		const cameraRoot = resolve(projectRoot, ".ue-shed/camera-sets");
		const draftRoot = resolve(
			cameraRoot,
			createHash("sha256").update(id).digest("hex").slice(0, 20)
		);
		if (!draftRoot.startsWith(cameraRoot + "/") && !draftRoot.startsWith(cameraRoot + "\\"))
			throw new Error("Unexpected camera test path");
		let app: ElectronApplication | undefined;
		const launch = async () => {
			app = await electron.launch({
				executablePath: electronPath,
				args: [workbenchRoot, `--user-data-dir=${join(root, "profile")}`],
				cwd: workbenchRoot,
				env
			});
			const page = await app.firstWindow();
			await page.waitForURL("file://**");
			await page.goto(page.url().split("#")[0] + "#/map-review");
			return page;
		};
		try {
			for (const [functionName, parameters] of [
				["SelectNothing", {}],
				["SetActorSelectionState", { Actor: subjectPath, bShouldBeSelected: true }]
			] as const) {
				const response = await fetch(`${endpoint}/remote/object/call`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						objectPath: "/Script/UnrealEd.Default__EditorActorSubsystem",
						functionName,
						parameters,
						generateTransaction: false
					})
				});
				expect(response.ok).toBe(true);
			}
			let page = await launch();
			let workspace = page.getByRole("region", { name: "Camera workspace" });
			await workspace.getByRole("button", { name: "New camera set", exact: true }).click();
			await workspace.getByLabel("Set name").fill("Assembly cameras");
			await workspace
				.getByRole("button", { name: "Create from Unreal selection", exact: true })
				.click();
			await workspace.getByRole("button", { name: "Layout", exact: true }).click();
			await workspace.getByRole("button", { name: "Cardinals", exact: true }).click();
			await workspace.getByLabel("Cameras", { exact: true }).fill(String(cameraCount));
			await workspace.getByLabel("Cameras", { exact: true }).press("Tab");
			await workspace.getByRole("button", { name: "Preview layout", exact: true }).click();
			await workspace.getByRole("button", { name: "Apply layout", exact: true }).click();
			await expect(workspace.getByRole("button", { name: /orbit \d+.*Fitted/ })).toHaveCount(
				cameraCount
			);
			// Keep viewport input independent from the host-only settings/restart journey.
			await workspace.getByRole("button", { name: "Stop piloting", exact: true }).click();
			await expect(workspace.getByRole("button", { name: "Stop piloting" })).toBeEnabled();
			await workspace.getByRole("button", { name: "Framing", exact: true }).click();
			await workspace.getByLabel("FOV", { exact: true }).fill("45");
			await workspace.getByLabel("FOV", { exact: true }).press("Tab");
			await expect(
				workspace.getByRole("button", { name: "Save views", exact: true })
			).toBeEnabled();
			await workspace.getByRole("button", { name: "This camera", exact: true }).click();
			await workspace.getByLabel("FOV", { exact: true }).fill("32");
			await workspace.getByLabel("FOV", { exact: true }).press("Tab");
			await expect(workspace.getByRole("button", { name: "Reset FOV" })).toBeVisible();
			await workspace.getByRole("button", { name: "Capture", exact: true }).click();
			await workspace.getByLabel("Exposure", { exact: true }).selectOption("fixed_ev100");
			await expect(workspace.getByLabel("EV100", { exact: true })).toBeVisible();
			await workspace
				.getByRole("combobox", { name: "Output", exact: true })
				.selectOption("natural_and_authored");
			await workspace.getByRole("button", { name: "Save views", exact: true }).click();
			await expect
				.poll(async () => JSON.parse(await readFile(reviewPath, "utf8")).views.length)
				.toBe(cameraCount);
			await workspace.getByRole("button", { name: "Close", exact: true }).click();
			await expect(workspace.getByRole("button", { name: /Edit in Unreal/ })).toHaveCount(0);
			await app!.close();
			app = undefined;
			page = await launch();
			workspace = page.getByRole("region", { name: "Camera workspace" });
			await workspace
				.getByRole("button", {
					name: new RegExp(`Assembly cameras.*${cameraCount} cameras`)
				})
				.click();
			await workspace.getByRole("button", { name: "This camera", exact: true }).click();
			await expect(workspace.getByLabel("FOV", { exact: true })).toHaveValue("32");
			await workspace.getByRole("button", { name: "Whole set", exact: true }).click();
			await expect(workspace.getByLabel("FOV", { exact: true })).toHaveValue("45");
			await expect(workspace.getByText("Live", { exact: true })).toBeVisible();
			await workspace.getByRole("button", { name: "Capture…", exact: true }).click();
			await page.getByRole("button", { name: /REVIEW CAPTURE PLAN/ }).click();
			await page
				.getByRole("button", { name: `CAPTURE ${cameraCount} VIEWS`, exact: true })
				.click();
			const completed = page.getByRole("region", { name: "Capture complete" });
			await expect(completed).toBeVisible({ timeout: 240_000 });
			await expect(completed).toContainText(`${cameraCount}/${cameraCount}`);
			await expect(completed).toContainText(/0\s*Failed/);
		} finally {
			await app?.close().catch(() => undefined);

			await rm(draftRoot, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		}
	});
}
