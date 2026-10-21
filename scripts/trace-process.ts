/**
 * Preloaded into every Node process of a traced gate run (`NODE_OPTIONS=--import=…`, set by
 * `pnpm check:time` and `pnpm release:prepare`). Records one span per process from start to exit
 * and makes it the parent of the process's own spans and children, so scripts nest without each
 * one being instrumented.
 *
 * It also records a span for every non-Node subprocess the process starts (git, tar, npm, Cargo,
 * Electron, native tools) unless the caller already traces it (`traceProcess` in
 * `process-trace.ts`). Node subprocesses, including pnpm and npm shims, record their own process
 * span through this preload instead.
 */

import childProcess, {
	type ChildProcess,
	type ExecFileSyncOptions,
	type ExecSyncOptions,
	type SpawnOptions,
	type SpawnSyncOptions,
	type SpawnSyncReturns
} from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { isMainThread } from "node:worker_threads";
import {
	formatTraceparent,
	insideExplicitProcessSpan,
	startSpan,
	traceFile,
	type Span
} from "./gate-trace.ts";
import { cargoAttributes, outputText } from "./process-trace.ts";

if (traceFile() && isMainThread && process.env.UE_SHED_TRACE_PROCESSES !== "0") {
	const name = processName(process.argv.slice(1));
	if (name !== undefined) {
		const span = startSpan(name, { "process.pid": process.pid });
		process.env.TRACEPARENT = formatTraceparent(span.traceId, span.spanId);
		process.on("exit", (code) => {
			span.setAttributes({ "process.exit_code": code });
			span.end(code === 0 ? "ok" : "error");
		});
		traceSubprocesses();
	}
}

function processName(argv: readonly string[]) {
	const [entry, ...rest] = argv;
	if (entry === undefined) return undefined;
	const file = basename(entry);
	// Vitest workers are covered by the per-file spans from the Vitest reporter.
	if (/[\\/]vitest[\\/]dist[\\/]/.test(entry)) return undefined;
	const label = /^pnpm\.c?js$/.test(file)
		? "pnpm"
		: file === "vitest.mjs"
			? "vitest"
			: `node ${/[\\/]scripts[\\/]/.test(entry) ? `scripts/${file}` : file}`;
	return `${label} ${rest.join(" ")}`.trim().slice(0, 160);
}

interface Subprocess {
	readonly name: string;
	readonly tool: string;
}

/**
 * Names the program a spawn call runs, looking through `cmd.exe /d /s /c` and shell strings, or
 * returns undefined when it is a Node process (which traces itself) or a long-lived build service
 * whose lifetime says nothing about the gate.
 */
export function describeSubprocess(
	file: string,
	args: readonly string[] = [],
	shell = false
): Subprocess | undefined {
	let words = shell && args.length === 0 ? commandWords(file) : [file, ...args];
	if (/^cmd(?:\.exe)?$/i.test(basename(words[0] ?? ""))) {
		// pnpm and the scripts' Windows shims run `cmd.exe /d /s /c <command line>`, as separate
		// arguments or as one verbatim string.
		const command = /(?:^|\s)\/c\s+([\s\S]*)$/i.exec(words.slice(1).join(" "))?.[1];
		if (command !== undefined) words = commandWords(command.replace(/^"([\s\S]*)"$/, "$1"));
	}
	const program = words[0] ?? "";
	const tool = basename(program);
	if (
		program === process.execPath ||
		/^(?:node|pnpm|npm|npx|pnpx)(?:\.exe|\.cmd)?$/i.test(tool) ||
		/^esbuild(?:\.exe)?$/i.test(tool)
	) {
		return undefined;
	}
	return { name: [tool, ...words.slice(1)].join(" ").slice(0, 160), tool };
}

/** Splits a command line into words, keeping double-quoted words (paths with spaces) whole. */
function commandWords(commandLine: string) {
	return [...commandLine.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");
}

function subprocessSpan(subprocess: Subprocess) {
	return startSpan(subprocess.name, {
		"process.tool": subprocess.tool,
		"trace.subprocess": true
	});
}

type ArgumentList = readonly string[];

type ProcessOptions = SpawnOptions | SpawnSyncOptions | ExecFileSyncOptions;

function isArgumentList(value: ArgumentList | ProcessOptions | undefined): value is ArgumentList {
	return Array.isArray(value);
}

const traceparentTrace = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * The child's environment: parented to `span` when the child gets one, otherwise to this
 * process's innermost active span. Scripts often copy `process.env` before they start a span, so
 * within one trace that copy's TRACEPARENT is stale; one naming another trace was set on purpose.
 */
export function parentedEnvironment(
	environment: NodeJS.ProcessEnv | undefined,
	span: Span | undefined,
	current = process.env.TRACEPARENT
) {
	if (span !== undefined) return span.environment(environment ?? process.env);
	const given = environment?.TRACEPARENT;
	if (environment === undefined || current === undefined || given === undefined)
		return environment;
	if (given === current) return environment;
	const sameTrace = traceparentTrace.exec(given)?.[1] === traceparentTrace.exec(current)?.[1];
	return sameTrace ? { ...environment, TRACEPARENT: current } : environment;
}

function endSync(span: Span, subprocess: Subprocess, result: SpawnSyncReturns<string | Buffer>) {
	if (/^cargo(?:\.exe)?$/i.test(subprocess.tool)) {
		span.setAttributes(cargoAttributes(outputText(result.stderr)));
	}
	span.setAttributes({ "process.exit_code": result.status ?? -1 });
	span.end(result.status === 0 && result.error === undefined ? "ok" : "error");
}

function endReturned(span: Span) {
	span.setAttributes({ "process.exit_code": 0 });
	span.end("ok");
}

/**
 * Replaces the `child_process` exports with traced versions. `fork`, `exec` and `execFile` start
 * Node processes or call the patched functions, and Node's own internals keep the originals.
 */
function traceSubprocesses() {
	const original = {
		spawn: childProcess.spawn,
		spawnSync: childProcess.spawnSync,
		execFileSync: childProcess.execFileSync,
		execSync: childProcess.execSync
	};
	const open = new Set<Span>();
	process.on("exit", () => {
		for (const span of open) {
			span.setAttributes({ "process.still_running": true });
			span.end("ok");
		}
	});

	const traced = <Result>(
		subprocess: Subprocess | undefined,
		call: (span: Span | undefined) => Result,
		finish: (span: Span, subprocess: Subprocess, result: Result) => void
	): Result => {
		if (subprocess === undefined || insideExplicitProcessSpan()) return call(undefined);
		const span = subprocessSpan(subprocess);
		let result: Result;
		try {
			result = call(span);
		} catch (cause) {
			// execFileSync and execSync throw for a non-zero exit as well as a failed start.
			span.end("error");
			throw cause;
		}
		finish(span, subprocess, result);
		return result;
	};

	function spawnSync(
		file: string,
		argsOrOptions?: ArgumentList | SpawnSyncOptions,
		maybeOptions?: SpawnSyncOptions
	) {
		const args = isArgumentList(argsOrOptions) ? argsOrOptions : [];
		const options = isArgumentList(argsOrOptions) ? maybeOptions : argsOrOptions;
		return traced(
			describeSubprocess(file, args, Boolean(options?.shell)),
			(span) => {
				const spawnOptions = { ...options, env: parentedEnvironment(options?.env, span) };
				// Only pass arguments the caller passed: Node warns about shell commands with them.
				return args.length > 0
					? original.spawnSync(file, args, spawnOptions)
					: original.spawnSync(file, spawnOptions);
			},
			endSync
		);
	}

	function execFileSync(
		file: string,
		argsOrOptions?: ArgumentList | ExecFileSyncOptions,
		maybeOptions?: ExecFileSyncOptions
	) {
		const args = isArgumentList(argsOrOptions) ? argsOrOptions : [];
		const options = isArgumentList(argsOrOptions) ? maybeOptions : argsOrOptions;
		return traced(
			describeSubprocess(file, args, Boolean(options?.shell)),
			(span) => {
				const execOptions = { ...options, env: parentedEnvironment(options?.env, span) };
				return args.length > 0
					? original.execFileSync(file, args, execOptions)
					: original.execFileSync(file, execOptions);
			},
			endReturned
		);
	}

	function execSync(command: string, options?: ExecSyncOptions) {
		return traced(
			describeSubprocess(command, [], true),
			(span) =>
				original.execSync(command, {
					...options,
					env: parentedEnvironment(options?.env, span)
				}),
			endReturned
		);
	}

	function spawn(
		file: string,
		argsOrOptions?: ArgumentList | SpawnOptions,
		maybeOptions?: SpawnOptions
	): ChildProcess {
		const args = isArgumentList(argsOrOptions) ? argsOrOptions : [];
		const options = isArgumentList(argsOrOptions) ? maybeOptions : argsOrOptions;
		return traced(
			describeSubprocess(file, args, Boolean(options?.shell)),
			(span) => {
				const spawnOptions = { ...options, env: parentedEnvironment(options?.env, span) };
				return args.length > 0
					? original.spawn(file, args, spawnOptions)
					: original.spawn(file, spawnOptions);
			},
			(span, _subprocess, child) => {
				open.add(span);
				child.once("error", () => {
					open.delete(span);
					span.end("error");
				});
				child.once("exit", (code, signal) => {
					open.delete(span);
					span.setAttributes({
						"process.exit_code": code ?? -1,
						"process.signal": signal ?? undefined
					});
					// A process stopped by a signal was stopped on purpose (an editor or server at
					// the end of its test); its exit code says nothing about the gate.
					span.end(code === 0 || signal !== null ? "ok" : "error");
				});
			}
		);
	}

	Object.assign(childProcess, { spawn, spawnSync, execFileSync, execSync });
	syncBuiltinESMExports();
}
