import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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

function runCliAsync(args: readonly string[]): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cliScript, ...args], {
			cwd: repositoryRoot,
			env: process.env,
			windowsHide: true
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
		child.once("error", reject);
		child.once("close", (status) => resolve({ status, stderr, stdout }));
	});
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
		expect(invalid.stderr).toContain('ue-shed: Unknown subcommand "not-a-command"');
	}, 20_000);

	it("inspects a real saved fixture asset through the native reader", () => {
		const inspection = parseRecord(runSuccessfulCli(["authoring", "inspect", scalarAsset]));
		const snapshot = decodeAuthoringTableSnapshot(inspection.snapshot);

		expect(inspection.fingerprint).toMatch(/^sha256-v1:[a-f0-9]{64}$/);
		expect(snapshot.authority.kind).toBe("project_files");
		expect(snapshot.table.objectPath).toBe(scalarTable);
		expect(snapshot.table.rows.map((row) => row.name)).toEqual(["Scalar_Alpha", "Scalar_Beta"]);
	});

	it("runs the direct assets workflow against a real saved fixture", () => {
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

	it("resolves fixture row references through the public headless command", () => {
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

	it("projects a read-only joined view through the public headless command", () => {
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

	it("inspects, replaces, and explicitly applies Visibility Policies", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-review-policies-"));
		try {
			const reviewSetPath = join(root, "review-set.json");
			const policyPath = join(root, "policy.json");
			await copyFile(fixtureReviewSet, reviewSetPath);
			await writeFile(
				policyPath,
				JSON.stringify({
					assessment: { method: "depth_compare" },
					id: "fixture-clear-v2",
					name: "Fixture Clear v2",
					onLowVisibility: { action: "warn", threshold: 0.5 },
					output: {
						clearStrategy: { type: "isolate_target" },
						mode: "natural_and_clear"
					}
				}),
				"utf8"
			);

			const before = parseRecord(
				runSuccessfulCli(["review", "policies", "list", reviewSetPath])
			);
			expect(before.policies).toEqual([
				expect.objectContaining({
					assignedViewIds: ["structure-context"],
					policy: expect.objectContaining({ id: "default-natural-only" })
				})
			]);

			const replaced = parseRecord(
				runSuccessfulCli([
					"review",
					"policies",
					"replace",
					reviewSetPath,
					"structure-context",
					policyPath
				])
			);
			expect(replaced).toMatchObject({
				policyId: "fixture-clear-v2",
				status: "replaced",
				viewId: "structure-context"
			});

			const applied = parseRecord(
				runSuccessfulCli([
					"review",
					"policies",
					"apply",
					reviewSetPath,
					"default-natural-only",
					"structure-context"
				])
			);
			expect(applied).toMatchObject({
				policyId: "default-natural-only",
				status: "applied",
				viewIds: ["structure-context"]
			});
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("authors and revises a fixed area View with immutable revision identity", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-review-views-"));
		try {
			const reviewSetPath = join(root, "review-set.json");
			const viewPath = join(root, "area-view.json");
			await copyFile(fixtureReviewSet, reviewSetPath);
			const areaView = {
				captureProfileId: "fixture-hd",
				displayName: "Loading area",
				framingDiagnostics: [
					{ code: "bounds_snapshot", message: "Portable area", severity: "info" }
				],
				framingRecipe: { kind: "manual", version: 1 },
				id: "loading-area",
				purpose: "Review the loading area",
				revision: { id: "loading-area-r1", number: 1, status: "numbered" },
				tags: ["area"],
				target: {
					bounds: {
						center: { x: 0, y: 0, z: 200 },
						extent: { x: 600, y: 400, z: 200 },
						rotation: { pitch: 0, roll: 0, yaw: 30 }
					},
					kind: "oriented_box"
				},
				viewpoint: {
					approvedPose: {
						aspectRatio: "16:9",
						fieldOfViewDegrees: 60,
						location: { x: 1500, y: -1500, z: 900 },
						projection: "perspective",
						rotation: { pitch: -18, roll: 0, yaw: 135 }
					},
					kind: "world_fixed"
				},
				visibilityPolicyId: "default-natural-only"
			};
			await writeFile(viewPath, JSON.stringify(areaView), "utf8");
			expect(
				parseRecord(runSuccessfulCli(["review", "views", "put", reviewSetPath, viewPath]))
			).toMatchObject({
				revision: { id: "loading-area-r1", number: 1 },
				status: "created",
				viewId: "loading-area"
			});

			areaView.viewpoint.approvedPose.location.x = 1750;
			await writeFile(viewPath, JSON.stringify(areaView), "utf8");
			expect(
				parseRecord(runSuccessfulCli(["review", "views", "put", reviewSetPath, viewPath]))
			).toMatchObject({
				revision: { id: "loading-area-r2", number: 2 },
				status: "revised",
				viewId: "loading-area"
			});
			const persisted = JSON.parse(await readFile(reviewSetPath, "utf8")) as {
				views: Array<{ id: string; revision: { id: string; number: number } }>;
			};
			expect(persisted.views.find((view) => view.id === "loading-area")?.revision).toEqual({
				id: "loading-area-r2",
				number: 2,
				status: "numbered"
			});
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("records two external-automation captures from separate CLI processes", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-review-external-processes-"));
		const reviewSetPath = join(root, "review-set.json");
		await copyFile(fixtureReviewSet, reviewSetPath);
		const server = createServer((request, response) => {
			void (async () => {
				let body = "";
				request.setEncoding("utf8");
				for await (const chunk of request) body += chunk;
				const call = JSON.parse(body) as {
					functionName: string;
					parameters: { RequestJson: string };
				};
				if (call.functionName !== "CaptureReviewView") throw new Error("Unexpected call");
				const capture = JSON.parse(call.parameters.RequestJson) as {
					contract: { name: "ue-shed-review-capture"; version: { major: 1; minor: 4 } };
					expectedMapPath: string;
					operationId: string;
					resolution: { height: number; width: number };
					subject: { actorPath: string; kind: "actor_path" };
					viewId: string;
					viewpoint: {
						approvedPose: unknown;
						kind: "world_fixed";
					};
				};
				const stagingPath = join(
					root,
					"Saved",
					"UEShed",
					"ReviewStaging",
					capture.operationId,
					capture.viewId,
					"pure.png"
				);
				await mkdir(join(stagingPath, ".."), { recursive: true });
				await writeFile(stagingPath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						ResultJson: JSON.stringify({
							captureDurationMs: 1,
							clearCompanion: { status: "not_requested" },
							contract: capture.contract,
							effectiveWorldPose: capture.viewpoint.approvedPose,
							height: capture.resolution.height,
							mapPackageDirtyAfter: false,
							mapPackageDirtyBefore: false,
							mapPath: capture.expectedMapPath,
							operationId: capture.operationId,
							resolvedSubject: {
								...capture.subject,
								transform: {
									location: { x: 0, y: 0, z: 0 },
									rotation: { pitch: 0, roll: 0, yaw: 0 }
								}
							},
							stagedArtifacts: [{ stagingPath, variant: "pure" }],
							status: "captured",
							subjectProjection: {
								margins: { bottom: 0.1, left: 0.1, right: 0.1, top: 0.1 },
								normalizedBounds: { maxX: 0.9, maxY: 0.9, minX: 0.1, minY: 0.1 },
								status: "projected",
								viewportStatus: "fully_within_viewport"
							},
							viewId: capture.viewId,
							visibility: { reason: "Fake producer", status: "not_assessed" },
							width: capture.resolution.width
						})
					})
				);
			})().catch((cause) => {
				response.writeHead(500);
				response.end(String(cause));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("No server port");
			const endpoint = `http://127.0.0.1:${address.port}`;
			const captureArgs = [
				"review",
				"capture",
				root,
				reviewSetPath,
				endpoint,
				"--cause",
				"external_automation",
				"--correlation",
				"nightly-fixture"
			];
			const firstProcess = await runCliAsync(captureArgs);
			const secondProcess = await runCliAsync(captureArgs);
			expect(firstProcess.status, firstProcess.stderr).toBe(0);
			expect(secondProcess.status, secondProcess.stderr).toBe(0);
			const first = parseRecord(firstProcess.stdout);
			const second = parseRecord(secondProcess.stdout);
			expect(first.id).not.toBe(second.id);
			expect(first.invocation).toMatchObject({
				cause: { correlationId: "nightly-fixture", type: "external_automation" }
			});
			expect(second.invocation).toMatchObject({
				cause: { correlationId: "nightly-fixture", type: "external_automation" }
			});
			const firstResult = (first.results as Array<Record<string, unknown>>)[0]!;
			const secondResult = (second.results as Array<Record<string, unknown>>)[0]!;
			expect(firstResult.viewRevision).toEqual(secondResult.viewRevision);
			expect(firstResult.realization).toEqual(secondResult.realization);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { force: true, recursive: true });
		}
	}, 30_000);
});
