import { ensureUassetExecutable } from "./native-tools.mjs";
import { createWorkbenchEnvironment, loadFixtureEditorMap, runPnpm } from "./workbench-tools.mjs";

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

const environment = await createWorkbenchEnvironment({
	...process.env,
	UE_SHED_FIXTURE_AUTHORING_MAP: "/Game/Fixture/MapReview/L_MapReviewFixture",
	UE_SHED_MAP_REVIEW_FLOW_E2E: "1",
	UE_SHED_REMOTE_CONTROL_ENDPOINT: endpoint,
	UE_SHED_UASSET_EXECUTABLE: ensureUassetExecutable()
});

runPnpm(["--filter", "@ue-shed/workbench", "build"], environment);

process.stdout.write(
	"[Map Review flow] RUN: authoring-roundtrip against live UE fixture gallery\n"
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
		"e2e/map-review-flow.e2e.ts",
		"e2e/map-review-gallery.e2e.ts"
	],
	environment
);
