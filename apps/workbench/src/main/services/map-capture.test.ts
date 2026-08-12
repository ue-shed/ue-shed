import { MapCaptureRepositoryLive, mapCapturePlansRoot } from "@ue-shed/cameras";
import { it } from "@effect/vitest";
import { makeEditorWorldControlTestLayer } from "@ue-shed/engine-discovery";
import { Effect, Layer } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect } from "vitest";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import {
	makeWorkbenchConfigurationLayer,
	type WorkbenchConfigurationShape
} from "../workbench-config.js";
import { WorkbenchMapCapture, WorkbenchMapCaptureLive } from "./map-capture.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const configuration: WorkbenchConfigurationShape = {
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "not_configured" },
	remoteControlEndpoint: "http://127.0.0.1:30010",
	review: { status: "not_configured" },
	sourceCheckout: { status: "not_configured" },
	textureAuditRules: { status: "not_configured" },
	unrealEngineRoot: { status: "not_configured" }
};

function mapCaptureLayer(projectRoot: string) {
	const project = makeWorkbenchProjectTestLayer({
		choose: () => Effect.die("not used"),
		current: () => Effect.die("not used"),
		inputAtlas: () => Effect.die("not used"),
		savedProject: () =>
			Effect.succeed({
				maps: [{ label: "City", mapPath: "Content/Maps/L_City.umap" }],
				projectRoot
			}),
		savedTables: () => Effect.die("not used"),
		selectedProject: () => Effect.succeed({ projectName: "City Project", projectRoot })
	});
	const dialog = Layer.succeed(
		ElectronDialog,
		ElectronDialog.of({
			chooseDirectory: () => Effect.die("not used"),
			chooseFile: () => Effect.die("not used"),
			chooseFiles: () => Effect.die("not used"),
			chooseSaveFile: () => Effect.die("not used")
		})
	);
	const worldControl = makeEditorWorldControlTestLayer({ open: () => Effect.die("not used") });
	return WorkbenchMapCaptureLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				MapCaptureRepositoryLive,
				project,
				dialog,
				worldControl,
				makeWorkbenchConfigurationLayer(configuration)
			)
		)
	);
}

it.effect(
	"authors a default plan from project maps and saves it through the public repository",
	() =>
		Effect.gen(function* () {
			const projectRoot = yield* Effect.promise(() =>
				mkdtemp(join(tmpdir(), "ue-shed-map-author-"))
			);
			roots.push(projectRoot);
			const result = yield* Effect.gen(function* () {
				const service = yield* WorkbenchMapCapture;
				const created = yield* service.newPlan();
				if (created.status !== "ready") return created;
				return yield* service.savePlan({ plan: created.plan, saveAs: false });
			}).pipe(Effect.provide(mapCaptureLayer(projectRoot)));

			expect(result.status).toBe("saved");
			if (result.status !== "saved") return;
			expect(result.plan.project).toEqual({
				id: "City-Project",
				mapPath: "/Game/Maps/L_City"
			});
			expect(result.planPath).toBe(
				join(mapCapturePlansRoot(projectRoot), "map-overview.json")
			);
			expect(
				JSON.parse(yield* Effect.promise(() => readFile(result.planPath, "utf8")))
			).toEqual(result.plan);
		})
);
