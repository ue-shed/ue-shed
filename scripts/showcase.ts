import {
	createCustodianShowcaseFixture,
	createWorkbenchEnvironment,
	runPnpm
} from "./workbench-tools.ts";

const buildOnly = process.argv.includes("--build-only");
const custodianFixture = process.env.UE_SHED_CUSTODIAN_ROOT
	? undefined
	: await createCustodianShowcaseFixture();
const environment = await createWorkbenchEnvironment({
	...process.env,
	UE_SHED_CUSTODIAN_ROOT: process.env.UE_SHED_CUSTODIAN_ROOT ?? custodianFixture?.root
});

console.log(`Remote Control endpoint: ${environment.UE_SHED_REMOTE_CONTROL_ENDPOINT}`);

try {
	runPnpm(["--filter", "@ue-shed/workbench", "build"], environment);
	if (!buildOnly) runPnpm(["--filter", "@ue-shed/workbench", "start"], environment);
} finally {
	await custodianFixture?.dispose();
}
