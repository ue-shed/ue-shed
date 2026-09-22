import { ensureUassetExecutable } from "./native-tools.ts";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { createWorkbenchEnvironment, loadFixtureEditorMap, runPnpm } from "./workbench-tools.ts";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
if (!endpoint) {
	console.error(
		"Map Review full-flow evidence requires UE_SHED_REMOTE_CONTROL_ENDPOINT.\n" +
			"Start the gallery editor first:\n" +
			"  $env:UE_SHED_FIXTURE_AUTHORING_MAP='/Game/Fixture/MapReview/L_MapReviewFixture'\n" +
			"  pnpm fixture:launch-authoring"
	);
	process.exit(1);
}

await loadFixtureEditorMap(endpoint, "/Game/Fixture/MapReview/L_MapReviewFixture");
const fixture = Schema.decodeUnknownSync(
	Schema.Struct({
		mapReviewGallery: Schema.Struct({
			map: Schema.String,
			subjects: Schema.Struct({ compound: Schema.String })
		})
	})
)(
	JSON.parse(
		readFileSync(
			new URL("../fixtures/unreal-project/fixture-contract.json", import.meta.url),
			"utf8"
		)
	)
);

const environment = await createWorkbenchEnvironment({
	...process.env,
	UE_SHED_FIXTURE_AUTHORING_MAP: "/Game/Fixture/MapReview/L_MapReviewFixture",
	UE_SHED_MAP_REVIEW_FLOW_E2E: "1",
	UE_SHED_MAP_REVIEW_AUTHORING_E2E: "1",
	UE_SHED_CAMERA_WORKSPACE_TEST_MAP: fixture.mapReviewGallery.map,
	UE_SHED_CAMERA_WORKSPACE_TEST_ACTOR: fixture.mapReviewGallery.subjects.compound,
	UE_SHED_REMOTE_CONTROL_ENDPOINT: endpoint,
	UE_SHED_UASSET_EXECUTABLE: ensureUassetExecutable()
});

runPnpm(
	["--filter", "@ue-shed/workbench...", "--recursive", "--if-present", "run", "build"],
	environment
);

process.stdout.write(
	"[Map Review flow] RUN: camera-set creation, restart, 4/37-view capture and gallery rendering\n"
);
runPnpm(
	[
		"--filter",
		"@ue-shed/workbench",
		"exec",
		"playwright",
		"test",
		"--config",
		"e2e/playwright.config.ts",
		"e2e/map-review-authoring.e2e.ts",
		"e2e/map-review-gallery.e2e.ts"
	],
	environment
);
