import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { Schema } from "effect";
import {
	ReviewSet,
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

test("camera sets survive Workbench restart and capture their saved revisions", async () => {
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
		await workspace.getByRole("button", { name: "New set", exact: true }).click();
		await workspace.getByLabel("Set name").fill("Assembly cameras");
		await workspace
			.getByRole("button", { name: "Create from Unreal selection", exact: true })
			.click();
		await workspace.getByRole("button", { name: "Layout", exact: true }).click();
		await workspace.getByRole("button", { name: "Cardinals", exact: true }).click();
		await workspace.getByRole("button", { name: "Preview layout", exact: true }).click();
		await workspace.getByRole("button", { name: "Apply layout", exact: true }).click();
		await expect(workspace.getByRole("button", { name: /orbit [1-4].*Fitted/ })).toHaveCount(4);
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
			.toBe(4);
		await workspace.getByRole("button", { name: "Close", exact: true }).click();
		await expect(workspace.getByRole("button", { name: /Edit in Unreal/ })).toHaveCount(0);
		await app!.close();
		app = undefined;
		page = await launch();
		workspace = page.getByRole("region", { name: "Camera workspace" });
		await workspace.getByRole("button", { name: /Assembly cameras.*4 cameras/ }).click();
		await workspace.getByRole("button", { name: "This camera", exact: true }).click();
		await expect(workspace.getByLabel("FOV", { exact: true })).toHaveValue("32");
		await workspace.getByRole("button", { name: "Whole set", exact: true }).click();
		await expect(workspace.getByLabel("FOV", { exact: true })).toHaveValue("45");
		await expect(workspace.getByText("Live", { exact: true })).toBeVisible();
		await workspace.getByRole("button", { name: "Capture…", exact: true }).click();
		await page.getByRole("button", { name: /REVIEW CAPTURE PLAN/ }).click();
		await page.getByRole("button", { name: "CAPTURE 4 VIEWS", exact: true }).click();
		const completed = page.getByRole("region", { name: "Capture complete" });
		await expect(completed).toBeVisible({ timeout: 90_000 });
		await expect(completed).toContainText("4/4");
		await expect(completed).toContainText(/0\s*Failed/);
	} finally {
		await app?.close().catch(() => undefined);

		await rm(draftRoot, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
});
