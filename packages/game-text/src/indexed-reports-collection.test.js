import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
it.each([false, true])("bounds collection-time worker exit (recover: %s)", (recover) => {
    const root = resolve(import.meta.dirname, "../../..");
    const scratch = join(root, ".tmp");
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "report-worker-collection-"));
    try {
        const probe = join(directory, "exit.test.ts");
        const config = join(directory, "vitest.config.mjs");
        writeFileSync(config, `export default ${JSON.stringify({
            root,
            test: {
                include: [relative(root, probe).split(sep).join("/")],
                environment: "node",
                pool: "threads",
                maxWorkers: 1
            }
        })};\n`);
        writeFileSync(probe, `import { expect, it, vi } from "vitest";
vi.mock("node:worker_threads", async (original) => {
	const real = await original();
	let generation = 0;
	return { ...real, Worker: class extends real.Worker {
		constructor() {
			super(${JSON.stringify(`
const { parentPort, workerData } = require("node:worker_threads");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
parentPort.on("message", ({ input, reply, state }) => {
	const request = JSON.parse(input);
	const marker = join(request.directory, "abandoned-writer");
	if (workerData === 1) {
		mkdirSync(request.directory, { recursive: true });
		writeFileSync(marker, "writer owned by a terminated worker");
		process.exit(23);
	}
	// Emulate the persistent lock left when abrupt termination skips native finalizers.
	reply.postMessage(existsSync(marker)
		? { stderr: "Reused an abandoned writer directory." }
		: { stdout: JSON.stringify(request.corpus) });
	reply.close();
	const completion = new Int32Array(state);
	Atomics.store(completion, 0, 1);
	Atomics.notify(completion, 0);
});
`)}, { eval: true, execArgv: [], workerData: ++generation });
		}
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
let waits = 0;
vi.spyOn(Atomics, "wait").mockImplementation((state, index, value, timeout) =>
	// Shorten finite budgets for this process-level regression. Preserve the original infinite
	// wait so that the broken implementation genuinely hangs and hits the outer watchdog.
	wait(state, index, value, Number.isFinite(timeout) && timeout > 0 && waits++ === 0 ? 500 : timeout)
);
const { indexedTestReports } = await import(${JSON.stringify(pathToFileURL(join(root, "packages/game-text/src/indexed-reports.test-support.ts")).href)});
const corpus = {
	coverage: {
		discoveredPackages: 0, failedPackages: 0, inspectedPackages: 0, partialPackages: 0,
		resolvedOccurrences: 0, textOccurrences: 0, textUnits: 0, unresolvedOccurrences: 0,
		unsupportedTextProperties: 0
	},
	diagnostics: [], schemaVersion: 1, status: "complete", units: []
};
${recover
            ? `expect(() => indexedTestReports(corpus).corpus()).toThrow("The indexed report worker did not respond");
const recovered = indexedTestReports(corpus).corpus();
it("uses a fresh index after a terminated worker", () => expect(recovered).toEqual(corpus));`
            : "indexedTestReports(corpus).corpus();"}
`);
        const result = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", config], {
            cwd: root,
            encoding: "utf8",
            timeout: 10_000,
            maxBuffer: 2 * 1024 * 1024,
            windowsHide: true
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(recover ? 0 : 1);
        if (!recover)
            expect(result.stdout + result.stderr).toContain("The indexed report worker did not respond");
    }
    finally {
        const target = realpathSync(directory);
        const withinRoot = relative(realpathSync(root), target);
        if (dirname(target) !== realpathSync(scratch) ||
            isAbsolute(withinRoot) ||
            withinRoot === ".." ||
            withinRoot.startsWith(`..${sep}`))
            throw new Error("The collection probe escaped its owned workspace directory.");
        rmSync(target, { recursive: true, force: true });
    }
});
