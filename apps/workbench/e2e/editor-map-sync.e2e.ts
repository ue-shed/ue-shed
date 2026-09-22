import { createServer } from "node:http";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { Effect, Schema } from "effect";
import { decodeReviewSet } from "@ue-shed/cameras";
import { EditorWorldOpenRequest } from "@ue-shed/protocol";

const workbenchRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = resolve(workbenchRoot, "../../fixtures/unreal-project");
const executablePath = Schema.decodeUnknownSync(Schema.String)(
	createRequire(import.meta.url)("electron")
);

test("confirms cross-map review, waits for a slow editor and follows external map changes", async ({
	browserName: _browserName
}, testInfo) => {
	test.setTimeout(90_000);
	const root = await mkdtemp(join(tmpdir(), "ue-shed-editor-map-sync-"));
	const alpha = "/Game/Fixture/Cameras/L_CameraLoad";
	const beta = "/Game/Fixture/Scenarios/L_MovementGym";
	const contract = { name: "unreal-editor-world-control", version: { major: 1, minor: 0 } };
	let currentMap = alpha;
	let operation: EditorWorldOpenRequest | undefined;
	let complete = false;
	let begins = 0;
	let polls = 0;
	const snapshot = () => ({
		mapPath: currentMap,
		dirtyWorldPackages: [],
		playSessionActive: false
	});
	const server = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const input = Schema.decodeUnknownSync(
				Schema.Struct({
					functionName: Schema.String,
					parameters: Schema.optional(
						Schema.Struct({ RequestJson: Schema.optional(Schema.String) })
					)
				})
			)(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			const result = (() => {
				if (input.functionName === "GetCapabilityManifest")
					return {
						schemaVersion: 1,
						producerKind: "unreal_editor",
						projectName: "UEShedFixture",
						capabilities: [
							"editor.world-control.v1",
							"editor.world-control.async.v1",
							"editor.world-state.v1"
						],
						worldControlObjectPath: "/Script/Fixture.WorldControl"
					};
				if (input.functionName === "GetWorldState")
					return { contract, projectName: "UEShedFixture", snapshot: snapshot() };
				if (input.functionName === "BeginOpenMap") {
					operation = Schema.decodeUnknownSync(EditorWorldOpenRequest)(
						JSON.parse(input.parameters?.RequestJson ?? "{}")
					);
					begins++;
					return { ...operation, status: "pending" };
				} else if (input.functionName === "GetOpenMapStatus" && operation) {
					polls++;
					const before = snapshot();
					if (complete) currentMap = operation.targetMapPath;
					return complete
						? {
								...operation,
								status: "completed",
								result: {
									...operation,
									outcome: "opened",
									before,
									after: snapshot()
								}
							}
						: { ...operation, status: "running" };
				}
				return undefined;
			})();
			if (result === undefined) {
				response.writeHead(404).end();
				return;
			}
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ ResultJson: JSON.stringify(result) }));
		} catch {
			response.writeHead(400).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
		server.address()
	);
	let app: ElectronApplication | undefined;
	try {
		await copyFile(
			join(fixture, "UEShedFixture.uproject"),
			join(root, "UEShedFixture.uproject")
		);
		for (const path of [
			"Fixture/Cameras/L_CameraLoad.umap",
			"Fixture/Scenarios/L_MovementGym.umap"
		]) {
			await mkdir(join(root, "Content", path, ".."), { recursive: true });
			await copyFile(join(fixture, "Content", path), join(root, "Content", path));
		}
		const sets = join(root, ".ue-shed/review/sets");
		await mkdir(sets, { recursive: true });
		const template = await Effect.runPromise(
			decodeReviewSet(
				JSON.parse(
					await readFile(
						join(fixture, ".ue-shed/review/sets/fixture-structure.json"),
						"utf8"
					)
				)
			)
		);
		for (const [id, mapPath] of [
			["alpha", alpha],
			["beta", beta]
		] as const)
			await writeFile(
				join(sets, `${id}.json`),
				JSON.stringify({
					...template,
					id,
					displayName: `${id} review`,
					project: { ...template.project, mapPath },
					views: []
				})
			);
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env))
			if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
		Object.assign(env, {
			UE_SHED_PROJECT_ROOT: root,
			UE_SHED_PROJECT_NAME: "UEShedFixture",
			UE_SHED_REMEMBER_PROJECTS: "false",
			UE_SHED_CAMERA_PIPE_NAME: `\\\\.\\pipe\\ue-shed-editor-map-sync-${process.pid}`,
			UE_SHED_REVIEW_SET: join(sets, "alpha.json"),
			UE_SHED_REMOTE_CONTROL_ENDPOINT: `http://127.0.0.1:${address.port}`,
			UE_SHED_REPOSITORY_ROOT: resolve(workbenchRoot, "../.."),
			UE_SHED_SAVED_WORLD_MAPS:
				"Content/Fixture/Cameras/L_CameraLoad.umap;Content/Fixture/Scenarios/L_MovementGym.umap"
		});
		app = await electron.launch({
			executablePath,
			args: [workbenchRoot, `--user-data-dir=${join(root, "profile")}`],
			cwd: workbenchRoot,
			env
		});
		const page = await app.firstWindow();
		await page.waitForURL("file://**");
		await page.goto(page.url().split("#")[0] + "#/map-review");
		await page.setViewportSize({ width: 1280, height: 900 });
		await expect(page.getByRole("region", { name: "Editor map connection" })).toContainText(
			alpha
		);
		await page.getByRole("button", { name: "Saved views & captures", exact: true }).click();
		await page.getByRole("button", { name: "Open set", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Switch the map in Unreal?" });
		await expect(dialog).toBeVisible();
		expect(begins).toBe(0);
		await page.screenshot({ path: testInfo.outputPath("confirm-map-switch.png") });
		await dialog.getByRole("button", { name: "Switch map", exact: true }).click();
		await expect.poll(() => polls, { timeout: 20_000 }).toBeGreaterThanOrEqual(7);
		await expect(dialog).toContainText("Opening map in Unreal");
		expect(begins).toBe(1);
		complete = true;
		await expect(dialog).toBeHidden();
		await expect(page.getByRole("region", { name: "Editor map connection" })).toContainText(
			beta
		);
		currentMap = alpha;
		await expect(page.getByRole("region", { name: "Editor map connection" })).toContainText(
			"Saved map differs:"
		);
		await page.screenshot({ path: testInfo.outputPath("external-map-change.png") });
		await expect(page.getByRole("region", { name: "Review map mismatch" })).toContainText(beta);
		await expect(page.getByRole("button", { name: "Capture set", exact: true })).toBeDisabled();
		// A saved selection is not the displayed map while Live session follows Unreal.
		await page.getByRole("tab", { name: "Live session", exact: true }).click();
		await expect(page.getByRole("region", { name: "Editor map connection" })).not.toContainText(
			"Saved map differs:"
		);
		await expect(page.getByRole("region", { name: "Editor map connection" })).toContainText(
			alpha
		);
		await expect(
			page.getByRole("combobox", { name: "Open another map in Unreal" })
		).toContainText("Camera Load");
		await page.screenshot({ path: testInfo.outputPath("live-map-consistent.png") });
		await page.getByRole("tab", { name: "Saved map", exact: true }).click();
		await expect(page.getByRole("region", { name: "Editor map connection" })).toContainText(
			"Saved map differs:"
		);
		await page.getByRole("button", { name: "Follow editor map", exact: true }).click();
		await expect(page.getByRole("tab", { name: "Live session", exact: true })).toHaveAttribute(
			"aria-selected",
			"true"
		);
		await expect(page.getByRole("region", { name: "Editor map connection" })).not.toContainText(
			"Saved map differs:"
		);
		expect(begins).toBe(1);
		await expect(page.getByRole("region", { name: "Review map mismatch" })).toContainText(beta);
	} finally {
		await app?.close();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve()))
		);
		await rm(root, { recursive: true, force: true });
	}
});
