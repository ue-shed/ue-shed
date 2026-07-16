import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeAuthoringTableSnapshot as decodeAuthoringTableSnapshotEffect } from "@ue-shed/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const decodeAuthoringTableSnapshot = (input: unknown) =>
	Effect.runSync(decodeAuthoringTableSnapshotEffect(input));

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliScript = join(repositoryRoot, "scripts", "ue-shed.mjs");
const scalarAsset = join(
	repositoryRoot,
	"fixtures",
	"unreal-project",
	"Content",
	"Fixture",
	"Authoring",
	"DT_Scalars.uasset"
);
const scalarTable = "/Game/Fixture/Authoring/DT_Scalars.DT_Scalars";
const fixtureProject = join(repositoryRoot, "fixtures", "unreal-project");
const fixtureReviewSet = join(
	fixtureProject,
	".ue-shed",
	"review",
	"sets",
	"fixture-structure.json"
);

interface CliResult {
	readonly status: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

function runCli(args: readonly string[]): CliResult {
	const result = spawnSync(process.execPath, [cliScript, ...args], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: process.env,
		timeout: 30_000,
		windowsHide: true
	});
	if (result.error) throw result.error;
	return {
		status: result.status,
		stderr: result.stderr,
		stdout: result.stdout
	};
}

function runSuccessfulCli(args: readonly string[]): string {
	const result = runCli(args);
	if (result.status !== 0) {
		throw new Error(`CLI exited with ${result.status} for ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout;
}

function parseRecord(output: string): Readonly<Record<string, unknown>> {
	const value: unknown = JSON.parse(output);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Expected the CLI to print one JSON object");
	}
	return value as Readonly<Record<string, unknown>>;
}

describe("ue-shed CLI process", () => {
	it("reports help, version, and invalid commands through the executable boundary", () => {
		const help = runCli(["--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("UE Shed — External tools for Unreal Engine development.");
		expect(help.stderr).not.toContain("ue-shed:");

		const version = runCli(["--version"]);
		expect(version.status).toBe(0);
		expect(version.stdout).toMatch(/^ue-shed 0\.0\.0 \(protocol \d+\.\d+\)\r?\n$/);

		const invalid = runCli(["not-a-command"]);
		expect(invalid.status).toBe(2);
		expect(invalid.stdout).toBe("");
		expect(invalid.stderr).toContain("ue-shed: Unknown command: not-a-command");
		expect(invalid.stderr).toContain("ue-shed authoring inspect");
	}, 20_000);

	it("inspects a real saved fixture asset through the native reader", () => {
		const inspection = parseRecord(runSuccessfulCli(["authoring", "inspect", scalarAsset]));
		const snapshot = decodeAuthoringTableSnapshot(inspection.snapshot);

		expect(inspection.fingerprint).toMatch(/^sha256-v1:[a-f0-9]{64}$/);
		expect(snapshot.authority.kind).toBe("project_files");
		expect(snapshot.table.objectPath).toBe(scalarTable);
		expect(snapshot.table.rows.map((row) => row.name)).toEqual(["Scalar_Alpha", "Scalar_Beta"]);
	});

	it("runs the persistent session lifecycle through separate CLI processes", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-cli-sessions-"));
		try {
			const created = parseRecord(
				runSuccessfulCli([
					"authoring",
					"sessions",
					"create",
					scalarAsset,
					"--project",
					projectRoot,
					"--id",
					"fixture-session"
				])
			);
			expect(created.lifecycle).toBe("open");

			const shown = parseRecord(
				runSuccessfulCli([
					"authoring",
					"sessions",
					"show",
					"fixture-session",
					"--project",
					projectRoot
				])
			);
			expect(shown.lifecycle).toBe("open");

			const edited = parseRecord(
				runSuccessfulCli([
					"authoring",
					"sessions",
					"set-cell",
					"fixture-session",
					scalarTable,
					"row:Scalar_Alpha",
					"Enabled",
					JSON.stringify({ kind: "bool", value: false }),
					"--project",
					projectRoot
				])
			);
			expect(
				decodeAuthoringTableSnapshot(edited.working)
					.table.rows.find((row) => row.name === "Scalar_Alpha")
					?.fields.find((field) => field.name === "Enabled")?.value
			).toEqual({ kind: "bool", value: false });
			const review = parseRecord(
				runSuccessfulCli([
					"authoring",
					"sessions",
					"review",
					"fixture-session",
					"--project",
					projectRoot
				])
			);
			expect(review.activeCommandCount).toBe(1);
			expect(review.validation).toMatchObject({ valid: true, warningCount: 1 });
			const diff: unknown = JSON.parse(
				runSuccessfulCli([
					"authoring",
					"sessions",
					"diff",
					"fixture-session",
					"--project",
					projectRoot
				])
			);
			expect(diff).toEqual(
				expect.arrayContaining([expect.objectContaining({ kind: "cell_changed" })])
			);
			const validation = parseRecord(
				runSuccessfulCli([
					"authoring",
					"sessions",
					"validate",
					"fixture-session",
					"--project",
					projectRoot
				])
			);
			expect(validation).toMatchObject({ valid: true, warningCount: 1 });
			const undone = parseRecord(
				runSuccessfulCli([
					"authoring",
					"sessions",
					"undo",
					"fixture-session",
					"--project",
					projectRoot
				])
			);
			expect(parseRecord(JSON.stringify(undone.draft)).undoPointer).toBe(0);
			const redone = parseRecord(
				runSuccessfulCli([
					"authoring",
					"sessions",
					"redo",
					"fixture-session",
					"--project",
					projectRoot
				])
			);
			expect(parseRecord(JSON.stringify(redone.draft)).undoPointer).toBe(1);

			const duplicated = parseRecord(
				runSuccessfulCli([
					"authoring",
					"sessions",
					"duplicate-row",
					"fixture-session",
					scalarTable,
					"row:Scalar_Alpha",
					"Scalar_Copy",
					"--project",
					projectRoot
				])
			);
			const duplicatedWorking = decodeAuthoringTableSnapshot(duplicated.working);
			const copiedRow = duplicatedWorking.table.rows.find(
				(row) => row.name === "Scalar_Copy"
			);
			if (!copiedRow) throw new Error("Expected duplicated CLI row");
			const renamed = parseRecord(
				runSuccessfulCli([
					"authoring",
					"sessions",
					"rename-row",
					"fixture-session",
					scalarTable,
					copiedRow.id,
					"Scalar_Renamed",
					"--project",
					projectRoot
				])
			);
			const renamedWorking = decodeAuthoringTableSnapshot(renamed.working);
			const reversedIds = [...renamedWorking.table.rows].reverse().map((row) => row.id);
			const reordered = parseRecord(
				runSuccessfulCli([
					"authoring",
					"sessions",
					"reorder-rows",
					"fixture-session",
					scalarTable,
					JSON.stringify(reversedIds),
					"--project",
					projectRoot
				])
			);
			expect(
				decodeAuthoringTableSnapshot(reordered.working).table.rows.map((row) => row.name)
			).toEqual(["Scalar_Beta", "Scalar_Renamed", "Scalar_Alpha"]);
			const removed = parseRecord(
				runSuccessfulCli([
					"authoring",
					"sessions",
					"remove-row",
					"fixture-session",
					scalarTable,
					"row:Scalar_Alpha",
					"--project",
					projectRoot
				])
			);
			expect(
				decodeAuthoringTableSnapshot(removed.working).table.rows.map((row) => row.name)
			).toEqual(["Scalar_Beta", "Scalar_Renamed"]);

			const closed = parseRecord(
				runSuccessfulCli([
					"authoring",
					"sessions",
					"close",
					"fixture-session",
					"--project",
					projectRoot
				])
			);
			expect(closed.lifecycle).toBe("closed");

			const listed = parseRecord(
				runSuccessfulCli(["authoring", "sessions", "list", "--project", projectRoot])
			);
			expect(listed.sessions).toHaveLength(1);
		} finally {
			await rm(projectRoot, { force: true, recursive: true });
		}
	}, 30_000);

	it("reports malformed input and typed Remote Control failures with usage exit status", () => {
		const malformed = runCli([
			"authoring",
			"sessions",
			"set-cell",
			"draft",
			"/Game/Table",
			"Row",
			"Field",
			"{",
			"--project",
			"project"
		]);
		expect(malformed.status).toBe(2);
		expect(malformed.stdout).toBe("");
		expect(malformed.stderr).toContain("ue-shed: Invalid value JSON");

		const remote = runCli(["authoring", "live", "tables", "http://127.0.0.1:1"]);
		expect(remote.status).toBe(2);
		expect(remote.stdout).toBe("");
		expect(remote.stderr).toContain("ue-shed:");
	});

	it("validates the portable fixture Review Set and lists empty local history", async () => {
		const validation = parseRecord(
			runSuccessfulCli(["review", "sets", "validate", fixtureReviewSet])
		);
		expect(validation).toMatchObject({
			id: "fixture-structure",
			profiles: 1,
			status: "valid",
			views: 1
		});

		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-review-history-"));
		try {
			expect(parseRecord(runSuccessfulCli(["review", "history", projectRoot]))).toEqual({
				runs: []
			});
		} finally {
			await rm(projectRoot, { force: true, recursive: true });
		}
	});
});
