import { parseTextQualityReport } from "@ue-shed/game-text/schema";
import { decodeAuthoringTableSnapshot as decodeAuthoringTableSnapshotEffect } from "@ue-shed/protocol";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import {
	fixtureProject,
	parseRecord,
	repositoryRoot,
	runSuccessfulCli
} from "./cli-in-process.test-support.js";
import { runCli, runSuccessfulCli as runSuccessfulProcessCli } from "./cli-process.test-support.js";

const decodeAuthoringTableSnapshot = <Input>(input: Input) =>
	Effect.runSync(decodeAuthoringTableSnapshotEffect(input));

const decodeTextQualityReport = (input: Parameters<typeof parseTextQualityReport>[0]) =>
	Effect.runSync(parseTextQualityReport(input));

const uassetTestsEnabled = process.env.UE_SHED_UASSET_AUTO_BUILD !== "0";
// Native-reader scenarios belong to the conditional UAsset lane.
const nativeIt = it.skipIf(!uassetTestsEnabled);

const fixture = useSavedFixtureProject();
const reader = process.env.UE_SHED_UASSET_EXECUTABLE;
const runWithReader = (args: readonly string[]) => {
	if (!reader) throw new Error("The saved reader is not configured.");
	return runSuccessfulCli([...args, "--reader", reader]);
};
// Keep the relationship journey independent of unrelated DataTables added to the full fixture.
const references = useSavedFixtureProject([
	"UEShedFixture.uproject",
	"Content/Fixture/Authoring/DT_LeftReferences.uasset",
	"Content/Fixture/Authoring/DT_RightReferences.uasset"
]);

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
	"quality-rules.source.json"
);

describe("ue-shed CLI commands", () => {
	it("prints the retained schema issue for invalid row IDs", async () => {
		const result = runCli([
			"authoring",
			"sessions",
			"reorder-rows",
			"example",
			"/Game/Table",
			"[1]",
			"--project",
			fixtureProject
		]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("Row IDs does not match its schema.");
		expect(result.stderr).toContain("Expected string");
		expect(result.stderr).toContain("[0]");
	});
	it("maps an invalid command to usage exit status through the executable boundary", async () => {
		const invalid = runCli(["not-a-command"]);
		expect(invalid.status).toBe(2);
		expect(invalid.stdout).toBe("");
		expect(invalid.stderr).toContain('ue-shed: Unknown subcommand "not-a-command"');
	}, 90_000);

	it("explains and compares saved config provenance through the command tree", async () => {
		const explanation = parseRecord(
			await runSuccessfulCli([
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
			await runSuccessfulCli([
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

	nativeIt("auto-builds the reader and inspects a real saved fixture through the wrapper", () => {
		vi.stubEnv("UE_SHED_UASSET_EXECUTABLE", undefined);
		try {
			const inspection = parseRecord(
				runSuccessfulProcessCli(["authoring", "inspect", scalarAsset])
			);
			const snapshot = decodeAuthoringTableSnapshot(inspection.snapshot);

			expect(inspection.fingerprint).toMatch(/^sha256-v1:[a-f0-9]{64}$/);
			expect(snapshot.authority.kind).toBe("project_files");
			expect(snapshot.table.objectPath).toBe(scalarTable);
			expect(snapshot.table.rows.map((row) => row.name)).toEqual([
				"Scalar_Alpha",
				"Scalar_Beta"
			]);
		} finally {
			vi.stubEnv("UE_SHED_UASSET_EXECUTABLE", reader);
		}
	});

	nativeIt("runs the direct assets workflow against a real saved fixture", async () => {
		const report = parseRecord(await runWithReader(["assets", "scan", scalarAsset]));

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
		async () => {
			const output: unknown = JSON.parse(
				await runWithReader([
					"text",
					"review",
					fixture.root,
					"--rules",
					fixtureTextQualityRules
				])
			);
			const report = decodeTextQualityReport(output);

			expect(report.schemaVersion).toBe(1);
			expect(report.ruleDocumentVersion).toBe(1);
			// One Game Text problem case is a package the reader only partly decodes.
			expect(report.status).toBe("partial");
			expect(report.coverage.partialPackages).toBe(1);
			expect(report.coverage.unsupportedTextProperties).toBe(0);
			expect(report.findings.length).toBeGreaterThan(0);
			expect(report.findings.every((finding) => finding.role === "ui.prompt")).toBe(true);
		},
		30_000
	);

	nativeIt("resolves fixture row references through the public headless command", async () => {
		const report = parseRecord(
			await runWithReader(["authoring", "relationships", references.root])
		);
		expect(report.contract).toEqual({
			name: "unreal-authoring-row-references",
			version: { major: 1, minor: 0 }
		});
		expect(report.summary).toEqual({
			issueCount: 0,
			referenceCount: 2,
			resolvedCount: 2,
			snapshotCount: 2
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

	nativeIt("projects a read-only joined view through the public headless command", async () => {
		const view = parseRecord(
			await runWithReader([
				"authoring",
				"join",
				fixture.root,
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
		async () => {
			const plan = parseRecord(
				await runWithReader(["authoring", "analyze", fixture.root, scalarTable])
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

	// Each command owns a fresh scope and reloads the durable session from disk.
	nativeIt(
		"runs the persistent session lifecycle through independent CLI scopes",
		async () => {
			const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-cli-sessions-"));
			try {
				const created = parseRecord(
					await runWithReader([
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
					await runWithReader([
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
					await runWithReader([
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
					await runWithReader([
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
					await runWithReader([
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
					await runWithReader([
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
					await runWithReader([
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
					await runWithReader([
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
					await runWithReader([
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
					await runWithReader([
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
					await runWithReader([
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
					await runWithReader([
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
					await runWithReader([
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
					await runWithReader(["authoring", "sessions", "list", "--project", projectRoot])
				);
				expect(listed.sessions).toHaveLength(1);
			} finally {
				await rm(projectRoot, { force: true, recursive: true });
			}
		},
		120_000
	);
});
