/**
 * Runs a package.json gate (such as `check` or `check:precommit`) one command at a time and traces
 * it. `pnpm run <script>` steps inside `&&` chains are expanded, so the result is a tree of the real
 * commands the gate runs (see `gate-runner.ts`).
 *
 * Writes `out/gate-timing/<script>-<time>/`: `trace.json` (open it in https://ui.perfetto.dev),
 * `spans.jsonl`, `summary.json` and one log per command, and appends a line to
 * `out/gate-timing/history.jsonl`.
 *
 *   pnpm check:time check:precommit
 *   pnpm check:time check --keep-going
 *   pnpm check:time check:unreal
 */

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	createStepRunner,
	expandScript,
	finishGateSession,
	printReport,
	readPackageScripts,
	seconds,
	startGateSession
} from "./gate-runner.ts";

export { chromeTrace, expandScript, readSpans } from "./gate-runner.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { "keep-going": { type: "boolean", default: false } }
	});
	const target = positionals[0];
	if (target === undefined) {
		console.error("Usage: pnpm check:time <script> [--keep-going]");
		process.exit(2);
	}
	if (!process.env.npm_execpath) {
		throw new Error("Run through pnpm (pnpm check:time) so commands see pnpm's environment.");
	}
	const scripts = readPackageScripts(repositoryRoot);
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	const session = startGateSession({
		name: `gate ${target}`,
		outputDirectory: join(
			repositoryRoot,
			"out",
			"gate-timing",
			`${target.replaceAll(":", "-")}-${stamp}`
		),
		attributes: { "gate.script": target }
	});
	const runner = createStepRunner({
		session,
		cwd: repositoryRoot,
		env: session.environment(repositoryRoot),
		keepGoing: values["keep-going"]
	});
	const root = await runner.run(expandScript(scripts, target), session.rootSpan);
	const spans = finishGateSession(session, { script: target, root });

	console.log(`\n${target}: ${root.status} in ${seconds(root.durationMs)}\n`);
	printReport(root, spans);
	console.log(`\nWrote ${session.outputDirectory} (open trace.json in https://ui.perfetto.dev)`);
	process.exitCode = root.status === "failed" ? 1 : 0;
}
