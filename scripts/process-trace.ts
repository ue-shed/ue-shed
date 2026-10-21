/**
 * Spans for native processes (Cargo, Unreal and other tools) in traced gate runs (see
 * `gate-trace.ts`). UnrealBuildTool runs record whether the target was already up to date and how
 * long actions took; editor and commandlet runs are split into engine startup, work and shutdown
 * using the timestamps in the project's log.
 */

import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	startSpan,
	traceFile,
	withExplicitProcessSpan,
	withSpan,
	type Span,
	type SpanAttributes
} from "./gate-trace.ts";

/**
 * Runs `run` (which spawns `command`) inside a span. Node processes, including pnpm, already record
 * their own process span, so they run without one here.
 */
export function traceProcess<Output extends string | Buffer>(
	command: string,
	args: readonly string[],
	run: () => SpawnSyncReturns<Output>
): SpawnSyncReturns<Output> {
	if (!traceFile()) return run();
	if (command === process.execPath || /^(?:pnpm|npm)(?:\.cmd)?$/i.test(basename(command))) {
		return withExplicitProcessSpan(run);
	}
	const tool = basename(command);
	const projectFile = args.find((arg) => arg.toLowerCase().endsWith(".uproject"));
	const commandlet = args.find((arg) => arg.startsWith("-run="))?.slice("-run=".length);
	const mode = args
		.filter((arg) => /^-\w+Only$/.test(arg) || /^-(?:Generate|Verify|Conformance)\w*/.test(arg))
		.map((arg) => arg.split("=")[0])
		.join(" ");
	const isBuild = /^build\.(?:bat|sh)$/i.test(tool);
	if (!isBuild && projectFile === undefined) {
		return withSpan(
			`${tool} ${args.join(" ")}`.slice(0, 160),
			{},
			(span) => {
				const result = withExplicitProcessSpan(run);
				if (/^cargo(?:\.exe)?$/i.test(tool)) {
					span.setAttributes(cargoAttributes(outputText(result.stderr)));
				}
				return result;
			},
			processStatus
		);
	}
	const name = isBuild
		? `UnrealBuildTool ${args[0] ?? ""}`
		: `${commandlet ? `commandlet ${commandlet}` : tool} ${mode}`.trim();
	return withSpan(
		name,
		{
			"unreal.tool": tool,
			"unreal.engine": engineLabel(command),
			"unreal.project": projectFile && basename(projectFile),
			"unreal.commandlet": commandlet
		},
		(span) => {
			try {
				return withExplicitProcessSpan(run);
			} finally {
				if (isBuild) describeBuild(span);
				else if (projectFile) describeEditorRun(span, projectFile);
			}
		},
		processStatus
	);
}

/** Text of captured process output, or "" when it went to the terminal. */
export function outputText(output: string | Buffer | null | undefined) {
	if (output === null || output === undefined) return "";
	return Buffer.isBuffer(output) ? output.toString("utf8") : output;
}

const cargoFinished = /Finished `([\w-]+)` profile .*? in (?:(\d+)m )?([\d.]+)s/g;

/**
 * Compile attributes from Cargo's output: how many crates it compiled, which profiles it built and
 * how long building took. `cargo test` runs tests after its build finishes, so the rest of its span
 * is test time. Empty output (inherited stdio) yields no attributes.
 */
export function cargoAttributes(output: string): SpanAttributes {
	const finished = [...output.matchAll(cargoFinished)];
	if (finished.length === 0) return {};
	const buildMs = finished.reduce(
		(sum, match) => sum + (Number(match[2] ?? 0) * 60 + Number(match[3])) * 1000,
		0
	);
	return {
		"cargo.compiled_crates": output.match(/^\s*Compiling /gm)?.length ?? 0,
		"cargo.profiles": [...new Set(finished.map((match) => match[1]))].join(" "),
		"cargo.build_ms": Math.round(buildMs)
	};
}

function processStatus(result: SpawnSyncReturns<unknown>) {
	return result.status === 0 ? "ok" : "error";
}

function engineLabel(command: string) {
	const engineRoot = command.replace(/[\\/]Engine[\\/](?:Build|Binaries)[\\/].*$/i, "");
	const version = join(engineRoot, "Engine", "Build", "Build.version");
	if (!existsSync(version)) return basename(engineRoot);
	const match = /"MajorVersion":\s*(\d+),\s*"MinorVersion":\s*(\d+)/.exec(
		readFileSync(version, "utf8")
	);
	return match ? `${match[1]}.${match[2]}` : basename(engineRoot);
}

function recentLog(file: string, span: Span) {
	if (!existsSync(file) || statSync(file).mtimeMs * 1000 < span.startUs) return undefined;
	return readFileSync(file, "utf8");
}

function describeBuild(span: Span) {
	const log = recentLog(join(homedir(), "AppData", "Local", "UnrealBuildTool", "Log.txt"), span);
	if (log === undefined) return;
	const actions = /\[\d+\/(\d+)\]/.exec(
		log.split(/\r?\n/).findLast((line) => /\[\d+\/\d+\]/.test(line)) ?? ""
	);
	const execute = /\(\+([\d.]+)\) ActionGraph\.ExecuteActions\(\)/.exec(log);
	span.setAttributes({
		"unreal.build.up_to_date": /Target is up to date/.test(log),
		"unreal.build.actions": actions ? Number(actions[1]) : 0,
		"unreal.build.execute_actions_ms": execute
			? Math.round(Number(execute[1]) * 1000)
			: undefined
	});
}

const logLine = /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]/;

function lineTimeUs(line: string) {
	const match = logLine.exec(line);
	if (!match) return undefined;
	const [, year, month, day, hour, minute, second, millisecond] = match.map(Number);
	// Unreal writes log timestamps in UTC unless -LocalLogTimes is passed.
	return Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, millisecond!) * 1000;
}

function describeEditorRun(span: Span, projectFile: string) {
	const project = basename(projectFile, ".uproject");
	const log = recentLog(join(dirname(projectFile), "Saved", "Logs", `${project}.log`), span);
	if (log === undefined) return;
	const lines = log.split(/\r?\n/);
	const workStart = lines.find((line) =>
		/LogInit: (?:Executing Class|Display: Engine is initialized)/.test(line)
	);
	const workEnd = lines.find((line) => /LogExit: Preparing to exit/.test(line));
	const workStartUs = workStart ? lineTimeUs(workStart) : undefined;
	const workEndUs = workEnd ? lineTimeUs(workEnd) : undefined;
	const commandletSeconds = /Execution of commandlet took:\s*([\d.]+) seconds/.exec(log);
	span.setAttributes({
		"unreal.log.warnings": lines.filter((line) => /: Warning: /.test(line)).length,
		"unreal.log.errors": lines.filter((line) => /: Error: /.test(line)).length,
		"unreal.commandlet_ms": commandletSeconds
			? Math.round(Number(commandletSeconds[1]) * 1000)
			: undefined
	});
	if (workStartUs === undefined || workStartUs < span.startUs) return;
	const endUs = Date.now() * 1000;
	const phases: [string, number, number][] = [["engine startup", span.startUs, workStartUs]];
	if (workEndUs !== undefined && workEndUs >= workStartUs) {
		phases.push(["work", workStartUs, workEndUs], ["shutdown", workEndUs, endUs]);
	} else {
		phases.push(["work", workStartUs, endUs]);
	}
	for (const [name, startUs, phaseEndUs] of phases) {
		const phase = startSpan(name, {}, { parent: span, startUs });
		phase.end("ok", Math.min(phaseEndUs, endUs));
	}
}
