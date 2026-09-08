import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAuthoringTableSnapshot as decodeAuthoringTableSnapshotEffect } from "@ue-shed/protocol";
import { decodeTextQualityReport as decodeTextQualityReportEffect } from "@ue-shed/game-text";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	repositoryRoot,
	fixtureProject,
	runCli,
	runSuccessfulCli,
	runSuccessfulHeadlessCli,
	parseRecord
} from "./cli-process.test-support.js";

const decodeAuthoringTableSnapshot = <Input>(input: Input) =>
	Effect.runSync(decodeAuthoringTableSnapshotEffect(input));

const decodeTextQualityReport = <Input>(input: Input) =>
	Effect.runSync(decodeTextQualityReportEffect(input));

const uassetTestsEnabled = process.env.UE_SHED_UASSET_AUTO_BUILD !== "0";
// Native-reader scenarios belong to the conditional UAsset lane.
const nativeIt = it.skipIf(!uassetTestsEnabled);

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

const configFixture = join(
	repositoryRoot,
	"packages",
	"config-explorer",
	"fixtures",
	"config-source"
);

const fixtureTextQualityRules = join(
	repositoryRoot,
	"packages",
	"game-text",
	"fixtures",
	"quality-rules.v1.json"
);

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
		expect(invalid.stderr).toContain('ue-shed: Unknown subcommand "not-a-command"');
	}, 20_000);

	it("explains and compares saved config provenance through the executable boundary", () => {
		const explanation = parseRecord(
			runSuccessfulHeadlessCli([
				"config",
				"explain",
				configFixture,
				"Fixture.Settings",
				"Entries",
				"--platform",
				"PlatformA",
				"--engine-root",
				configFixture,
				"--family",
				"Game"
			])
		);
		expect(explanation.status).toBe("complete");
		expect(explanation.effectiveValue).toEqual({ kind: "array", values: ["PlatformA"] });
		expect(JSON.stringify(explanation)).not.toContain(configFixture);

		const comparison = parseRecord(
			runSuccessfulHeadlessCli([
				"config",
				"compare",
				configFixture,
				"Fixture.Settings",
				"Entries",
				"--left-platform",
				"PlatformA",
				"--right-platform",
				"PlatformB",
				"--engine-root",
				configFixture,
				"--family",
				"Game"
			])
		);
		expect(comparison.status).toBe("different");
		expect(comparison.valueChanged).toBe(true);
	}, 30_000);

	nativeIt("inspects a real saved fixture asset through the native reader", () => {
		const inspection = parseRecord(runSuccessfulCli(["authoring", "inspect", scalarAsset]));
		const snapshot = decodeAuthoringTableSnapshot(inspection.snapshot);

		expect(inspection.fingerprint).toMatch(/^sha256-v1:[a-f0-9]{64}$/);
		expect(snapshot.authority.kind).toBe("project_files");
		expect(snapshot.table.objectPath).toBe(scalarTable);
		expect(snapshot.table.rows.map((row) => row.name)).toEqual(["Scalar_Alpha", "Scalar_Beta"]);
	});

	nativeIt("runs the direct assets workflow against a real saved fixture", () => {
		const report = parseRecord(runSuccessfulCli(["assets", "scan", scalarAsset]));

		expect(report.coverage).toMatchObject({
			emittedAssets: 1,
			failedAssets: 0,
			scannedAssets: 1
		});
		expect(report.assets).toEqual([
			expect.objectContaining({
				packageName: "/Game/Fixture/Authoring/DT_Scalars",
				status: "ok"
			})
		]);
	});

	nativeIt(
		"reviews the real saved text corpus with project-authored rules",
		() => {
			const output: unknown = JSON.parse(
				runSuccessfulCli([
					"text",
					"review",
					fixtureProject,
					"--rules",
					fixtureTextQualityRules
				])
			);
			const report = decodeTextQualityReport(output);

			expect(report.schemaVersion).toBe(1);
			expect(report.ruleDocumentVersion).toBe(1);
			expect(report.status).toBe("partial");
			expect(report.coverage.unsupportedTextProperties).toBe(1);
			expect(report.findings.length).toBeGreaterThan(0);
			expect(report.findings.every((finding) => finding.role === "ui.prompt")).toBe(true);
		},
		30_000
	);

	nativeIt("resolves fixture row references through the public headless command", () => {
		const report = parseRecord(
			runSuccessfulCli(["authoring", "relationships", fixtureProject])
		);
		expect(report.contract).toEqual({
			name: "unreal-authoring-row-references",
			version: { major: 1, minor: 0 }
		});
		expect(report.summary).toEqual({
			issueCount: 0,
			referenceCount: 2,
			resolvedCount: 2,
			snapshotCount: 12
		});
		expect(report.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					status: "resolved",
					target: {
						rowName: "Right_Alpha",
						tableObjectPath:
							"/Game/Fixture/Authoring/DT_RightReferences.DT_RightReferences"
					}
				})
			])
		);
	});

	nativeIt("projects a read-only joined view through the public headless command", () => {
		const view = parseRecord(
			runSuccessfulCli([
				"authoring",
				"join",
				fixtureProject,
				"/Game/Fixture/Authoring/DT_LeftReferences.DT_LeftReferences",
				"Target"
			])
		);
		expect(view.contract).toEqual({
			name: "unreal-authoring-joined-view",
			version: { major: 1, minor: 0 }
		});
		expect(view.editability).toEqual(expect.objectContaining({ kind: "read_only" }));
		expect(view.summary).toEqual({
			resolvedCount: 2,
			rowCount: 2,
			unresolvedCount: 0
		});
		expect(view.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: expect.objectContaining({
						rowName: "Left_Alpha",
						tableObjectPath:
							"/Game/Fixture/Authoring/DT_LeftReferences.DT_LeftReferences"
					}),
					status: "resolved",
					target: expect.objectContaining({
						rowName: "Right_Alpha",
						tableObjectPath:
							"/Game/Fixture/Authoring/DT_RightReferences.DT_RightReferences"
					}),
					targetRow: expect.objectContaining({
						fields: expect.arrayContaining([
							expect.objectContaining({
								name: "Description",
								value: { kind: "string", value: "First reference target" }
							})
						])
					})
				})
			])
		);
	});

	nativeIt(
		"profiles a saved DataTable into suggested charts",
		() => {
			const plan = parseRecord(
				runSuccessfulCli(["authoring", "analyze", fixtureProject, scalarTable])
			);
			expect(plan.contract).toEqual({
				name: "unreal-authoring-analysis",
				version: { major: 1, minor: 0 }
			});
			expect(plan.tableObjectPath).toBe(scalarTable);
			expect(plan.rowCount).toBe(2);
			expect(plan.charts).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "category-count",
						xLabel: "Enabled"
					}),
					expect.objectContaining({
						kind: "histogram",
						xLabel: "Count"
					}),
					expect.objectContaining({
						kind: "scatter",
						xLabel: "Count",
						yLabel: "Ratio"
					})
				])
			);
		},
		30_000
	);

	nativeIt(
		"runs the persistent session lifecycle through separate CLI processes",
		async () => {
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
					decodeAuthoringTableSnapshot(reordered.working).table.rows.map(
						(row) => row.name
					)
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
		},
		30_000
	);

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
});
