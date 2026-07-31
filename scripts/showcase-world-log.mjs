import { createWorkbenchEnvironment, runPnpm } from "./workbench-tools.mjs";
import { startPerforceMapHistoryFixture } from "./test-perforce-map-history.mjs";

const buildOnly = process.argv.includes("--build-only");
const fixture = await startPerforceMapHistoryFixture();
let interrupted = false;
const markInterrupted = () => {
	interrupted = true;
};

process.once("SIGINT", markInterrupted);
process.once("SIGTERM", markInterrupted);

try {
	const {
		P4CONFIG: _configFile,
		P4ENVIRO: _environmentFile,
		...perforceEnvironment
	} = fixture.environment;
	const environment = await createWorkbenchEnvironment({
		...perforceEnvironment,
		UE_SHED_PROJECT_NAME: "World Log Perforce Fixture",
		UE_SHED_PROJECT_ROOT: fixture.projectRoot,
		UE_SHED_SAVED_WORLD_MAP: fixture.seeded.worldPartition.mapPath
	});

	console.log(`World Log fixture: ${fixture.seeded.worldPartition.mapPath}`);
	console.log(`Remote Control endpoint: ${environment.UE_SHED_REMOTE_CONTROL_ENDPOINT}`);
	console.log("Open World Log, choose Map History World, and run the scan.");

	runPnpm(["--filter", "@ue-shed/workbench", "build"], environment);
	if (!buildOnly) runPnpm(["--filter", "@ue-shed/workbench", "start"], environment);
	if (interrupted) throw new Error("World Log showcase was interrupted.");
} finally {
	process.removeListener("SIGINT", markInterrupted);
	process.removeListener("SIGTERM", markInterrupted);
	await fixture.stop();
}
