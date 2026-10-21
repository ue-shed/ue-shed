/**
 * Turns a `release:prepare` trace into `report.html` (a lane timeline, each gate's largest steps
 * and where the time went) and `validation.md` (the release notes' Validation section), so every
 * release preparation explains its own duration from recorded spans.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpanRecord } from "./gate-trace.ts";
import { gateEvidenceState, type ReleaseEvidence, type TreeEntry } from "./release-evidence.ts";
import type { ReleaseGate } from "./release-gates.ts";
import type { GateRun } from "./release-prepare.ts";

export function formatDuration(ms: number) {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
	const minutes = Math.floor(ms / 60_000);
	return `${minutes}m${String(Math.round((ms % 60_000) / 1_000)).padStart(2, "0")}s`;
}

function count(value: number, singular: string, plural = `${singular}s`) {
	return `${value} ${value === 1 ? singular : plural}`;
}

const durationMs = (span: SpanRecord) => (span.endUs - span.startUs) / 1_000;

function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

export interface SpanIndex {
	readonly byId: ReadonlyMap<string, SpanRecord>;
	readonly children: ReadonlyMap<string, readonly SpanRecord[]>;
	/** The release gate a span ran under, if any. */
	gateOf(span: SpanRecord): string | undefined;
}

export function indexSpans(spans: readonly SpanRecord[]): SpanIndex {
	const byId = new Map(spans.map((span) => [span.spanId, span]));
	const children = new Map<string, SpanRecord[]>();
	for (const span of spans) {
		if (span.parentSpanId === undefined) continue;
		children.set(span.parentSpanId, [...(children.get(span.parentSpanId) ?? []), span]);
	}
	const gates = new Map<string, string | undefined>();
	const gateOf = (span: SpanRecord): string | undefined => {
		if (gates.has(span.spanId)) return gates.get(span.spanId);
		const own = span.attributes["release.gate"];
		const parent = span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId);
		const gate = own === undefined ? parent && gateOf(parent) : String(own);
		gates.set(span.spanId, gate);
		return gate;
	};
	return { byId, children, gateOf };
}

export interface TimeCategory {
	readonly name: string;
	readonly ms: number;
	readonly detail: string;
}

/**
 * Totals of the kinds of work the spans record. They overlap (Rust compiling happens inside the
 * check), so they explain the gates rather than add up to them.
 */
export function timeCategories(spans: readonly SpanRecord[], index: SpanIndex): TimeCategory[] {
	const sum = (selected: readonly SpanRecord[]) =>
		selected.reduce((total, span) => total + durationMs(span), 0);
	const cargo = spans.filter((span) => span.attributes["cargo.build_ms"] !== undefined);
	const cargoMs = cargo.reduce(
		(total, span) => total + Number(span.attributes["cargo.build_ms"]),
		0
	);
	const crates = cargo.reduce(
		(total, span) => total + Number(span.attributes["cargo.compiled_crates"] ?? 0),
		0
	);
	const unrealRuns = spans.filter(
		(span) =>
			span.attributes["unreal.tool"] !== undefined && !span.name.startsWith("UnrealBuildTool")
	);
	const phase = (name: string) =>
		sum(
			unrealRuns.flatMap((run) =>
				(index.children.get(run.spanId) ?? []).filter((child) => child.name === name)
			)
		);
	const builds = spans.filter((span) => span.name.startsWith("UnrealBuildTool"));
	const upToDate = builds.filter((span) => span.attributes["unreal.build.up_to_date"] === true);
	const vitest = spans.filter((span) => span.name === "vitest test files");
	const vitestTests = spans.filter((span) => span.attributes["vitest.state"] !== undefined);
	const playwright = spans.filter((span) => span.name === "playwright e2e");
	const attempts = spans.filter((span) => span.attributes["playwright.test_id"] !== undefined);
	const waits = spans.filter((span) => /^wait for |^start editor |^stop /.test(span.name));
	return [
		{
			name: "Rust compiling",
			ms: cargoMs,
			detail: `${count(crates, "crate")} compiled in ${count(cargo.length, "Cargo run")}; test time excluded`
		},
		{
			name: "Unreal builds",
			ms: sum(builds),
			detail: `${count(builds.length, "UnrealBuildTool run")}, ${upToDate.length} already up to date`
		},
		{
			name: "Unreal startup and shutdown",
			ms: phase("engine startup") + phase("shutdown"),
			detail: `${count(unrealRuns.length, "editor or commandlet process", "editor and commandlet processes")}; their work took ${formatDuration(phase("work"))}`
		},
		{
			name: "Vitest",
			ms: sum(vitest),
			detail: `${count(vitestTests.length, "test")} in ${count(vitest.length, "run")}`
		},
		{
			name: "Playwright",
			ms: sum(playwright),
			detail: `${count(attempts.length, "attempt")} in ${count(playwright.length, "run")}`
		},
		{
			name: "Waiting for editors",
			ms: sum(waits),
			detail: `${count(waits.length, "editor start, stop or readiness wait", "editor starts, stops and readiness waits")}`
		}
	].filter((category) => category.ms > 0);
}

/** The longest spans with no children: the commands and tests time was actually spent in. */
export function slowestLeaves(spans: readonly SpanRecord[], index: SpanIndex, count = 15) {
	return spans
		.filter((span) => (index.children.get(span.spanId) ?? []).length === 0)
		.toSorted((a, b) => durationMs(b) - durationMs(a))
		.slice(0, count);
}

/** A gate's top-level steps: below the chain of single-child spans (the gate, its script). */
export function gateSteps(gateSpan: SpanRecord, index: SpanIndex) {
	let node = gateSpan;
	for (
		let children = index.children.get(node.spanId) ?? [];
		children.length === 1;
		children = index.children.get(node.spanId) ?? []
	) {
		node = children[0]!;
	}
	return index.children.get(node.spanId) ?? [];
}

function pathOf(span: SpanRecord, index: SpanIndex) {
	const names: string[] = [];
	for (
		let parent =
			span.parentSpanId === undefined ? undefined : index.byId.get(span.parentSpanId);
		parent !== undefined && parent.parentSpanId !== undefined;
		parent = parent.parentSpanId === undefined ? undefined : index.byId.get(parent.parentSpanId)
	) {
		names.unshift(parent.name);
	}
	return names.slice(-3).join(" › ");
}

function toolVersion(commandLine: string) {
	const result = spawnSync(commandLine, { encoding: "utf8", shell: true, windowsHide: true });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

export function validationMarkdown({
	version,
	commit,
	runs,
	evidence,
	gates,
	spans,
	index,
	tree
}: {
	readonly version: string;
	readonly commit: string;
	readonly runs: readonly GateRun[];
	readonly evidence: ReleaseEvidence;
	readonly gates: readonly ReleaseGate[];
	readonly spans: readonly SpanRecord[];
	readonly index: SpanIndex;
	/** The release commit's tree, to tell reused evidence that still covers it from stale. */
	readonly tree: readonly TreeEntry[];
}) {
	const lines = [
		"## Validation",
		"",
		`Prepared with \`pnpm release:prepare\` for ${version} on ${new Date().toISOString().slice(0, 10)} ` +
			`with Node ${process.version} and pnpm ${toolVersion("pnpm --version")}, at release ` +
			`commit \`${commit}\`.`,
		""
	];
	for (const gate of gates) {
		const run = runs.find((candidate) => candidate.gate.id === gate.id);
		const result = run?.result ?? evidence.gates[gate.id];
		if (result === undefined) {
			lines.push(`- ${gate.title}: not run.`);
			continue;
		}
		// Evidence from an earlier run covers this commit only while its inputs are unchanged.
		const reusedState =
			run === undefined ? gateEvidenceState(result, gate.scope, tree) : undefined;
		if (reusedState?.kind === "stale") {
			lines.push(
				`- ${gate.title}: not rerun; its evidence from \`${result.commit.slice(0, 10)}\` ` +
					"has different inputs and does not cover this commit."
			);
			continue;
		}
		const where =
			run === undefined ? ` on \`${result.commit.slice(0, 10)}\` (same inputs)` : "";
		const outcome =
			result.status === "unavailable"
				? `unavailable — ${result.detail ?? "not available on this machine"}`
				: `${result.status}${where} in ${formatDuration(result.durationMs)}`;
		const tests = spans.filter(
			(span) =>
				index.gateOf(span) === gate.id &&
				(span.attributes["vitest.state"] !== undefined ||
					span.attributes["playwright.test_id"] !== undefined)
		);
		const counted =
			run === undefined || tests.length === 0
				? ""
				: (() => {
						const passed = tests.filter((span) =>
							["pass", "passed"].includes(
								String(
									span.attributes["vitest.state"] ??
										span.attributes["playwright.status"]
								)
							)
						).length;
						// Vitest records skipped tests as a count on each file's span.
						const skipped =
							tests.filter(
								(span) => span.attributes["playwright.status"] === "skipped"
							).length +
							spans
								.filter((span) => index.gateOf(span) === gate.id)
								.reduce(
									(total, span) =>
										total + Number(span.attributes["vitest.skipped"] ?? 0),
									0
								);
						return `; ${passed} tests passed, ${skipped} skipped`;
					})();
		lines.push(`- ${gate.title}: ${outcome}${counted}.`);
	}
	return `${lines.join("\n")}\n`;
}

function timelineSvg(runs: readonly GateRun[], spans: readonly SpanRecord[]) {
	const root = spans.find((span) => span.parentSpanId === undefined);
	const gateSpans = spans.filter((span) => span.attributes["release.gate"] !== undefined);
	const setup = spans.filter((span) => span.name === "prepare Unreal worktree");
	const bars = [...setup, ...gateSpans];
	if (root === undefined || bars.length === 0) return "";
	const lanes = [...new Set(bars.map((span) => String(span.attributes["trace.lane"] ?? "gate")))];
	const total = Math.max(durationMs(root), 1);
	const width = 960;
	const labelWidth = 90;
	const rowHeight = 30;
	const plot = width - labelWidth - 10;
	const x = (us: number) => labelWidth + ((us - root.startUs) / 1_000 / total) * plot;
	const height = lanes.length * rowHeight + 34;
	const ticks = Array.from({ length: 6 }, (_, tick) => (total * tick) / 5);
	const failed = new Set(
		runs.filter((run) => run.result.status === "failed").map((run) => run.gate.id)
	);
	const parts = [
		`<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Release preparation timeline by lane">`
	];
	for (const tick of ticks) {
		const tx = labelWidth + (tick / total) * plot;
		parts.push(
			`<line x1="${tx}" x2="${tx}" y1="4" y2="${height - 22}" class="grid"/>`,
			`<text x="${tx}" y="${height - 6}" class="axis" text-anchor="middle">${formatDuration(tick)}</text>`
		);
	}
	lanes.forEach((lane, row) => {
		const y = 6 + row * rowHeight;
		parts.push(`<text x="0" y="${y + 17}" class="axis">${escapeHtml(lane)}</text>`);
		for (const span of bars.filter(
			(bar) => String(bar.attributes["trace.lane"] ?? "gate") === lane
		)) {
			const bx = x(span.startUs);
			const bw = Math.max(2, x(span.endUs) - bx);
			const gate = span.attributes["release.gate"];
			const label = gate === undefined ? "setup" : String(gate);
			const state =
				gate !== undefined && failed.has(String(gate))
					? "bar failed"
					: gate === undefined
						? "bar setup"
						: "bar";
			parts.push(
				`<g><title>${escapeHtml(`${span.name}: ${formatDuration(durationMs(span))}`)}</title>` +
					`<rect x="${bx}" y="${y}" width="${bw}" height="22" rx="3" class="${state}"/>` +
					(bw > 60
						? `<text x="${bx + 6}" y="${y + 15}" class="label">${escapeHtml(label)} · ${formatDuration(durationMs(span))}</text>`
						: "") +
					"</g>"
			);
		}
	});
	parts.push("</svg>");
	return parts.join("");
}

export function writeReleaseReport({
	outputDirectory,
	version,
	commit,
	spans,
	runs,
	evidence,
	gates,
	reused,
	tree
}: {
	readonly outputDirectory: string;
	readonly version: string;
	readonly commit: string;
	readonly spans: readonly SpanRecord[];
	readonly runs: readonly GateRun[];
	readonly evidence: ReleaseEvidence;
	readonly gates: readonly ReleaseGate[];
	readonly reused: readonly string[];
	readonly tree: readonly TreeEntry[];
}) {
	const index = indexSpans(spans);
	const root = spans.find((span) => span.parentSpanId === undefined);
	const wall = root === undefined ? 0 : durationMs(root);
	const failed = runs.filter((run) => run.result.status === "failed");
	const validation = validationMarkdown({
		version,
		commit,
		runs,
		evidence,
		gates,
		spans,
		index,
		tree
	});

	const gateRows = runs
		.map((run) => {
			const gateSpan = spans.find((span) => span.attributes["release.gate"] === run.gate.id);
			const steps = gateSpan === undefined ? [] : gateSteps(gateSpan, index);
			const top = steps.toSorted((a, b) => durationMs(b) - durationMs(a)).slice(0, 6);
			const stepText = top
				.map(
					(step) =>
						`${escapeHtml(step.name.slice(0, 60))} ${formatDuration(durationMs(step))}`
				)
				.join(" · ");
			return `<tr><td>${escapeHtml(run.gate.id)}</td><td class="${run.result.status}">${run.result.status}</td><td class="num">${formatDuration(run.result.durationMs)}</td><td class="muted">${stepText || escapeHtml(run.result.detail ?? "")}</td></tr>`;
		})
		.join("");
	const categoryRows = timeCategories(spans, index)
		.map(
			(category) =>
				`<tr><td>${escapeHtml(category.name)}</td><td class="num">${formatDuration(category.ms)}</td><td class="muted">${escapeHtml(category.detail)}</td></tr>`
		)
		.join("");
	const leafRows = slowestLeaves(spans, index)
		.map(
			(span) =>
				`<tr><td class="num">${formatDuration(durationMs(span))}</td><td>${escapeHtml(span.name.slice(0, 90))}</td><td class="muted">${escapeHtml(index.gateOf(span) ?? "")} ${escapeHtml(pathOf(span, index).slice(0, 90))}</td></tr>`
		)
		.join("");
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UE Shed ${escapeHtml(version)} release preparation</title>
<style>
:root{color-scheme:light dark;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--bar:#5470c6;--setup:#9aa4b2;--bad:#c4314b;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--bar:#6e8bd9;--setup:#57606a;--bad:#f0607a;--ok:#3fb950}}
body{margin:16px;font:13px/1.45 system-ui,sans-serif;color:var(--fg)}
h1{font-size:15px;font-weight:600;margin:0 0 2px}h2{font-size:13px;font-weight:600;margin:18px 0 6px}
.summary{color:var(--muted);margin-bottom:12px}
table{border-collapse:collapse;width:100%}td{padding:3px 8px 3px 0;border-top:1px solid var(--line);vertical-align:top}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;width:1%}.muted{color:var(--muted)}
.passed{color:var(--ok)}.failed{color:var(--bad)}.unavailable{color:var(--muted)}
svg .grid{stroke:var(--line)}svg .axis{fill:var(--muted);font-size:11px}svg .label{fill:#fff;font-size:11px}
svg .bar{fill:var(--bar)}svg .setup{fill:var(--setup)}svg .failed{fill:var(--bad)}
</style></head><body>
<h1>UE Shed ${escapeHtml(version)} release preparation</h1>
<div class="summary">${commit.slice(0, 12)} · ${failed.length > 0 ? `<span class="failed">${failed.length} failed</span>` : '<span class="passed">passed</span>'} · ${formatDuration(wall)} wall · ${runs.length} gates run${reused.length > 0 ? ` · reused ${escapeHtml(reused.join(", "))}` : ""}</div>
${timelineSvg(runs, spans)}
<h2>Gates</h2><table>${gateRows}</table>
<h2>Where the time went</h2><table>${categoryRows}</table>
<h2>Slowest commands and tests</h2><table>${leafRows}</table>
<p class="muted">Open trace.json in https://ui.perfetto.dev for every span.</p>
</body></html>
`;
	const reportPath = join(outputDirectory, "report.html");
	const validationPath = join(outputDirectory, "validation.md");
	writeFileSync(reportPath, html, "utf8");
	writeFileSync(validationPath, validation, "utf8");
	return { reportPath, validationPath, validation };
}
