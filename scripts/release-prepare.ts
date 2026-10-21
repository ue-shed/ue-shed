/**
 * Runs every release gate for the committed release under one trace and records the results as
 * release evidence (`release-evidence.ts`) for `pnpm release`:
 *
 * - portable lane, in this checkout: release text (formatting and release tests), then `pnpm check`;
 * - pack lane: `release:pack:clean-check`, keeping the validated tarballs for publication;
 * - Unreal lane, in a second worktree of the same commit: the UAsset engine matrix, `check:unreal`
 *   and plugin compatibility on UE 5.7, 5.8 and 4.27, one after another (UnrealBuildTool shares
 *   one log file across engines, and these gates rebuild package output `pnpm check` reads).
 *
 * The lanes run in parallel unless `--serial`. A gate whose recorded evidence still covers the
 * release commit's inputs is reused instead of rerun, so after a changelog-only edit only the
 * release-text and pack gates run again. Writes `out/release-prepare/<version>-<time>/` with the
 * trace, logs, `report.html` and `validation.md`.
 *
 *   pnpm release:prepare
 *   pnpm release:prepare --only check,pack
 *   pnpm release:prepare --serial --record
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { nowUs, startSpan, type Span } from "./gate-trace.ts";
import {
	createStepRunner,
	expandScript,
	finishGateSession,
	readPackageScripts,
	seconds,
	startGateSession,
	type GateSession,
	type Step,
	type Timing
} from "./gate-runner.ts";
import { PUBLIC_VERSION } from "./pack-public-packages.ts";
import { releaseCargoTargetDirectory } from "./release-cargo.ts";
import {
	gateEvidenceState,
	gateFingerprint,
	readReleaseEvidence,
	readTree,
	writeReleaseEvidence,
	type GateEvidenceState,
	type GateResult,
	type ReleaseEvidence,
	type TreeEntry
} from "./release-evidence.ts";
import { RELEASE_GATES, type ReleaseGate } from "./release-gates.ts";
import { writeReleaseReport } from "./release-report.ts";
import { assertCleanReleaseSource } from "./release-source.ts";
import { findUnrealEngine } from "./unreal-engines.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

interface PlannedGate {
	readonly gate: ReleaseGate;
	readonly state: GateEvidenceState;
	readonly reuse: boolean;
}

export interface GateRun {
	readonly gate: ReleaseGate;
	readonly result: GateResult;
	readonly timing: Timing;
}

/** Which gates to run: everything selected whose evidence no longer covers the release commit. */
export function planGates(
	gates: readonly ReleaseGate[],
	evidence: ReleaseEvidence,
	tree: readonly TreeEntry[],
	{ force = false }: { readonly force?: boolean } = {}
): PlannedGate[] {
	return gates.map((gate) => {
		const state = gateEvidenceState(evidence.gates[gate.id], gate.scope, tree);
		return { gate, state, reuse: !force && state.kind === "current" };
	});
}

function describeState(planned: PlannedGate) {
	switch (planned.state.kind) {
		case "current":
			return planned.reuse
				? `reuse: passed on ${planned.state.result.commit.slice(0, 10)} with the same inputs`
				: "rerun (--force)";
		case "stale":
			return `run: inputs changed since ${planned.state.result.commit.slice(0, 10)}`;
		case "failed":
			return `run: failed on ${planned.state.result.commit.slice(0, 10)}`;
		case "missing":
			return "run: no evidence";
	}
}

interface Lane {
	readonly name: string;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly gates: readonly ReleaseGate[];
	/** Prepares the lane's checkout before its first gate; false skips the lane's gates. */
	readonly setup?: (session: GateSession, parent: Span) => Promise<boolean>;
}

function git(args: readonly string[], cwd = repositoryRoot) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stderr}`);
	}
	return result.stdout.trim();
}

function registeredWorktrees() {
	return git(["worktree", "list", "--porcelain"])
		.split(/\r?\n/)
		.filter((line) => line.startsWith("worktree "))
		.map((line) => resolve(line.slice("worktree ".length)));
}

const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;

/**
 * Brings the Unreal lane's worktree to `commit`: created on first use, otherwise checked out and
 * cleaned while keeping installed dependencies and Unreal build output, which later releases reuse.
 */
function unrealWorktreeSetup(path: string, commit: string, env: NodeJS.ProcessEnv) {
	return async (session: GateSession, parent: Span) => {
		const exists = existsSync(path);
		if (exists && !registeredWorktrees().includes(resolve(path))) {
			throw new Error(`${path} exists but is not a worktree of this repository.`);
		}
		const span = startSpan("prepare Unreal worktree", { "trace.lane": "unreal" }, { parent });
		const checkout: Step = exists
			? {
					name: "update worktree",
					command: [
						`git -C ${quote(path)} checkout --quiet --detach --force ${commit}`,
						`git -C ${quote(path)} clean -ffdxq -e node_modules -e Binaries -e Intermediate -e DerivedDataCache`
					].join(" && "),
					depth: 1,
					children: []
				}
			: {
					name: "create worktree",
					command: `git worktree add --detach ${quote(path)} ${commit}`,
					depth: 1,
					children: []
				};
		const checkedOut = await createStepRunner({
			session,
			cwd: repositoryRoot,
			env,
			label: "unreal"
		}).run(checkout, span);
		const prepared =
			checkedOut.status === "passed" &&
			(
				await createStepRunner({ session, cwd: path, env, label: "unreal" }).run(
					{
						name: "install and build",
						command: "",
						depth: 1,
						children: [
							{
								name: "install dependencies",
								command: "pnpm install --frozen-lockfile --prefer-offline",
								depth: 2,
								children: []
							},
							{
								name: "build TypeScript packages",
								command: "pnpm run build:typescript-packages",
								depth: 2,
								children: []
							}
						]
					},
					span
				)
			).status === "passed";
		span.end(prepared ? "ok" : "error");
		return prepared;
	};
}

/** The steps that run a gate, or a reason it cannot run on this machine. */
async function gateSteps(
	gate: ReleaseGate,
	{
		scripts,
		packDirectory,
		laneDirectory,
		stamp
	}: {
		readonly scripts: Readonly<Record<string, string>>;
		readonly packDirectory: string;
		readonly laneDirectory: string;
		readonly stamp: string;
	}
): Promise<
	| { readonly kind: "run"; readonly step: Step; readonly env?: NodeJS.ProcessEnv }
	| { readonly kind: "unavailable"; readonly detail: string }
> {
	const command = gate.command;
	switch (command.kind) {
		case "scripts": {
			const children = command.scripts.map((name) => expandScript(scripts, name, 1));
			const step: Step =
				children.length === 1
					? expandScript(scripts, command.scripts[0]!, 0)
					: {
							name: gate.id,
							command: command.scripts.map((name) => `pnpm run ${name}`).join(" && "),
							depth: 0,
							children
						};
			return { kind: "run", step };
		}
		case "clean-pack":
			return {
				kind: "run",
				step: {
					name: "release:pack:clean-check",
					command: `${quote(process.execPath)} scripts/check-clean-release-pack.ts --output ${quote(packDirectory)}`,
					depth: 0,
					children: []
				}
			};
		case "plugins": {
			const engineRoot =
				process.env[`UE_SHED_UNREAL_${command.engine.replace(".", "")}_ROOT`] ??
				(await findUnrealEngine([command.engine]));
			if (engineRoot === undefined) {
				return {
					kind: "unavailable",
					detail: `Unreal ${command.engine} is not installed on this machine.`
				};
			}
			// In the lane's own short `out` directory, like the engine matrix's default output:
			// UnrealBuildTool's intermediate paths below it must stay under 260 characters.
			const evidence = join(laneDirectory, "out", `plugins-${command.engine}-${stamp}`);
			return {
				kind: "run",
				step: {
					name: `test:unreal-plugins (UE ${command.engine})`,
					command: `pnpm run test:unreal-plugins ${quote(evidence)}`,
					depth: 0,
					children: []
				},
				env: { UE_SHED_UNREAL_ENGINE_ROOT: engineRoot }
			};
		}
	}
}

async function runGate(
	gate: ReleaseGate,
	lane: Lane,
	context: {
		readonly session: GateSession;
		readonly scripts: Readonly<Record<string, string>>;
		readonly runDirectory: string;
		readonly packDirectory: string;
		readonly stamp: string;
		readonly commit: string;
		readonly tree: readonly TreeEntry[];
		readonly keepGoing: boolean;
	}
): Promise<GateRun> {
	const { session } = context;
	const span = startSpan(
		`gate ${gate.id}`,
		{ "release.gate": gate.id, "release.lane": lane.name, "trace.lane": lane.name },
		{ parent: session.rootSpan }
	);
	const startMs = (span.startUs - session.rootSpan.startUs) / 1000;
	const steps = await gateSteps(gate, { ...context, laneDirectory: lane.cwd });
	const finish = (status: GateResult["status"], timing: Timing, detail?: string): GateRun => {
		span.setAttributes({ "release.status": status, "release.detail": detail });
		span.end(status === "failed" ? "error" : "ok");
		return {
			gate,
			timing,
			result: {
				status,
				scope: gate.scope,
				fingerprint: gateFingerprint(gate.scope, context.tree),
				commit: context.commit,
				finishedAt: new Date().toISOString(),
				durationMs: Math.round(timing.durationMs),
				trace: session.outputDirectory,
				detail
			}
		};
	};
	if (steps.kind === "unavailable") {
		process.stdout.write(`[${lane.name}] ${gate.id}: unavailable — ${steps.detail}\n`);
		return finish(
			"unavailable",
			{
				name: gate.id,
				command: "",
				depth: 0,
				startMs,
				durationMs: 0,
				status: "skipped",
				children: []
			},
			steps.detail
		);
	}
	const runner = createStepRunner({
		session,
		cwd: lane.cwd,
		env: { ...lane.env, ...steps.env },
		keepGoing: context.keepGoing,
		label: gate.id
	});
	const timing = await runner.run(steps.step, span);
	return finish(timing.status === "passed" ? "passed" : "failed", timing);
}

/**
 * The longest `<checkout>\out` an Unreal lane can use. The engine matrix and plugin gates write
 * UnrealBuildTool intermediates up to about 170 characters below it (measured for 0.20.0), and
 * Windows tools fail past 260.
 */
export const UNREAL_OUTPUT_PATH_BUDGET = 85;

export function assertUnrealPathBudget(checkout: string) {
	const output = join(checkout, "out");
	if (output.length > UNREAL_OUTPUT_PATH_BUDGET) {
		throw new Error(
			`${output} is ${output.length} characters; Unreal gates need at most ` +
				`${UNREAL_OUTPUT_PATH_BUDGET} so build paths below it stay under 260. Pass a shorter ` +
				"--unreal-worktree."
		);
	}
}

/** Inserts or replaces the `## Validation` section of the release notes. */
export function recordValidation(notes: string, validation: string) {
	const heading = /^## Validation[^\n]*\n/m.exec(notes);
	if (heading === null) return `${notes.trimEnd()}\n\n${validation.trim()}\n`;
	const after = notes.slice(heading.index + heading[0].length);
	const next = /^## /m.exec(after);
	const tail = next === null ? "" : `\n${after.slice(next.index)}`;
	return `${notes.slice(0, heading.index)}${validation.trim()}\n${tail}`;
}

async function main() {
	const { values } = parseArgs({
		options: {
			serial: { type: "boolean", default: false },
			only: { type: "string" },
			force: { type: "boolean", default: false },
			"keep-going": { type: "boolean", default: false },
			record: { type: "boolean", default: false },
			"unreal-worktree": { type: "string" }
		},
		strict: true
	});
	if (!process.env.npm_execpath) {
		throw new Error("Run through pnpm (pnpm release:prepare) so gates see pnpm's environment.");
	}
	const commit = assertCleanReleaseSource();
	const version = PUBLIC_VERSION;
	const tree = readTree(commit);
	const evidence = readReleaseEvidence(version);
	const only = values.only?.split(",").map((id) => id.trim());
	const unknown = only?.filter((id) => !RELEASE_GATES.some((gate) => gate.id === id)) ?? [];
	if (unknown.length > 0) {
		throw new Error(
			`Unknown release gates: ${unknown.join(", ")}. Gates: ${RELEASE_GATES.map((gate) => gate.id).join(", ")}.`
		);
	}
	const selected = RELEASE_GATES.filter((gate) => only === undefined || only.includes(gate.id));
	const plan = planGates(selected, evidence, tree, { force: values.force });

	console.log(`Release ${version} at ${commit}\n`);
	for (const planned of plan) {
		console.log(`  ${planned.gate.id.padEnd(14)} ${describeState(planned)}`);
	}
	const toRun = plan.filter((planned) => !planned.reuse).map((planned) => planned.gate);
	if (toRun.length === 0) {
		console.log("\nEvery selected gate is covered by evidence for this commit.");
		return;
	}

	const stamp = new Date().toISOString().replaceAll(/[-:]|\.\d+Z$/g, "");
	const runDirectory = join(repositoryRoot, "out", "release-prepare", `${version}-${stamp}`);
	const packDirectory = join(runDirectory, "npm");
	const session = startGateSession({
		name: `release:prepare ${version}`,
		outputDirectory: runDirectory,
		attributes: {
			"release.version": version,
			"release.serial": values.serial,
			"release.gates": toRun.map((gate) => gate.id).join(" ")
		}
	});
	const scripts = readPackageScripts(repositoryRoot);
	const cargoTarget = releaseCargoTargetDirectory();
	const portableEnv = session.environment(repositoryRoot, {
		...process.env,
		CARGO_TARGET_DIR: cargoTarget
	});
	const unrealGates = toRun.filter((gate) => gate.lane === "unreal");
	const lanes: Lane[] = [];
	if (values.serial) {
		lanes.push({ name: "serial", cwd: repositoryRoot, env: portableEnv, gates: toRun });
	} else {
		lanes.push(
			{
				name: "portable",
				cwd: repositoryRoot,
				env: portableEnv,
				gates: toRun.filter((gate) => gate.lane === "portable")
			},
			{
				name: "pack",
				cwd: repositoryRoot,
				env: portableEnv,
				gates: toRun.filter((gate) => gate.lane === "pack")
			}
		);
		if (unrealGates.length > 0) {
			const unrealPath = resolve(
				values["unreal-worktree"] ??
					join(dirname(repositoryRoot), `${basename(repositoryRoot)}-unreal`)
			);
			// Its own Cargo directory: this lane builds the same crates from a different path, which
			// would otherwise replace executables the portable lane is running.
			const unrealEnv = session.environment(unrealPath, {
				...process.env,
				CARGO_TARGET_DIR: join(cargoTarget, "unreal-lane")
			});
			lanes.push({
				name: "unreal",
				cwd: unrealPath,
				env: unrealEnv,
				gates: unrealGates,
				setup: unrealWorktreeSetup(unrealPath, commit, unrealEnv)
			});
		}
	}

	for (const lane of lanes) {
		if (lane.gates.some((gate) => gate.lane === "unreal")) assertUnrealPathBudget(lane.cwd);
	}
	const context = {
		session,
		stamp,
		scripts,
		runDirectory,
		packDirectory,
		commit,
		tree,
		keepGoing: values["keep-going"]
	};
	const runs = (
		await Promise.all(
			lanes
				.filter((lane) => lane.gates.length > 0)
				.map(async (lane) => {
					const laneRuns: GateRun[] = [];
					if (
						lane.setup !== undefined &&
						!(await lane.setup(session, session.rootSpan))
					) {
						for (const gate of lane.gates) {
							laneRuns.push({
								gate,
								timing: {
									name: gate.id,
									command: "",
									depth: 0,
									startMs: 0,
									durationMs: 0,
									status: "skipped",
									children: []
								},
								result: {
									status: "failed",
									scope: gate.scope,
									fingerprint: gateFingerprint(gate.scope, tree),
									commit,
									finishedAt: new Date().toISOString(),
									durationMs: 0,
									trace: runDirectory,
									detail: `The ${lane.name} lane's checkout could not be prepared.`
								}
							});
						}
						return laneRuns;
					}
					// Gates are independent evidence, so a failure does not stop the rest of the lane.
					for (const gate of lane.gates)
						laneRuns.push(await runGate(gate, lane, context));
					return laneRuns;
				})
		)
	).flat();

	const gates = { ...evidence.gates };
	for (const run of runs) gates[run.gate.id] = run.result;
	const packRun = runs.find((run) => run.gate.id === "pack");
	// A failed pack keeps the previous pack's directory, whose own commit release checks.
	const updated: ReleaseEvidence =
		packRun?.result.status === "passed"
			? { ...evidence, gates, pack: { directory: packDirectory, commit } }
			: { ...evidence, gates };
	const evidencePath = writeReleaseEvidence(updated);

	const failed = runs.filter((run) => run.result.status === "failed");
	const durationMs = (nowUs() - session.rootSpan.startUs) / 1000;
	const spans = finishGateSession(session, {
		script: "release:prepare",
		root: {
			name: "release:prepare",
			command: "pnpm release:prepare",
			depth: 0,
			startMs: 0,
			durationMs,
			status: failed.length > 0 ? "failed" : "passed",
			children: runs.map((run) => run.timing)
		},
		summary: {
			version,
			releaseCommit: commit,
			gates: Object.fromEntries(
				runs.map((run) => [
					run.gate.id,
					{ status: run.result.status, ms: run.result.durationMs }
				])
			)
		}
	});
	const { reportPath, validationPath, validation } = writeReleaseReport({
		outputDirectory: runDirectory,
		version,
		commit,
		spans,
		runs,
		evidence: updated,
		gates: RELEASE_GATES,
		reused: plan.filter((planned) => planned.reuse).map((planned) => planned.gate.id),
		tree
	});
	if (values.record) {
		const notesPath = join(repositoryRoot, "docs", "releases", `${version}.md`);
		if (!existsSync(notesPath)) throw new Error(`Release notes ${notesPath} do not exist.`);
		writeFileSync(notesPath, recordValidation(readFileSync(notesPath, "utf8"), validation));
		console.log(`\nRecorded validation in ${relative(repositoryRoot, notesPath)}; commit it.`);
	}

	console.log(
		`\nrelease:prepare ${version}: ${failed.length > 0 ? "failed" : "passed"} in ${seconds(durationMs)}`
	);
	for (const run of runs) {
		console.log(
			`  ${run.gate.id.padEnd(14)} ${run.result.status.padEnd(12)} ${seconds(run.result.durationMs)}${run.result.detail ? `  ${run.result.detail}` : ""}`
		);
	}
	console.log(`\nEvidence: ${relative(repositoryRoot, evidencePath)}`);
	console.log(`Report:   ${relative(repositoryRoot, reportPath)}`);
	console.log(`Notes:    ${relative(repositoryRoot, validationPath)}`);
	console.log(
		`Trace:    ${relative(repositoryRoot, join(runDirectory, "trace.json"))} (https://ui.perfetto.dev)`
	);
	process.exitCode = failed.length > 0 ? 1 : 0;
}

if (import.meta.main) await main();
