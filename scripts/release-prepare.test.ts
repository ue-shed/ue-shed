import assert from "node:assert/strict";
import test from "node:test";
import type { SpanRecord } from "./gate-trace.ts";
import { gateFingerprint, type ReleaseEvidence, type TreeEntry } from "./release-evidence.ts";
import { RELEASE_GATES } from "./release-gates.ts";
import { assertUnrealPathBudget, planGates, recordValidation } from "./release-prepare.ts";
import {
	formatDuration,
	gateSteps,
	indexSpans,
	slowestLeaves,
	timeCategories
} from "./release-report.ts";

const tree: readonly TreeEntry[] = [
	{ path: "scripts/release.ts", object: "1".repeat(40) },
	{ path: "packages/game-text/CHANGELOG.md", object: "2".repeat(40) }
];

test("plans to rerun only gates whose evidence no longer covers the release inputs", () => {
	const check = RELEASE_GATES.find((gate) => gate.id === "check")!;
	const pack = RELEASE_GATES.find((gate) => gate.id === "pack")!;
	const previous: readonly TreeEntry[] = [tree[0]!, { ...tree[1]!, object: "3".repeat(40) }];
	const evidence: ReleaseEvidence = {
		schemaVersion: 1,
		version: "0.5.2",
		gates: Object.fromEntries(
			[check, pack].map((gate) => [
				gate.id,
				{
					status: "passed",
					scope: gate.scope,
					fingerprint: gateFingerprint(gate.scope, previous),
					commit: "c".repeat(40),
					finishedAt: "2026-10-21T00:00:00.000Z",
					durationMs: 1,
					trace: "run"
				}
			])
		)
	};
	const plan = planGates([check, pack], evidence, tree);
	assert.deepEqual(
		plan.map(({ gate, state, reuse }) => [gate.id, state.kind, reuse]),
		[
			["check", "current", true],
			["pack", "stale", false]
		]
	);
	assert.deepEqual(
		planGates([check], evidence, tree, { force: true }).map(({ reuse }) => reuse),
		[false]
	);
});

test("records validation in place of an existing section or at the end", () => {
	const validation = "## Validation\n\n- Full local check: passed.\n";
	assert.equal(
		recordValidation("# UE Shed 0.5.2\n\n## Fixes\n\n- A fix.\n", validation),
		"# UE Shed 0.5.2\n\n## Fixes\n\n- A fix.\n\n## Validation\n\n- Full local check: passed.\n"
	);
	assert.equal(
		recordValidation(
			"# UE Shed 0.5.2\n\n## Validation\n\nOld evidence.\n\n## Upgrade notes\n\nKeep me.\n",
			validation
		),
		"# UE Shed 0.5.2\n\n## Validation\n\n- Full local check: passed.\n\n## Upgrade notes\n\nKeep me.\n"
	);
});

function span(
	name: string,
	parent: string | undefined,
	startMs: number,
	endMs: number,
	attributes: SpanRecord["attributes"] = {}
): SpanRecord {
	return {
		traceId: "t",
		spanId: name,
		parentSpanId: parent,
		name,
		startUs: startMs * 1_000,
		endUs: endMs * 1_000,
		status: "ok",
		attributes
	};
}

test("report categories and steps come from the recorded spans", () => {
	const spans = [
		span("release:prepare", undefined, 0, 100_000),
		span("gate check", "release:prepare", 0, 90_000, { "release.gate": "check" }),
		span("check", "gate check", 0, 90_000),
		span("uasset:check", "check", 0, 40_000),
		span("cargo test -p uasset-io", "uasset:check", 0, 30_000, {
			"cargo.build_ms": 12_000,
			"cargo.compiled_crates": 3
		}),
		span("test", "check", 40_000, 90_000),
		span("vitest test files", "test", 40_000, 90_000),
		span("commandlet GatherText", "test", 41_000, 50_000, {
			"unreal.tool": "UnrealEditor-Cmd.exe"
		}),
		span("engine startup", "commandlet GatherText", 41_000, 45_000),
		span("work", "commandlet GatherText", 45_000, 49_000),
		span("shutdown", "commandlet GatherText", 49_000, 50_000)
	];
	const index = indexSpans(spans);
	assert.equal(index.gateOf(spans[4]!), "check");
	assert.deepEqual(
		gateSteps(spans[1]!, index).map((step) => step.name),
		["uasset:check", "test"]
	);
	const categories = timeCategories(spans, index);
	assert.deepEqual(
		categories.map(({ name, ms }) => [name, ms]),
		[
			["Rust compiling", 12_000],
			["Unreal startup and shutdown", 5_000],
			["Vitest", 50_000]
		]
	);
	assert.equal(slowestLeaves(spans, index, 1)[0]?.name, "vitest test files");
	assert.deepEqual([450, 4_200, 42_000, 125_000].map(formatDuration), [
		"450ms",
		"4.2s",
		"42s",
		"2m05s"
	]);
});

test("refuses an Unreal lane checkout whose build paths would pass 260 characters", () => {
	assert.doesNotThrow(() => assertUnrealPathBudget("C:/Users/dev/git/ue-shed-unreal"));
	assert.throws(
		() => assertUnrealPathBudget(`C:/${"deep/".repeat(20)}ue-shed-unreal`),
		/Unreal gates need at most 85/
	);
});
