import { createWorkbenchEnvironment, runPnpm } from "./workbench-tools.ts";

const buildOnly = process.argv.includes("--build-only");
const environment = await createWorkbenchEnvironment();

console.log(`Remote Control endpoint: ${environment.UE_SHED_REMOTE_CONTROL_ENDPOINT}`);

runPnpm(["--filter", "@ue-shed/workbench", "build"], environment);
if (!buildOnly) runPnpm(["--filter", "@ue-shed/workbench", "start"], environment);
