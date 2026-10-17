import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assembleReleasePlan } from "@changesets/assemble-release-plan";
import { readConfig } from "@changesets/config";
import { readChangesets } from "@changesets/read";
import { readPreState } from "@changesets/pre";
import { getPackages } from "@manypkg/get-packages";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Validate every accumulated note with Changesets, without requiring Git history or a base ref. */
export async function checkReleasePlan(root: string = repositoryRoot) {
	const packages = await getPackages(root);
	const configured = await readConfig(root, packages);
	if (configured.errors)
		throw new Error(`Release configuration is invalid: ${configured.errors.join("; ")}`);
	const changesets = await readChangesets(root);
	const preState = await readPreState(root);
	return {
		...assembleReleasePlan(changesets, packages, configured.config, preState),
		warnings: configured.warnings
	};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const plan = await checkReleasePlan();
	for (const warning of plan.warnings) process.stderr.write(`Release plan warning: ${warning}\n`);
	const releases = plan.releases.filter((release) => release.type !== "none");
	process.stdout.write(
		`Release plan valid: ${plan.changesets.length} notes, ${releases.length} package releases.\n`
	);
}
