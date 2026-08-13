import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { globSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	createWorkbenchEnvironment,
	loadFixtureEditorMap,
	repositoryRoot,
	runPnpm
} from "./workbench-tools.ts";

const args = process.argv.slice(2);
const flowFlag = args.indexOf("--flow");
const flow = flowFlag === -1 ? "authoring-roundtrip" : args[flowFlag + 1];
if (flow !== "authoring-roundtrip" && flow !== "high-count-rig") {
	throw new Error(
		`Flow "${flow ?? ""}" is not implemented yet. Available: authoring-roundtrip, high-count-rig.`
	);
}
const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
if (!endpoint) {
	console.error(
		"Map Review recording requires UE_SHED_REMOTE_CONTROL_ENDPOINT.\n" +
			"Start the gallery editor first:\n" +
			"  $env:UE_SHED_FIXTURE_AUTHORING_MAP='/Game/Fixture/MapReview/L_MapReviewFixture'\n" +
			"  pnpm fixture:launch-authoring"
	);
	process.exit(1);
}

await loadFixtureEditorMap(endpoint, "/Game/Fixture/MapReview/L_MapReviewFixture");

function gitOutput(gitArgs: readonly string[]) {
	const result = spawnSync("git", gitArgs, { encoding: "utf8", windowsHide: true });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

const recordedAt = new Date().toISOString();
const recordingId = `${recordedAt.replaceAll(/[-:.TZ]/g, "")}-${flow}-${randomUUID().slice(0, 8)}`;
const recordingRoot = resolve(
	repositoryRoot,
	process.env.UE_SHED_RECORDING_OUTPUT_ROOT ?? "test-results/map-review-flows"
);
const resultRoot = join(recordingRoot, recordingId);
const environment = await createWorkbenchEnvironment({
	...process.env,
	UE_SHED_FIXTURE_AUTHORING_MAP: "/Game/Fixture/MapReview/L_MapReviewFixture",
	UE_SHED_MAP_REVIEW_FLOW: flow,
	UE_SHED_MAP_REVIEW_FLOW_RECORDING: "1",
	UE_SHED_RECORDING_COMMIT: gitOutput(["rev-parse", "--short", "HEAD"]),
	UE_SHED_RECORDING_DIRTY: gitOutput(["status", "--porcelain"]) ? "true" : "false",
	UE_SHED_RECORDING_ID: recordingId,
	UE_SHED_RECORDING_OUTPUT_DIR: resultRoot,
	UE_SHED_REMOTE_CONTROL_ENDPOINT: endpoint
});

runPnpm(["--filter", "@ue-shed/workbench", "build"], environment);
runPnpm(
	[
		"--filter",
		"@ue-shed/workbench",
		"exec",
		"playwright",
		"test",
		"--config",
		"e2e/recording/playwright.config.ts",
		"map-review-flow.recording.ts"
	],
	environment
);

const manifest = globSync("**/manifest.json", { cwd: resultRoot })[0];
if (!manifest) throw new Error(`The recording completed without a manifest beneath ${resultRoot}.`);
process.stdout.write(`\nMap Review flow bundle: ${join(resultRoot, dirname(manifest))}\n`);
