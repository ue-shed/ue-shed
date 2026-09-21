import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureUassetExecutable, repositoryRoot } from "./native-tools.ts";
import { reportUnrealTestGates } from "./test-gates.ts";

const evidenceDirectory = mkdtempSync(join(tmpdir(), "ue-shed-uasset-conformance-"));
const fixture = spawnSync(
	process.execPath,
	["scripts/unreal-fixture.ts", "conformance", evidenceDirectory],
	{
		cwd: repositoryRoot,
		stdio: "inherit",
		windowsHide: true
	}
);
if (fixture.error) throw fixture.error;
if (fixture.status !== 0) {
	process.stderr.write(`Unreal evidence retained at ${evidenceDirectory}\n`);
	process.exit(fixture.status ?? 1);
}

const testFile = "packages/unreal-assets/src/commandlet-conformance.integration.test.ts";
const environment = {
	...process.env,
	UE_SHED_UASSET_EXECUTABLE: ensureUassetExecutable(),
	UE_SHED_UNREAL_EVIDENCE_DIR: evidenceDirectory
};
reportUnrealTestGates(environment, [testFile]);
const vitest = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "run", testFile], {
	cwd: repositoryRoot,
	env: environment,
	stdio: "inherit",
	windowsHide: true
});
if (result.error) throw result.error;
const nativeResult =
	result.status === 0
		? spawnSync("cargo", ["test", "-p", "uasset-inspection", "--test", "native_coverage"], {
				cwd: repositoryRoot,
				env: {
					...environment,
					UE_SHED_NATIVE_EVIDENCE_DIR: join(evidenceDirectory, "parser-targets")
				},
				stdio: "inherit",
				windowsHide: true
			})
		: result;
if (nativeResult.error) throw nativeResult.error;
if (nativeResult.status === 0) {
	rmSync(evidenceDirectory, { force: true, recursive: true });
} else {
	process.stderr.write(`Unreal evidence retained at ${evidenceDirectory}\n`);
}
process.exit(nativeResult.status ?? 1);
