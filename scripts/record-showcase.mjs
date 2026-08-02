import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { createWorkbenchEnvironment, repositoryRoot, runPnpm } from "./workbench-tools.mjs";
import { startPerforceMapHistoryFixture } from "./test-perforce-map-history.mjs";

const supportedJourneys = ["saved-workflows", "map-review", "world-log", "world-log-fast"];
const argumentsAfterCommand = process.argv.slice(2);
const requestedJourney = argumentsAfterCommand.find((argument) => !argument.startsWith("--"));
const journey = requestedJourney ?? "saved-workflows";
const skipBuild = argumentsAfterCommand.includes("--no-build");

if (!supportedJourneys.includes(journey)) {
	throw new Error(
		`Unknown showcase journey "${journey}". Available journeys: ${supportedJourneys.join(", ")}.`
	);
}

function gitOutput(args) {
	const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

const recordedAt = new Date().toISOString();
const recordingId = `${recordedAt.replaceAll(/[-:.TZ]/g, "")}-${journey}-${randomUUID().slice(0, 8)}`;
const recordingRoot = resolve(
	repositoryRoot,
	process.env.UE_SHED_RECORDING_OUTPUT_ROOT ?? "test-results/showcase"
);
const resultRoot = join(recordingRoot, recordingId);

const fixture =
	journey === "world-log" || journey === "world-log-fast"
		? await startPerforceMapHistoryFixture()
		: undefined;

try {
	const {
		P4CONFIG: _configFile,
		P4ENVIRO: _environmentFile,
		...perforceEnvironment
	} = fixture?.environment ?? {};
	const environment = await createWorkbenchEnvironment({
		...process.env,
		...perforceEnvironment,
		...(journey === "map-review" && !process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT
			? { UE_SHED_REMOTE_CONTROL_ENDPOINT: "http://127.0.0.1:30001" }
			: {}),
		...(fixture
			? {
					UE_SHED_PROJECT_NAME: "World Log Perforce Fixture",
					UE_SHED_PROJECT_ROOT: fixture.projectRoot,
					UE_SHED_SAVED_WORLD_MAP: fixture.seeded.worldPartition.mapPath
				}
			: {}),
		UE_SHED_RECORDING_COMMIT: gitOutput(["rev-parse", "--short", "HEAD"]),
		UE_SHED_RECORDING_DIRTY: gitOutput(["status", "--porcelain"]) ? "true" : "false",
		UE_SHED_RECORDING_ID: recordingId,
		UE_SHED_RECORDING_JOURNEY: journey,
		UE_SHED_RECORDING_OUTPUT_DIR: resultRoot
	});

	if (!skipBuild) runPnpm(["--filter", "@ue-shed/workbench", "build"], environment);
	runPnpm(
		[
			"--filter",
			"@ue-shed/workbench",
			"exec",
			"playwright",
			"test",
			"--config",
			"e2e/recording/playwright.config.ts"
		],
		environment
	);

	const manifest = globSync("**/run.json", { cwd: resultRoot })[0];
	if (manifest) {
		process.stdout.write(`\nShowcase review bundle: ${join(resultRoot, dirname(manifest))}\n`);
	}
} finally {
	await fixture?.stop();
}
