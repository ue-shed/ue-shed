import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { repositoryPath } from "./game-text-scale-options.ts";
import { ensureUassetExecutable } from "./native-tools.ts";
import {
	committedPackagePaths,
	packageTextFixtureProjects
} from "./package-text-reader.test-support.ts";
import { auditPackageTextCandidates } from "./package-text-candidates.test-support.ts";

const executable = ensureUassetExecutable();
const results = [];
const engines = [];
for (const project of packageTextFixtureProjects) {
	const { measurement } = await auditPackageTextCandidates(executable, project);
	// Write the complete audit before reporting any text-loss STOP.
	results.push(measurement);
}
if (process.argv[2]) {
	const matrix = repositoryPath(process.argv[2]);
	for (const version of ["5.7", "5.8"]) {
		const project = join(matrix, version, "fixture");
		// Mirror committed paths; older scan tests left unrelated synthetic Content copies.
		const paths = committedPackagePaths("fixtures/unreal-project").map((path) =>
			join(project, relative(resolve("fixtures/unreal-project"), path))
		);
		const { measurement } = await auditPackageTextCandidates(executable, project, paths);
		engines.push({ version, ...measurement });
	}
}
await mkdir("test-results/game-text-scale", { recursive: true });
await writeFile(
	join("test-results/game-text-scale", "phase4-candidate-audit.json"),
	JSON.stringify(
		{
			candidateRuleAccepted: [...results, ...engines].every(
				(result) => result.textOracle.equal && result.oracle.equal
			),
			results,
			engines
		},
		null,
		"\t"
	) + "\n"
);
for (const result of [...results, ...engines]) process.stdout.write(JSON.stringify(result) + "\n");
assert.equal(
	[...results, ...engines].filter((result) => !result.textOracle.equal || !result.oracle.equal)
		.length,
	0,
	"STOP: candidate rule changed text or mapped coverage"
);
