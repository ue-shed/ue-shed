import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("fails collection when a report worker exits before replying", () => {
	const root = resolve(import.meta.dirname, "../../..");
	const scratch = join(root, ".tmp");
	mkdirSync(scratch, { recursive: true });
	const directory = mkdtempSync(join(scratch, "report-worker-collection-"));
	try {
		const probe = join(directory, "exit.test.ts");
		const config = join(directory, "vitest.config.mjs");
		writeFileSync(
			config,
			`export default ${JSON.stringify({
				root,
				test: {
					include: [relative(root, probe).split(sep).join("/")],
					environment: "node",
					pool: "threads",
					maxWorkers: 1
				}
			})};\n`
		);
		writeFileSync(
			probe,
			`import { vi } from "vitest";
vi.mock("node:worker_threads", async (original) => {
	const real = await original();
	return { ...real, Worker: class extends real.Worker {
		constructor() { super("process.exit(23)", { eval: true, execArgv: [] }); }
	} };
});
vi.mock("node:fs", async (original) => {
	const real = await original();
	return { ...real, mkdtempSync: () => {
		const owned = ${JSON.stringify(join(directory, "owned-fixture"))};
		real.mkdirSync(owned, { recursive: true });
		return owned;
	} };
});
const wait = Atomics.wait;
vi.spyOn(Atomics, "wait").mockImplementation((state, index, value, timeout) =>
	// Shorten finite budgets for this process-level regression. Preserve the original infinite
	// wait so that the broken implementation genuinely hangs and hits the outer watchdog.
	wait(state, index, value, Number.isFinite(timeout) && timeout > 0 ? 500 : timeout)
);
const { indexedTestReports } = await import(${JSON.stringify(pathToFileURL(join(root, "packages/game-text/src/indexed-reports.test-support.ts")).href)});
indexedTestReports({
	coverage: {
		discoveredPackages: 0, failedPackages: 0, inspectedPackages: 0, partialPackages: 0,
		resolvedOccurrences: 0, textOccurrences: 0, textUnits: 0, unresolvedOccurrences: 0,
		unsupportedTextProperties: 0
	},
	diagnostics: [], schemaVersion: 1, status: "complete", units: []
}).corpus();
`
		);
		const result = spawnSync(
			process.execPath,
			[join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", config],
			{
				cwd: root,
				encoding: "utf8",
				timeout: 10_000,
				maxBuffer: 2 * 1024 * 1024,
				windowsHide: true
			}
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stdout + result.stderr).toContain(
			"The indexed report worker did not respond"
		);
	} finally {
		const target = realpathSync(directory);
		const withinRoot = relative(realpathSync(root), target);
		if (
			dirname(target) !== realpathSync(scratch) ||
			isAbsolute(withinRoot) ||
			withinRoot === ".." ||
			withinRoot.startsWith(`..${sep}`)
		)
			throw new Error("The collection probe escaped its owned workspace directory.");
		rmSync(target, { recursive: true, force: true });
	}
});
