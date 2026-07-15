import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeDraftSession } from "@ue-shed/authoring";
import { decodeAuthoringTableSnapshot } from "@ue-shed/protocol";
import { describe, expect, it } from "vitest";

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
		expect(help.stderr).toBe("");

		const version = runCli(["--version"]);
		expect(version.status).toBe(0);
		expect(version.stdout).toMatch(/^ue-shed 0\.0\.0 \(protocol \d+\.\d+\)\r?\n$/);

		const invalid = runCli(["not-a-command"]);
		expect(invalid.status).toBe(2);
		expect(invalid.stdout).toBe("");
		expect(invalid.stderr).toContain("ue-shed: Unknown command: not-a-command");
		expect(invalid.stderr).toContain("ue-shed authoring inspect");
	});

	it("inspects a real saved fixture asset through the native reader", () => {
		const inspection = parseRecord(runSuccessfulCli(["authoring", "inspect", scalarAsset]));
		const snapshot = decodeAuthoringTableSnapshot(inspection.snapshot);

		expect(inspection.fingerprint).toMatch(/^sha256-v1:[a-f0-9]{64}$/);
		expect(snapshot.authority.kind).toBe("project_files");
		expect(snapshot.table.objectPath).toBe(scalarTable);
		expect(snapshot.table.rows.map((row) => row.name)).toEqual(["Scalar_Alpha", "Scalar_Beta"]);
	});

	it("persists an editable session across create, edit, undo, and redo processes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ue-shed-cli-e2e-"));
		const sessionPath = join(directory, "draft.json");

		try {
			const created = decodeDraftSession(
				JSON.parse(
					runSuccessfulCli(["authoring", "session", "create", scalarAsset, sessionPath])
				)
			);
			expect(created.commands).toHaveLength(0);
			expect(created.undoPointer).toBe(0);

			const editedOutput = parseRecord(
				runSuccessfulCli([
					"authoring",
					"draft",
					"set-cell",
					sessionPath,
					scalarTable,
					"Scalar_Alpha",
					"Enabled",
					JSON.stringify({ kind: "bool", value: false })
				])
			);
			const edited = decodeDraftSession(editedOutput.session);
			const working = decodeAuthoringTableSnapshot(editedOutput.working);
			expect(edited.commands).toHaveLength(1);
			expect(edited.undoPointer).toBe(1);
			expect(
				working.table.rows
					.find((row) => row.name === "Scalar_Alpha")
					?.fields.find((field) => field.name === "Enabled")?.value
			).toEqual({ kind: "bool", value: false });

			const undone = decodeDraftSession(
				JSON.parse(runSuccessfulCli(["authoring", "draft", "undo", sessionPath]))
			);
			expect(undone.undoPointer).toBe(0);
			expect(
				decodeDraftSession(
					JSON.parse(runSuccessfulCli(["authoring", "session", "show", sessionPath]))
				).undoPointer
			).toBe(0);

			const redone = decodeDraftSession(
				JSON.parse(runSuccessfulCli(["authoring", "draft", "redo", sessionPath]))
			);
			expect(redone.undoPointer).toBe(1);
			expect(redone.commands).toEqual(edited.commands);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
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
