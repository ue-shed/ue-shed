/**
 * Actual desktop Game Text measurement: drives the production Electron Workbench through
 * launch, Project Index readiness, a cold Game Text scan, interactive search and facets, an
 * unchanged rescan and a warm reopen, while sampling aggregate process memory and the main
 * process event loop.
 *
 * Every run uses a fresh process, an isolated profile and an empty derived cache. Several
 * builds (`--app label=<workbench dir>`) alternate run by run, as ADR 0010 requires. Results
 * include a hash of every indexed row so builds can be compared for identical output. Before
 * each run the harness waits (`--quiet-wait-ms`) for other build and test processes to finish
 * and records any it gave up on.
 *
 * Each `<workbench dir>` is a built `apps/workbench` whose checkout has a release reader at
 * `target/release/uasset`. Memory is the working set of that checkout's Electron and reader
 * processes, sampled every 250 ms. Readiness is checked in the page every 10 ms and timed by
 * the page's clock, so a timing is not rounded up to the next poll of this process. `--trace
 * <dir>` also records the main process's spans, main and renderer CPU profiles of the cold scan,
 * the rescan and the warm reopen, and each run's milestones; tracing slows the run, so traced
 * timings are for profiling only.
 *
 * pnpm benchmark:game-text-desktop --project <project dir> \
 *   --app before=<dir> --app after=<dir> --runs 3 --output <file>
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import {
	createWriteStream,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Schema } from "effect";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

interface AppUnderTest {
	readonly label: string;
	readonly workbenchRoot: string;
	readonly checkoutRoot: string;
	readonly reader: string;
}

interface Options {
	readonly apps: ReadonlyArray<AppUnderTest>;
	readonly output: string;
	readonly projectRoot: string;
	readonly queries: ReadonlyArray<string>;
	readonly runs: number;
	readonly quietWaitMs: number;
	/** Writes the main process's console span export here; slows the run, so profile only. */
	readonly trace: string | undefined;
}

interface MemorySample {
	readonly at: number;
	readonly totalMiB: number;
	readonly byName: Readonly<Record<string, number>>;
}

type StallReport = typeof StallReport.Type;

interface SearchTiming {
	readonly query: string;
	readonly wallMs: number;
	readonly reportedMs: number | undefined;
	readonly total: string;
}

interface RunResult {
	readonly label: string;
	readonly run: number;
	readonly busyBefore: ReadonlyArray<string>;
	readonly mainPid: number | undefined;
	readonly launchToIndexReadyMs: number;
	readonly coldScanMs: number;
	readonly launchToUsableMs: number;
	readonly coldScanMainStall: StallReport;
	readonly coldScanRendererLongTasks: StallReport;
	readonly firstResultsSummary: string;
	readonly searches: ReadonlyArray<SearchTiming>;
	readonly facet: SearchTiming | undefined;
	readonly rescanMs: number;
	readonly rescanMainStall: StallReport;
	readonly coldPeakRssMiB: number;
	readonly coldPeakBreakdownMiB: Readonly<Record<string, number>>;
	readonly settledRssMiB: number;
	readonly settledBreakdownMiB: Readonly<Record<string, number>>;
	readonly coldPeakAtMs: number;
	readonly warmLaunchToUsableMs: number;
	/** Results first shown after a warm launch: reopened from the cache, or after a clicked scan. */
	readonly warmLaunchToResultsMs: number;
	readonly warmLaunchToIndexReadyMs: number;
	readonly warmFirstSearch: SearchTiming;
	readonly warmMainStall: StallReport;
	readonly warmPeakRssMiB: number;
	readonly warmSettledRssMiB: number;
	readonly diskBytes: Readonly<Record<string, number>>;
	/** Page and harness times of each step, in epoch milliseconds. */
	readonly milestones: Readonly<Record<string, number>>;
	readonly resultHash: string;
	readonly resultRows: number;
	/** Memory samples of the cold session, relative to the scan click. */
	readonly coldTimeline: ReadonlyArray<{
		readonly atMs: number;
		readonly byName: Readonly<Record<string, number>>;
	}>;
}

function parseOptions(argv: ReadonlyArray<string>): Options {
	const apps: AppUnderTest[] = [];
	let output = resolve("test-results/game-text-desktop/result.json");
	let projectRoot: string | undefined;
	let runs = 3;
	let quietWaitMs = 20 * 60_000;
	let trace: string | undefined;
	const queries: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		const value = argv[index + 1];
		if (value === undefined) throw new Error(`${name} needs a value`);
		index += 1;
		if (name === "--app") {
			const separator = value.indexOf("=");
			if (separator <= 0) throw new Error("--app takes label=<workbench directory>");
			const workbenchRoot = resolve(value.slice(separator + 1));
			const checkoutRoot = resolve(workbenchRoot, "../..");
			apps.push({
				label: value.slice(0, separator),
				workbenchRoot,
				checkoutRoot,
				reader: join(
					checkoutRoot,
					"target",
					"release",
					process.platform === "win32" ? "uasset.exe" : "uasset"
				)
			});
		} else if (name === "--output") output = resolve(value);
		else if (name === "--project") projectRoot = resolve(value);
		else if (name === "--runs") runs = Number(value);
		else if (name === "--query") queries.push(value);
		else if (name === "--quiet-wait-ms") quietWaitMs = Number(value);
		else if (name === "--trace") trace = resolve(value);
		else throw new Error(`Unknown option ${name}`);
	}
	if (projectRoot === undefined) throw new Error("--project is required");
	if (apps.length === 0) throw new Error("At least one --app is required");
	if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
	return {
		apps,
		output,
		projectRoot,
		queries: queries.length > 0 ? queries : ["the", "zz"],
		runs,
		quietWaitMs,
		trace
	};
}

function powershell(script: string): string {
	const result = spawnSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", script],
		{
			encoding: "utf8",
			windowsHide: true
		}
	);
	return result.stdout ?? "";
}

/** Heavy processes from other work that would distort a timed run. */
function foreignBusyProcesses(): string[] {
	if (process.platform !== "win32") return [];
	const lines = powershell(
		"Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(rustc|cargo|link|clippy-driver|node|tsgo|tsc)(\\.exe)?$' } | " +
			'ForEach-Object { "$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)" }'
	)
		.split(/\r?\n/u)
		.filter((line) => line.trim() !== "");
	return lines.filter((line) => {
		const [pid, name, ...rest] = line.split("	");
		const command = rest.join("	");
		if (Number(pid) === process.pid || command.includes("benchmark-game-text-desktop"))
			return false;
		if (name?.startsWith("node"))
			return /vitest|tsgo|[\\/]tsc|typescript[\\/]bin|oxlint|oxfmt/u.test(command);
		return true;
	});
}

async function waitForQuiet(limitMs: number): Promise<string[]> {
	const started = performance.now();
	let busy = foreignBusyProcesses();
	while (busy.length > 0 && performance.now() - started < limitMs) {
		process.stdout.write(`waiting for ${busy.length} foreign build/test processes\n`);
		await new Promise((done) => setTimeout(done, 15_000));
		busy = foreignBusyProcesses();
	}
	return busy.map((line) => line.slice(0, 200));
}

/** Samples the working set of every Electron and reader process from one checkout. */
function startMemorySampler(checkoutRoot: string, samples: MemorySample[]): ChildProcess {
	const root = checkoutRoot.replaceAll("'", "''");
	const script = [
		"$ErrorActionPreference = 'SilentlyContinue'",
		"while ($true) {",
		"  $line = @()",
		`  foreach ($p in Get-Process electron,uasset) { if ($p.Path -and $p.Path.StartsWith('${root}', [StringComparison]::OrdinalIgnoreCase)) { $line += "$($p.ProcessName):$($p.Id)=$($p.WorkingSet64)" } }`,
		"  [Console]::Out.WriteLine(($line -join ' '))",
		"  [Console]::Out.Flush()",
		"  Start-Sleep -Milliseconds 250",
		"}"
	].join("\n");
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true
	});
	let pending = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		pending += chunk;
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			const line = pending.slice(0, newline).trim();
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
			const byName: Record<string, number> = {};
			let total = 0;
			for (const entry of line.split(" ")) {
				const [name, bytes] = entry.split("=");
				if (!name || bytes === undefined) continue;
				const mib = Number(bytes) / 1_048_576;
				byName[name] = (byName[name] ?? 0) + mib;
				total += mib;
			}
			samples.push({ at: performance.now(), totalMiB: total, byName });
		}
	});
	return child;
}

function peak(samples: ReadonlyArray<MemorySample>, from: number, to: number) {
	let best: MemorySample | undefined;
	for (const sample of samples)
		if (sample.at >= from && sample.at <= to && (!best || sample.totalMiB > best.totalMiB))
			best = sample;
	return best ?? { at: from, totalMiB: 0, byName: {} };
}

function settled(samples: ReadonlyArray<MemorySample>, at: number) {
	const after = samples.filter((sample) => sample.at <= at);
	return after.at(-1) ?? { at, totalMiB: 0, byName: {} };
}

function directoryBytes(path: string): number {
	let total = 0;
	let entries;
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) total += directoryBytes(child);
		else if (entry.isFile()) total += statSync(child).size;
	}
	return total;
}

function launchEnvironment(
	app: AppUnderTest,
	projectRoot: string,
	sessionRoot: string,
	trace: boolean
) {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key === "ELECTRON_RUN_AS_NODE" || key.startsWith("UE_SHED_"))
			continue;
		environment[key] = value;
	}
	return {
		...environment,
		ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
		UE_SHED_AUTHORING_SESSION_ROOT: sessionRoot,
		UE_SHED_PROJECT_ROOT: projectRoot,
		UE_SHED_REMEMBER_PROJECTS: "false",
		UE_SHED_UASSET_EXECUTABLE: app.reader,
		...(trace ? { UE_SHED_TELEMETRY_MODE: "console" } : undefined)
	};
}

async function launch(app: AppUnderTest, projectRoot: string, sessionRoot: string, trace?: string) {
	const require = createRequire(join(app.workbenchRoot, "package.json"));
	const executable = Schema.decodeUnknownSync(Schema.String)(require("electron"));
	const application = await electron.launch({
		args: [app.workbenchRoot, `--user-data-dir=${join(sessionRoot, "profile")}`],
		cwd: app.workbenchRoot,
		env: launchEnvironment(app, projectRoot, sessionRoot, trace !== undefined),
		executablePath: executable,
		timeout: 120_000
	});
	if (trace !== undefined) {
		mkdirSync(dirname(trace), { recursive: true });
		const stream = createWriteStream(trace, { flags: "a" });
		application.process().stdout?.pipe(stream);
		application.process().stderr?.pipe(stream);
	}
	const page = await application.firstWindow();
	await application.evaluate(({ BrowserWindow }) => {
		BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
	});
	return { application, page };
}

const StallReport = Schema.Struct({
	maxStallMs: Schema.Number,
	over50Ms: Schema.Number,
	over50TotalMs: Schema.Number
});
const decodeStallReport = Schema.decodeUnknownSync(StallReport);

// Scripts evaluated in Electron's processes are strings: this Node script has neither their DOM
// types nor their globals, and the TypeScript loader would inject helpers they lack.
/** A drift monitor on the Electron main thread's event loop: a 10 ms timer and its lateness. */
const mainStallStart = `(() => {
	if (globalThis.__ueShedStall) clearInterval(globalThis.__ueShedStall.timer);
	const monitor = { last: performance.now(), max: 0, over: 0, overTotal: 0, timer: undefined };
	monitor.timer = setInterval(() => {
		const now = performance.now();
		const stall = now - monitor.last - 10;
		monitor.last = now;
		if (stall > monitor.max) monitor.max = stall;
		if (stall > 50) {
			monitor.over += 1;
			monitor.overTotal += stall;
		}
	}, 10);
	globalThis.__ueShedStall = monitor;
})()`;
const mainStallRead = `({
	maxStallMs: globalThis.__ueShedStall?.max ?? 0,
	over50Ms: globalThis.__ueShedStall?.over ?? 0,
	over50TotalMs: globalThis.__ueShedStall?.overTotal ?? 0
})`;
/** Profiles the Electron main thread through its own inspector. */
const mainProfileStart = `new Promise((done) => {
	const session = new (process.getBuiltinModule("node:inspector").Session)();
	session.connect();
	globalThis.__ueShedProfiler = session;
	session.post("Profiler.enable", () =>
		session.post("Profiler.setSamplingInterval", { interval: 500 }, () =>
			session.post("Profiler.start", () => done(undefined))));
})`;
const mainProfileStop = `new Promise((done, fail) => {
	const session = globalThis.__ueShedProfiler;
	session.post("Profiler.stop", (error, result) => {
		session.disconnect();
		if (error) fail(error);
		else done(JSON.stringify(result.profile));
	});
})`;

async function startMainStallMonitor(application: ElectronApplication) {
	await application.evaluate(mainStallStart);
}

async function readMainStall(application: ElectronApplication) {
	return decodeStallReport(await application.evaluate(mainStallRead));
}

// Renderer long tasks, as strings: the page has DOM types this Node script does not.
const rendererLongTasksStart = `(() => {
	window.__ueShedLong?.observer.disconnect();
	const record = { max: 0, count: 0, total: 0, observer: undefined };
	record.observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			record.max = Math.max(record.max, entry.duration);
			record.count += 1;
			record.total += entry.duration;
		}
	});
	record.observer.observe({ type: "longtask", buffered: false });
	window.__ueShedLong = record;
})()`;
const rendererLongTasksRead = `({
	maxStallMs: window.__ueShedLong?.max ?? 0,
	over50Ms: window.__ueShedLong?.count ?? 0,
	over50TotalMs: window.__ueShedLong?.total ?? 0
})`;

async function startRendererLongTasks(page: Page) {
	await page.evaluate(rendererLongTasksStart);
}

async function readRendererLongTasks(page: Page) {
	return decodeStallReport(await page.evaluate(rendererLongTasksRead));
}

/** Records each IPC invoke's channel, start and settle times in the main process (traced runs). */
const ipcRecorderStart = `(() => {
	const electron = process.getBuiltinModule("module").createRequire(process.execPath)("electron");
	const handlers = electron.ipcMain._invokeHandlers;
	const calls = [];
	globalThis.__ueShedIpc = calls;
	for (const [channel, handler] of handlers ?? []) {
		if (handler.__ueShedRecorded) continue;
		const recorded = async (...args) => {
			const start = Date.now();
			try {
				return await handler(...args);
			} finally {
				calls.push({ call: channel, start, end: Date.now() });
			}
		};
		recorded.__ueShedRecorded = true;
		handlers.set(channel, recorded);
	}
})()`;
const IpcCalls = Schema.Array(
	Schema.Struct({ call: Schema.String, start: Schema.Number, end: Schema.Number })
);

/** Starts main and renderer CPU profiles; the returned function writes `<prefix>-*.cpuprofile`. */
async function startProfiles(application: ElectronApplication, page: Page) {
	const renderer = await page.context().newCDPSession(page);
	await renderer.send("Profiler.enable");
	await renderer.send("Profiler.setSamplingInterval", { interval: 500 });
	await renderer.send("Profiler.start");
	await application.evaluate(mainProfileStart);
	await application.evaluate(ipcRecorderStart);
	return async (prefix: string) => {
		const { profile } = await renderer.send("Profiler.stop");
		writeFileSync(`${prefix}-renderer.cpuprofile`, JSON.stringify(profile));
		await renderer.detach();
		writeFileSync(
			`${prefix}-main.cpuprofile`,
			Schema.decodeUnknownSync(Schema.String)(await application.evaluate(mainProfileStop))
		);
		const calls = Schema.decodeUnknownSync(IpcCalls)(
			await application.evaluate("globalThis.__ueShedIpc.splice(0)")
		);
		writeFileSync(`${prefix}-ipc.json`, `${JSON.stringify(calls, null, "\t")}\n`);
	};
}

const harnessStarted = performance.now();
function step(text: string) {
	process.stdout.write(`  [${((performance.now() - harnessStarted) / 1000).toFixed(1)} s] ${text}
`);
}

let observedPage: Page | undefined;

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string) {
	const started = performance.now();
	let reported = started;
	while (performance.now() - started < timeoutMs) {
		if (await predicate().catch(() => false)) return performance.now();
		if (performance.now() - reported > 60_000) {
			reported = performance.now();
			const seen = observedPage
				? await observedPage
						.getByRole("main")
						.innerText({ timeout: 2_000 })
						.then((text) => text.replaceAll(/\s+/gu, " ").slice(0, 600))
						.catch(() => "")
				: "";
			step(`still waiting for ${label}: ${seen}`);
		}
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

/**
 * Settled Game Text, checked in the page: Rescan enabled, no progress or scan readout, a line
 * count and a search total shown. Resolves to the page's time.
 */
const usableInPage = () => `(() => {
	const status = document.querySelector('[aria-label="Index status"]');
	const rescan = [...document.querySelectorAll("button[aria-label]")].find((button) =>
		button.getAttribute("aria-label").includes("Rescan")
	);
	if (!status || !rescan || rescan.disabled) return false;
	if (status.querySelector('[role="progressbar"]')) return false;
	const text = status.innerText;
	if (/elapsed|Loading translations/u.test(text) || !/lines?/u.test(text)) return false;
	let count = document.querySelector('input[aria-label="Search game text"]')?.nextElementSibling;
	while (count && count.getAttribute("role") !== "status") count = count.nextElementSibling;
	return count && /match/u.test(count.innerText) ? Date.now() : false;
})()`;
/** A shown "Scan project" button, or a search count over shown results, even while rescanning. */
const resultsShownInPage = `(() => {
	if ([...document.querySelectorAll("button")].some(
		(button) => button.textContent.trim() === "Scan project" && button.getClientRects().length > 0
	)) return "scan";
	let count = document.querySelector('input[aria-label="Search game text"]')?.nextElementSibling;
	while (count && count.getAttribute("role") !== "status") count = count.nextElementSibling;
	return count && /match/u.test(count.innerText) ? Date.now() : false;
})()`;
const indexReadyInPage = `(() =>
	/saved maps? indexed/u.test(document.querySelector("main")?.innerText ?? "") ? Date.now() : false
)()`;
/**
 * After the page saw its last Rescan click (recorded by `rescanClickRecorder`), waits until the
 * route has been busy and is usable again; resolves to the click and the usable time.
 */
const rescanClickRecorder = `(() => {
	window.__ueShedRescan = { clickedAt: undefined, busy: false };
	document.addEventListener("click", (event) => {
		const button = event.target instanceof Element ? event.target.closest("button") : null;
		if (button?.getAttribute("aria-label")?.includes("Rescan"))
			window.__ueShedRescan = { clickedAt: Date.now(), busy: false };
	}, true);
})()`;
const rescanUsableInPage = `(() => {
	const rescan = window.__ueShedRescan;
	if (!rescan || rescan.clickedAt === undefined) return false;
	const usable = ${usableInPage()};
	if (!usable) rescan.busy = true;
	return rescan.busy && usable ? { clickedAt: rescan.clickedAt, usableAt: usable } : false;
})()`;
const Epoch = Schema.Number;
const WarmState = Schema.Union([Schema.Number, Schema.Literal("scan")]);
const RescanTiming = Schema.Struct({ clickedAt: Schema.Number, usableAt: Schema.Number });

/** Polls `script` in the page every 10 ms until it is truthy, and decodes that value. */
async function inPage<A>(
	page: Page,
	script: string,
	timeoutMs: number,
	schema: Schema.Codec<A, unknown>
): Promise<A> {
	// The page's script policy forbids eval, so the poll loop runs in one evaluated promise
	// rather than through `waitForFunction`.
	const poll = `new Promise((resolve, reject) => {
	const deadline = Date.now() + ${timeoutMs};
	const check = () => {
		let value = false;
		try {
			value = ${script};
		} catch {}
		if (value) resolve(value);
		else if (Date.now() > deadline) reject(new Error("Timed out in the page"));
		else setTimeout(check, 10);
	};
	check();
})`;
	return Schema.decodeUnknownSync(schema)(await page.evaluate(poll));
}

async function lastQueryMs(page: Page): Promise<number | undefined> {
	const footer = page.getByText(/^Last query \d+ ms$/u);
	if ((await footer.count()) === 0) return undefined;
	const match = /(\d+)/u.exec(await footer.first().innerText());
	return match ? Number(match[1]) : undefined;
}

async function countText(page: Page) {
	return page
		.getByRole("searchbox", { name: "Search game text" })
		.locator("xpath=following-sibling::span[@role='status']")
		.innerText({ timeout: 1_000 });
}

/** The search count's text, and the time of the page's last Enter in the search box. */
const searchRecorder = `(() => {
	const input = document.querySelector('input[aria-label="Search game text"]');
	let count = input?.nextElementSibling;
	while (count && count.getAttribute("role") !== "status") count = count.nextElementSibling;
	window.__ueShedSearch = { before: count?.innerText, pressedAt: undefined, searching: false };
	input?.addEventListener("keydown", (event) => {
		if (event.key === "Enter") window.__ueShedSearch.pressedAt = Date.now();
	}, { capture: true, once: true });
})()`;
const searchDoneInPage = `(() => {
	const search = window.__ueShedSearch;
	if (!search || search.pressedAt === undefined) return false;
	let count = document.querySelector('input[aria-label="Search game text"]')?.nextElementSibling;
	while (count && count.getAttribute("role") !== "status") count = count.nextElementSibling;
	const text = count?.innerText ?? "";
	if (text === "Searching…") search.searching = true;
	return /match/u.test(text) && (search.searching || text !== search.before)
		? { pressedAt: search.pressedAt, doneAt: Date.now() }
		: false;
})()`;
const SearchDone = Schema.Struct({ pressedAt: Schema.Number, doneAt: Schema.Number });

async function timedSearch(page: Page, query: string): Promise<SearchTiming> {
	const search = page.getByRole("searchbox", { name: "Search game text" });
	await search.fill(query);
	await page.evaluate(searchRecorder);
	await search.press("Enter");
	const timing = await inPage(page, searchDoneInPage, 120_000, SearchDone);
	return {
		query,
		wallMs: timing.doneAt - timing.pressedAt,
		reportedMs: await lastQueryMs(page),
		total: await countText(page)
	};
}

async function timedFacet(page: Page): Promise<SearchTiming | undefined> {
	const pane = page.getByRole("complementary", { name: "Text focus" });
	const tab = pane.getByRole("tab", { name: "Assets" });
	if ((await tab.count()) === 0) return undefined;
	await tab.click();
	const item = pane.getByRole("tabpanel").getByRole("button").first();
	if ((await item.count()) === 0) return undefined;
	const before = await countText(page);
	const started = performance.now();
	await item.click();
	const finished = await waitFor(
		async () => {
			const text = await countText(page);
			return /match/u.test(text) && text !== before;
		},
		120_000,
		"facet"
	).catch(() => undefined);
	if (finished === undefined) return undefined;
	return {
		query: "facet: first asset",
		wallMs: finished - started,
		reportedMs: await lastQueryMs(page),
		total: await countText(page)
	};
}

/**
 * Walks every ungrouped row through the production IPC search and hashes it. A string, not a
 * function: the TypeScript loader would otherwise inject helpers the page does not have.
 */
const hashScript = `(async () => {
	const api = window.ueShed.gameText;
	const strip = (value) => {
		if (Array.isArray(value)) return value.map(strip);
		if (value && typeof value === "object") {
			const out = {};
			for (const [key, child] of Object.entries(value)) {
				if (/revision|cursor|elapsed|ms$|generation/iu.test(key)) continue;
				out[key] = strip(child);
			}
			return out;
		}
		return value;
	};
	const base = {
		query: "",
		capability: "all",
		lens: "all",
		withoutNotes: false,
		facets: { assets: true, origins: true, audiences: true, assetTypes: true },
		pageSize: 50
	};
	const chunks = [];
	let rows = 0;
	let cursor;
	for (let index = 0; index < 20000; index += 1) {
		const result = await api.search(cursor ? { ...base, cursor } : base);
		if (result.status !== "ready" || !result.page) {
			chunks.push(JSON.stringify(result));
			break;
		}
		const body = result.page;
		rows += body.units?.length ?? 0;
		chunks.push(JSON.stringify(strip(index === 0 ? body : { units: body.units })));
		if (!body.nextCursor) break;
		cursor = body.nextCursor;
	}
	chunks.push(JSON.stringify(strip(await api.search({ ...base, group: "problem" }))));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(chunks.join(String.fromCharCode(10))));
	return {
		hash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
		rows
	};
})()`;

const decodeHash = Schema.decodeUnknownSync(
	Schema.Struct({ hash: Schema.String, rows: Schema.Number })
);

async function hashResults(page: Page) {
	return decodeHash(await page.evaluate(hashScript));
}

async function closeApplication(application: ElectronApplication) {
	await Promise.race([
		application.close().catch(() => undefined),
		new Promise((done) => setTimeout(done, 30_000))
	]);
}

async function measure(app: AppUnderTest, options: Options, run: number): Promise<RunResult> {
	const busyBefore = await waitForQuiet(options.quietWaitMs);
	const sessionRoot = mkdtempSync(join(tmpdir(), "ue-shed-game-text-desktop-"));
	const samples: MemorySample[] = [];
	const sampler = startMemorySampler(app.checkoutRoot, samples);
	try {
		await new Promise((done) => setTimeout(done, 1_000));
		const launchStarted = performance.now();
		const launchEpoch = Date.now();
		const milestones = new Map<string, number>([["coldLaunch", launchEpoch]]);
		const { application, page } = await launch(
			app,
			options.projectRoot,
			sessionRoot,
			options.trace === undefined
				? undefined
				: join(options.trace, `${app.label}-${run}-cold.log`)
		);
		await startMainStallMonitor(application);
		observedPage = page;
		const mainPid = application.process().pid;
		step("launched");
		const indexReadyEpoch = await inPage(page, indexReadyInPage, 30 * 60_000, Epoch);
		milestones.set("coldIndexReady", indexReadyEpoch);
		step("project index ready");
		const nav = page.getByRole("complementary", { name: "Workbench" });
		await nav.getByRole("link", { exact: true, name: "Game Text" }).click();
		const scan = page.getByRole("button", { name: "Scan project", exact: true });
		await scan.waitFor({ timeout: 120_000 });
		await startMainStallMonitor(application);
		await startRendererLongTasks(page);
		const profiler =
			options.trace === undefined ? undefined : await page.context().newCDPSession(page);
		if (profiler) {
			await profiler.send("Profiler.enable");
			await profiler.send("Profiler.start");
			await application.evaluate(mainProfileStart);
		}
		const scanStarted = performance.now();
		const scanEpoch = Date.now();
		milestones.set("scanClick", scanEpoch);
		await scan.click();
		step("scan clicked");
		let usableEpoch: number;
		try {
			usableEpoch = await inPage(page, usableInPage(), 60 * 60_000, Epoch);
			milestones.set("coldUsable", usableEpoch);
		} catch (cause) {
			await page.screenshot({ path: `${options.output}.${app.label}-${run}-failed.png` });
			throw cause;
		}
		step("cold scan usable");
		const coldScanMainStall = await readMainStall(application);
		const coldScanRendererLongTasks = await readRendererLongTasks(page);
		if (profiler && options.trace !== undefined) {
			const { profile } = await profiler.send("Profiler.stop");
			writeFileSync(
				join(options.trace, `${app.label}-${run}-renderer.cpuprofile`),
				JSON.stringify(profile)
			);
			await profiler.detach();
			writeFileSync(
				join(options.trace, `${app.label}-${run}-main.cpuprofile`),
				Schema.decodeUnknownSync(Schema.String)(await application.evaluate(mainProfileStop))
			);
		}
		const firstResultsSummary = await page.getByLabel("Index status").innerText();
		const searches: SearchTiming[] = [];
		for (const query of options.queries) searches.push(await timedSearch(page, query));
		await timedSearch(page, "");
		const facet = await timedFacet(page);
		await page.getByRole("searchbox", { name: "Search game text" }).fill("");
		await startMainStallMonitor(application);
		const rescan = page.getByRole("button", { name: "Rescan", exact: true });
		await page.evaluate(rescanClickRecorder);
		const stopRescanProfiles =
			options.trace === undefined ? undefined : await startProfiles(application, page);
		await rescan.click();
		const rescanTiming = await inPage(page, rescanUsableInPage, 30 * 60_000, RescanTiming);
		milestones.set("rescanClick", rescanTiming.clickedAt);
		milestones.set("rescanUsable", rescanTiming.usableAt);
		step("rescan usable");
		if (stopRescanProfiles && options.trace !== undefined)
			await stopRescanProfiles(join(options.trace, `${app.label}-${run}-rescan`));
		const rescanMainStall = await readMainStall(application);
		const coldEnd = performance.now();
		await new Promise((done) => setTimeout(done, 2_000));
		const settledSample = settled(samples, performance.now());
		const hashed = await hashResults(page).catch(async (cause: unknown) => {
			await closeApplication(application);
			throw cause;
		});
		step(`hashed ${hashed.rows} rows`);
		await closeApplication(application);
		const coldPeak = peak(samples, launchStarted, coldEnd);

		// Warm reopen of the same profile and cache.
		await new Promise((done) => setTimeout(done, 2_000));
		const warmStarted = performance.now();
		const warmEpoch = Date.now();
		milestones.set("warmLaunch", warmEpoch);
		const warm = await launch(
			app,
			options.projectRoot,
			sessionRoot,
			options.trace === undefined
				? undefined
				: join(options.trace, `${app.label}-${run}-warm.log`)
		);
		milestones.set("warmWindow", Date.now());
		{
			// When each process's clock started, and the page's own load events.
			milestones.set(
				"warmMainOrigin",
				Schema.decodeUnknownSync(Schema.Number)(
					await warm.application.evaluate("performance.timeOrigin")
				)
			);
			const page = Schema.decodeUnknownSync(Schema.Array(Schema.Number))(
				await warm.page.evaluate(`(() => {
					const navigation = performance.getEntriesByType("navigation")[0];
					return [
						performance.timeOrigin,
						performance.timeOrigin + (navigation?.domContentLoadedEventEnd ?? 0),
						performance.timeOrigin + (navigation?.loadEventEnd ?? 0)
					];
				})()`)
			);
			milestones.set("warmRendererOrigin", page[0] ?? 0);
			milestones.set("warmRendererDomContentLoaded", page[1] ?? 0);
			milestones.set("warmRendererLoad", page[2] ?? 0);
		}
		await startMainStallMonitor(warm.application);
		const stopWarmProfiles =
			options.trace === undefined
				? undefined
				: await startProfiles(warm.application, warm.page);
		const warmIndexReady = await inPage(warm.page, indexReadyInPage, 30 * 60_000, Epoch);
		milestones.set("warmIndexReady", warmIndexReady);
		await warm.page
			.getByRole("complementary", { name: "Workbench" })
			.getByRole("link", { exact: true, name: "Game Text" })
			.click();
		milestones.set("warmNavigate", Date.now());
		// A build that reopens the saved index shows its results and rescans behind them; an older
		// build waits for "Scan project" to be clicked.
		const warmShown = await inPage(warm.page, resultsShownInPage, 30 * 60_000, WarmState);
		if (warmShown === "scan") {
			milestones.set("warmScanShown", Date.now());
			await warm.page.getByRole("button", { name: "Scan project", exact: true }).click();
		} else milestones.set("warmResultsShown", warmShown);
		const warmUsableEpoch = await inPage(warm.page, usableInPage(), 30 * 60_000, Epoch);
		const warmResultsEpoch = warmShown === "scan" ? warmUsableEpoch : warmShown;
		milestones.set("warmUsable", warmUsableEpoch);
		const warmUsable = warmStarted + (warmUsableEpoch - warmEpoch);
		const warmMainStall = await readMainStall(warm.application);
		if (stopWarmProfiles && options.trace !== undefined)
			await stopWarmProfiles(join(options.trace, `${app.label}-${run}-warm`));
		const warmFirstSearch = await timedSearch(warm.page, options.queries[0] ?? "the");
		if (options.trace !== undefined)
			writeFileSync(
				join(options.trace, `${app.label}-${run}-milestones.json`),
				`${JSON.stringify(Object.fromEntries(milestones), null, "\t")}\n`
			);
		await new Promise((done) => setTimeout(done, 2_000));
		const warmSettled = settled(samples, performance.now()).totalMiB;
		const warmPeak = peak(samples, warmStarted, warmUsable);
		await closeApplication(warm.application);

		const cacheRoot = join(sessionRoot, "profile", "project-catalogs-v1");
		const diskBytes: Record<string, number> = {};
		for (const entry of readdirSync(cacheRoot, { withFileTypes: true }))
			if (entry.isDirectory())
				diskBytes[entry.name] = directoryBytes(join(cacheRoot, entry.name));
		return {
			label: app.label,
			run,
			busyBefore,
			mainPid,
			launchToIndexReadyMs: indexReadyEpoch - launchEpoch,
			coldScanMs: usableEpoch - scanEpoch,
			launchToUsableMs: usableEpoch - launchEpoch,
			coldScanMainStall,
			coldScanRendererLongTasks,
			firstResultsSummary,
			searches,
			facet,
			rescanMs: rescanTiming.usableAt - rescanTiming.clickedAt,
			rescanMainStall,
			coldPeakRssMiB: coldPeak.totalMiB,
			coldPeakBreakdownMiB: coldPeak.byName,
			settledRssMiB: settledSample.totalMiB,
			settledBreakdownMiB: settledSample.byName,
			coldPeakAtMs: coldPeak.at - scanStarted,
			warmLaunchToUsableMs: warmUsableEpoch - warmEpoch,
			warmLaunchToResultsMs: warmResultsEpoch - warmEpoch,
			warmLaunchToIndexReadyMs: warmIndexReady - warmEpoch,
			warmFirstSearch,
			warmMainStall,
			warmPeakRssMiB: warmPeak.totalMiB,
			warmSettledRssMiB: warmSettled,
			diskBytes,
			milestones: Object.fromEntries(milestones),
			resultHash: hashed.hash,
			resultRows: hashed.rows,
			coldTimeline: samples
				.filter((sample) => sample.at >= launchStarted && sample.at <= coldEnd)
				.map((sample) => ({
					atMs: Math.round(sample.at - scanStarted),
					byName: Object.fromEntries(
						Object.entries(sample.byName).map(([name, mib]) => [name, Math.round(mib)])
					)
				}))
		};
	} finally {
		sampler.kill();
		try {
			if (process.env.BENCHMARK_KEEP_PROFILE === undefined)
				rmSync(sessionRoot, {
					force: true,
					recursive: true,
					maxRetries: 5,
					retryDelay: 500
				});
			else step(`kept ${sessionRoot}`);
		} catch (cause) {
			step(`could not remove ${sessionRoot}: ${String(cause)}`);
		}
	}
}

function median(values: ReadonlyArray<number>) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[middle] ?? 0)
		: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function summarize(results: ReadonlyArray<RunResult>) {
	const labels = [...new Set(results.map((result) => result.label))];
	return Object.fromEntries(
		labels.map((label) => {
			const runs = results.filter((result) => result.label === label);
			const metric = (pick: (result: RunResult) => number | undefined) => {
				const values = runs
					.map(pick)
					.filter((value): value is number => value !== undefined);
				return { median: median(values), values };
			};
			return [
				label,
				{
					launchToIndexReadyMs: metric((result) => result.launchToIndexReadyMs),
					coldScanMs: metric((result) => result.coldScanMs),
					launchToUsableMs: metric((result) => result.launchToUsableMs),
					rescanMs: metric((result) => result.rescanMs),
					warmLaunchToUsableMs: metric((result) => result.warmLaunchToUsableMs),
					warmLaunchToResultsMs: metric((result) => result.warmLaunchToResultsMs),
					warmLaunchToIndexReadyMs: metric((result) => result.warmLaunchToIndexReadyMs),
					warmFirstSearchReportedMs: metric(
						(result) => result.warmFirstSearch.reportedMs
					),
					warmFirstSearchWallMs: metric((result) => result.warmFirstSearch.wallMs),
					warmMainMaxStallMs: metric((result) => result.warmMainStall.maxStallMs),
					firstSearchReportedMs: metric((result) => result.searches[0]?.reportedMs),
					firstSearchWallMs: metric((result) => result.searches[0]?.wallMs),
					secondSearchReportedMs: metric((result) => result.searches[1]?.reportedMs),
					facetReportedMs: metric((result) => result.facet?.reportedMs),
					facetWallMs: metric((result) => result.facet?.wallMs),
					coldPeakRssMiB: metric((result) => result.coldPeakRssMiB),
					settledRssMiB: metric((result) => result.settledRssMiB),
					warmPeakRssMiB: metric((result) => result.warmPeakRssMiB),
					warmSettledRssMiB: metric((result) => result.warmSettledRssMiB),
					coldScanMainMaxStallMs: metric((result) => result.coldScanMainStall.maxStallMs),
					coldScanMainOver50TotalMs: metric(
						(result) => result.coldScanMainStall.over50TotalMs
					),
					rescanMainMaxStallMs: metric((result) => result.rescanMainStall.maxStallMs),
					rendererMaxLongTaskMs: metric(
						(result) => result.coldScanRendererLongTasks.maxStallMs
					),
					catalogBytes: metric((result) =>
						Object.entries(result.diskBytes)
							.filter(([name]) => name.startsWith("catalogs"))
							.reduce((total, [, bytes]) => total + bytes, 0)
					),
					gameTextBytes: metric((result) =>
						Object.entries(result.diskBytes)
							.filter(([name]) => name.startsWith("game-text"))
							.reduce((total, [, bytes]) => total + bytes, 0)
					),
					hashes: [...new Set(runs.map((result) => result.resultHash))],
					rows: [...new Set(runs.map((result) => result.resultRows))]
				}
			];
		})
	);
}

const options = parseOptions(process.argv.slice(2));
mkdirSync(dirname(options.output), { recursive: true });
const results: RunResult[] = [];
for (let run = 0; run < options.runs; run += 1) {
	// Alternate builds and rotate which goes first so neither always runs on a warmer machine.
	const order = run % 2 === 0 ? options.apps : [...options.apps].reverse();
	for (const app of order) {
		process.stdout.write(`run ${run + 1}/${options.runs}: ${app.label}\n`);
		const result = await measure(app, options, run + 1);
		results.push(result);
		process.stdout.write(
			`  index ${(result.launchToIndexReadyMs / 1000).toFixed(2)} s, scan ${(result.coldScanMs / 1000).toFixed(2)} s, ` +
				`rescan ${(result.rescanMs / 1000).toFixed(2)} s, warm ${(result.warmLaunchToResultsMs / 1000).toFixed(2)}/${(result.warmLaunchToUsableMs / 1000).toFixed(2)} s, ` +
				`peak ${result.coldPeakRssMiB.toFixed(0)} MiB, stall ${result.coldScanMainStall.maxStallMs.toFixed(0)} ms, ` +
				`hash ${result.resultHash.slice(0, 12)} (${result.resultRows} rows)\n`
		);
		writeFileSync(
			options.output,
			`${JSON.stringify({ options, results, summary: summarize(results) }, null, "\t")}\n`
		);
	}
}
process.stdout.write(`${JSON.stringify(summarize(results), null, 2)}\n`);
