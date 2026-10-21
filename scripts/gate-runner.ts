/**
 * Runs package.json gates as traced trees of commands. `pnpm run <script>` steps inside `&&` chains
 * are expanded, so a gate becomes a tree of the real commands it runs, each with its own span and
 * log. Every Node process in the run records a span (`trace-process.ts`), Vitest records a span per
 * test file and test (`vitest-trace-reporter.ts`), and Unreal and Cargo runs record their own spans
 * (`process-trace.ts`); see `gate-trace.ts` for how they join one trace. Used by
 * `pnpm check:time` (`time-gate.ts`) and `pnpm release:prepare`.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync
} from "node:fs";
import { cpus, totalmem } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatTraceparent, nowUs, startSpan, type Span, type SpanRecord } from "./gate-trace.ts";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	parseJson,
	parseJsonObject,
	type JsonValue
} from "./json.ts";
import { cargoAttributes } from "./process-trace.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

export interface Step {
	readonly name: string;
	readonly command: string;
	readonly depth: number;
	readonly children: readonly Step[];
}

export interface Timing {
	readonly name: string;
	readonly command: string;
	readonly depth: number;
	readonly startMs: number;
	readonly durationMs: number;
	readonly status: "passed" | "failed" | "skipped";
	readonly log?: string;
	readonly children: readonly Timing[];
}

const scriptReference = /^pnpm (?:run )?([\w:.-]+)$/;

export function expandScript(
	scripts: Readonly<Record<string, string>>,
	name: string,
	depth = 0
): Step {
	const command = scripts[name];
	if (command === undefined) throw new Error(`package.json has no "${name}" script.`);
	return { name, command, depth, children: expandCommand(scripts, command, depth + 1) };
}

function expandCommand(
	scripts: Readonly<Record<string, string>>,
	command: string,
	depth: number
): readonly Step[] {
	if (/\|\||;|\|/.test(command)) return [];
	const parts = command.split(" && ").map((part) => part.trim());
	if (parts.length === 1) {
		const reference = scriptReference.exec(parts[0]!);
		return reference && scripts[reference[1]!] !== undefined
			? [expandScript(scripts, reference[1]!, depth)]
			: [];
	}
	return parts.map((part) => {
		const reference = scriptReference.exec(part);
		return reference && scripts[reference[1]!] !== undefined
			? expandScript(scripts, reference[1]!, depth)
			: { name: part, command: part, depth, children: [] };
	});
}

/** Reads the spans every process appended, skipping a line a killed process left unfinished. */
export function readSpans(file: string): SpanRecord[] {
	if (!existsSync(file)) return [];
	const spans: SpanRecord[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		let value;
		try {
			value = parseJson(line);
		} catch {
			continue;
		}
		const span = parseSpan(value);
		if (span) spans.push(span);
	}
	return spans;
}

function parseSpan(value: JsonValue): SpanRecord | undefined {
	if (!isJsonObject(value)) return undefined;
	const { traceId, spanId, parentSpanId, name, startUs, endUs, status, attributes } = value;
	if (
		traceId === undefined ||
		!isJsonString(traceId) ||
		spanId === undefined ||
		!isJsonString(spanId) ||
		name === undefined ||
		!isJsonString(name) ||
		startUs === undefined ||
		!isJsonNumber(startUs) ||
		endUs === undefined ||
		!isJsonNumber(endUs)
	) {
		return undefined;
	}
	const parsedAttributes = new Map<string, string | number | boolean>();
	if (attributes !== undefined && isJsonObject(attributes)) {
		for (const [key, attribute] of Object.entries(attributes)) {
			if (
				isJsonString(attribute) ||
				isJsonNumber(attribute) ||
				attribute === true ||
				attribute === false
			) {
				parsedAttributes.set(key, attribute);
			}
		}
	}
	return {
		traceId,
		spanId,
		parentSpanId:
			parentSpanId !== undefined && isJsonString(parentSpanId) ? parentSpanId : undefined,
		name,
		startUs,
		endUs,
		status: status === "error" ? "error" : "ok",
		attributes: Object.fromEntries(parsedAttributes)
	};
}

/**
 * Converts spans to Chrome trace events. Spans keep their parent's track unless they overlap a
 * span on it that is not an ancestor, so parallel work (Vitest workers, concurrent tests) gets its
 * own track. A `trace.lane` attribute names the track a span and its children start on.
 */
export function chromeTrace(spans: readonly SpanRecord[], originUs: number) {
	const byId = new Map(spans.map((span) => [span.spanId, span]));
	const depth = (span: SpanRecord) => {
		let count = 0;
		for (let parent = span.parentSpanId; parent && byId.has(parent); count += 1) {
			parent = byId.get(parent)!.parentSpanId;
		}
		return count;
	};
	const ordered = spans
		.map((span) => ({ span, depth: depth(span) }))
		.toSorted((a, b) => a.span.startUs - b.span.startUs || a.depth - b.depth);
	const lanes: { base: string; name: string; open: SpanRecord[] }[] = [];
	const laneOf = new Map<string, number>();
	const isAncestor = (candidate: SpanRecord, span: SpanRecord) => {
		for (let parent = span.parentSpanId; parent; parent = byId.get(parent)?.parentSpanId) {
			if (parent === candidate.spanId) return true;
		}
		return false;
	};
	const fits = (lane: number, span: SpanRecord) => {
		const open = lanes[lane]!.open;
		while (open.length > 0 && open.at(-1)!.endUs <= span.startUs) open.pop();
		return open.length === 0 || isAncestor(open.at(-1)!, span);
	};
	const place = (lane: number, span: SpanRecord) => {
		lanes[lane]!.open.push(span);
		laneOf.set(span.spanId, lane);
	};
	for (const { span } of ordered) {
		const hint = span.attributes["trace.lane"];
		const preferred =
			hint === undefined
				? (laneOf.get(span.parentSpanId ?? "") ?? 0)
				: lanes.findIndex((lane) => lane.base === String(hint));
		const baseName = hint === undefined ? (lanes[preferred]?.base ?? "gate") : String(hint);
		if (preferred >= 0 && lanes[preferred] && fits(preferred, span)) {
			place(preferred, span);
			continue;
		}
		let lane = lanes.findIndex(
			(candidate, index) => candidate.base === baseName && fits(index, span)
		);
		if (lane < 0) {
			const siblings = lanes.filter((candidate) => candidate.base === baseName).length;
			lane =
				lanes.push({
					base: baseName,
					name: siblings === 0 ? baseName : `${baseName} (${siblings + 1})`,
					open: []
				}) - 1;
		}
		place(lane, span);
	}
	return {
		displayTimeUnit: "ms",
		traceEvents: [
			...lanes.map((lane, index) => ({
				name: "thread_name",
				ph: "M",
				pid: 1,
				tid: index + 1,
				args: { name: lane.name }
			})),
			...ordered.map(({ span }) => ({
				name: span.name,
				cat: span.status,
				ph: "X",
				ts: span.startUs - originUs,
				dur: Math.max(0, span.endUs - span.startUs),
				pid: 1,
				tid: (laneOf.get(span.spanId) ?? 0) + 1,
				args: span.attributes
			}))
		]
	};
}

/** The scripts of a checkout's package.json. */
export function readPackageScripts(root = repositoryRoot) {
	const manifestScripts = parseJsonObject(
		readFileSync(join(root, "package.json"), "utf8")
	).scripts;
	if (manifestScripts === undefined || !isJsonObject(manifestScripts)) {
		throw new Error("package.json has no scripts.");
	}
	const scripts: Record<string, string> = {};
	for (const [name, command] of Object.entries(manifestScripts)) {
		if (isJsonString(command)) scripts[name] = command;
	}
	return scripts;
}

export interface GateSession {
	readonly outputDirectory: string;
	readonly spansFile: string;
	readonly rootSpan: Span;
	readonly startedAt: Date;
	readonly commit: string;
	/** Environment for traced commands run from `cwd`: the preload, its `node_modules/.bin`. */
	environment(cwd: string, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
	/** A new numbered log path in the output directory. */
	nextLog(): string;
}

/**
 * Starts the root span of a traced run writing to `outputDirectory`. Every process started with
 * `environment()` appends its spans to the run's `spans.jsonl`.
 */
export function startGateSession({
	name,
	outputDirectory,
	attributes = {}
}: {
	readonly name: string;
	readonly outputDirectory: string;
	readonly attributes?: Readonly<Record<string, string | number | boolean | undefined>>;
}): GateSession {
	mkdirSync(outputDirectory, { recursive: true });
	const spansFile = join(outputDirectory, "spans.jsonl");
	delete process.env.TRACEPARENT;
	process.env.UE_SHED_TRACE_FILE = spansFile;
	const preload = `--import=${pathToFileURL(join(repositoryRoot, "scripts", "trace-process.ts")).href}`;
	const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd: repositoryRoot,
		encoding: "utf8"
	}).stdout.trim();
	const rootSpan = startSpan(name, {
		...attributes,
		"git.commit": commit,
		"host.cpus": cpus().length,
		ci: Boolean(process.env.CI)
	});
	let logIndex = 0;
	return {
		outputDirectory,
		spansFile,
		rootSpan,
		startedAt: new Date(),
		commit,
		environment(cwd, base = process.env) {
			return {
				...base,
				UE_SHED_TRACE_FILE: spansFile,
				NODE_OPTIONS: [base.NODE_OPTIONS, preload].filter(Boolean).join(" "),
				PATH: [join(cwd, "node_modules", ".bin"), base.PATH ?? ""].join(delimiter)
			};
		},
		nextLog() {
			logIndex += 1;
			return join(outputDirectory, `${String(logIndex).padStart(2, "0")}.log`);
		}
	};
}

export interface StepRunner {
	run(step: Step, parent: Span): Promise<Timing>;
	readonly failed: boolean;
}

/**
 * Runs a step tree one command at a time under `parent`. After a failure the remaining commands
 * are skipped unless `keepGoing`. `label` prefixes the progress lines of a lane that runs in
 * parallel with others.
 */
export function createStepRunner({
	session,
	cwd,
	env,
	keepGoing = false,
	label
}: {
	readonly session: GateSession;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly keepGoing?: boolean;
	readonly label?: string;
}): StepRunner {
	let failed = false;
	const prefix = label === undefined ? "" : `[${label}] `;
	// Milliseconds since the run started, so lanes running in parallel share one time axis.
	const now = () => (nowUs() - session.rootSpan.startUs) / 1000;

	const runLeaf = (step: Step, parent: Span): Promise<Timing> => {
		const startMs = now();
		if (failed && !keepGoing) {
			return Promise.resolve({
				...step,
				startMs,
				durationMs: 0,
				status: "skipped",
				children: []
			});
		}
		const log = session.nextLog();
		const span = startSpan(step.name, { "gate.command": step.command }, { parent });
		process.stdout.write(`${prefix}${"  ".repeat(step.depth)}▶ ${step.name.slice(0, 110)}\n`);
		return new Promise((resolveTiming) => {
			const output = createWriteStream(log);
			const child = spawn(step.command, {
				cwd,
				env: { ...env, TRACEPARENT: formatTraceparent(span.traceId, span.spanId) },
				shell: true,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true
			});
			child.stdout.pipe(output, { end: false });
			child.stderr.pipe(output, { end: false });
			child.on("close", (code) => {
				output.end(() => {
					const durationMs = now() - startMs;
					const status = code === 0 ? "passed" : "failed";
					if (status === "failed") failed = true;
					if (step.command.startsWith("cargo ")) {
						span.setAttributes(cargoAttributes(readFileSync(log, "utf8")));
					}
					span.setAttributes({ "process.exit_code": code ?? -1, "gate.log": log });
					span.end(status === "passed" ? "ok" : "error");
					process.stdout.write(
						`${prefix}${"  ".repeat(step.depth)}${status === "passed" ? "✓" : "✗"} ${seconds(durationMs)}${status === "failed" ? `  (log: ${log})` : ""}\n`
					);
					resolveTiming({ ...step, startMs, durationMs, status, log, children: [] });
				});
			});
		});
	};

	const run = async (step: Step, parent: Span): Promise<Timing> => {
		if (step.children.length === 0) return runLeaf(step, parent);
		const span = startSpan(step.name, { "gate.command": step.command }, { parent });
		const startMs = now();
		const children: Timing[] = [];
		for (const child of step.children) children.push(await run(child, span));
		const durationMs = now() - startMs;
		const status = children.some((child) => child.status === "failed")
			? "failed"
			: children.every((child) => child.status === "skipped")
				? "skipped"
				: "passed";
		span.end(status === "failed" ? "error" : "ok");
		return { ...step, startMs, durationMs, status, children };
	};

	return {
		run,
		get failed() {
			return failed;
		}
	};
}

/**
 * Ends a traced run: writes `trace.json` (open it in https://ui.perfetto.dev) and `summary.json`
 * to the output directory, appends a line to `out/gate-timing/history.jsonl`, and returns the
 * run's spans.
 */
export function finishGateSession(
	session: GateSession,
	{
		script,
		root,
		summary = {}
	}: {
		readonly script: string;
		readonly root: Timing;
		readonly summary?: Readonly<Record<string, JsonValue>>;
	}
): SpanRecord[] {
	session.rootSpan.end(root.status === "failed" ? "error" : "ok");
	const spans = readSpans(session.spansFile);
	writeFileSync(
		join(session.outputDirectory, "trace.json"),
		JSON.stringify(chromeTrace(spans, session.rootSpan.startUs))
	);
	writeFileSync(
		join(session.outputDirectory, "summary.json"),
		JSON.stringify(
			{
				script,
				commit: session.commit,
				startedAt: session.startedAt.toISOString(),
				machine: { cpus: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30) },
				...summary,
				root
			},
			undefined,
			"\t"
		)
	);
	const timingRoot = join(repositoryRoot, "out", "gate-timing");
	mkdirSync(timingRoot, { recursive: true });
	const topLevel = root.children.length > 0 ? root.children : [root];
	appendFileSync(
		join(timingRoot, "history.jsonl"),
		`${JSON.stringify({
			script,
			commit: session.commit,
			startedAt: session.startedAt.toISOString(),
			status: root.status,
			durationMs: Math.round(root.durationMs),
			cpus: cpus().length,
			steps: Object.fromEntries(
				topLevel.map((step) => [step.name.slice(0, 80), Math.round(step.durationMs)])
			),
			trace: session.outputDirectory
		})}\n`
	);
	return spans;
}

export function printReport(root: Timing, spans: readonly SpanRecord[]) {
	const flat: Timing[] = [];
	const walk = (timing: Timing) => {
		flat.push(timing);
		timing.children.forEach(walk);
	};
	walk(root);
	const leaves = flat.filter((timing) => timing.children.length === 0 && timing.durationMs > 0);
	console.log("Slowest commands:");
	for (const leaf of leaves.toSorted((a, b) => b.durationMs - a.durationMs).slice(0, 15)) {
		console.log(`  ${seconds(leaf.durationMs).padStart(8)}  ${leaf.command.slice(0, 120)}`);
	}
	const repeated = new Map<string, number[]>();
	for (const leaf of leaves) {
		repeated.set(leaf.command, [...(repeated.get(leaf.command) ?? []), leaf.durationMs]);
	}
	const duplicates = [...repeated].filter(([, runs]) => runs.length > 1);
	if (duplicates.length > 0) {
		console.log("\nCommands that ran more than once:");
		for (const [command, runs] of duplicates) {
			console.log(
				`  ${runs.length}× ${seconds(runs.reduce((sum, ms) => sum + ms, 0)).padStart(8)}  ${command.slice(0, 110)}`
			);
		}
	}

	const files = spans.filter((span) => span.attributes["vitest.project"] !== undefined);
	if (files.length > 0) {
		const runs = spans.filter((span) => span.name === "vitest test files");
		const wallMs = runs.reduce((sum, span) => sum + (span.endUs - span.startUs) / 1000, 0);
		const total = (key: string) =>
			files.reduce((sum, span) => sum + Number(span.attributes[key] ?? 0), 0);
		const fileMs = files.reduce((sum, span) => sum + (span.endUs - span.startUs) / 1000, 0);
		console.log(
			`\nVitest: ${files.length} files, ${seconds(wallMs)} wall, ${seconds(fileMs)} of file time ` +
				`(${(fileMs / Math.max(wallMs, 1)).toFixed(1)}× parallel); setup ${seconds(total("vitest.setup_ms"))}, ` +
				`import ${seconds(total("vitest.import_ms"))}, tests ${seconds(total("vitest.test_ms"))}`
		);
		console.log("Slowest test files (setup / import / tests):");
		for (const file of files
			.toSorted((a, b) => b.endUs - b.startUs - (a.endUs - a.startUs))
			.slice(0, 15)) {
			const ms = (key: string) => seconds(Number(file.attributes[key] ?? 0));
			console.log(
				`  ${seconds((file.endUs - file.startUs) / 1000).padStart(8)}  ${ms("vitest.setup_ms")} / ${ms("vitest.import_ms")} / ${ms("vitest.test_ms")}  ${file.name}`
			);
		}
		const fileIds = new Set(files.map((file) => file.spanId));
		const tests = spans.filter(
			(span) =>
				fileIds.has(span.parentSpanId ?? "") &&
				span.attributes["vitest.state"] !== undefined
		);
		console.log("Slowest tests:");
		for (const test of tests
			.toSorted((a, b) => b.endUs - b.startUs - (a.endUs - a.startUs))
			.slice(0, 10)) {
			console.log(
				`  ${seconds((test.endUs - test.startUs) / 1000).padStart(8)}  ${test.name.slice(0, 120)}`
			);
		}
	}

	const e2e = spans.filter((span) => span.attributes["playwright.test_id"] !== undefined);
	if (e2e.length > 0) {
		const runs = spans.filter((span) => span.name === "playwright e2e");
		const wallMs = runs.reduce((sum, span) => sum + (span.endUs - span.startUs) / 1000, 0);
		const skipped = e2e.filter((span) => span.attributes["playwright.status"] === "skipped");
		const retries = e2e.filter((span) => Number(span.attributes["playwright.retry"]) > 0);
		console.log(
			`\nPlaywright E2E: ${e2e.length} attempts, ${seconds(wallMs)} runner wall; ` +
				`${skipped.length} skipped, ${retries.length} retries`
		);
		console.log("Slowest E2E attempts (includes fixtures and hooks):");
		for (const span of e2e
			.toSorted((a, b) => b.endUs - b.startUs - (a.endUs - a.startUs))
			.slice(0, 10)) {
			console.log(
				`  ${seconds((span.endUs - span.startUs) / 1000).padStart(8)}  ` +
					`${String(span.attributes["playwright.status"])} retry ${String(span.attributes["playwright.retry"])}  ${span.name}`
			);
		}
	}

	const unreal = spans.filter((span) => span.attributes["unreal.tool"] !== undefined);
	if (unreal.length > 0) {
		console.log("\nUnreal processes (engine startup / work / shutdown):");
		for (const span of unreal) {
			const phase = (name: string) => {
				const child = spans.find(
					(candidate) => candidate.parentSpanId === span.spanId && candidate.name === name
				);
				return child ? seconds((child.endUs - child.startUs) / 1000) : "-";
			};
			const detail =
				span.attributes["unreal.build.up_to_date"] !== undefined
					? `up to date: ${String(span.attributes["unreal.build.up_to_date"])}, actions: ${String(span.attributes["unreal.build.actions"])}`
					: `${phase("engine startup")} / ${phase("work")} / ${phase("shutdown")}`;
			console.log(
				`  ${seconds((span.endUs - span.startUs) / 1000).padStart(8)}  ${String(span.attributes["unreal.engine"])}  ${span.name.slice(0, 70)}  (${detail})`
			);
		}
	}
}

export function seconds(ms: number) {
	return `${(ms / 1000).toFixed(1)}s`;
}
