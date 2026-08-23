// @vitest-environment jsdom

import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { AuditRuleId, TextureObjectPath } from "@ue-shed/asset-audits/browser";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { TextureAuditClientApi } from "./texture-audit-client.js";
import { savedPreviewBatchPaths, TextureAuditRoute } from "./texture-audit-query-route.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

describe("TextureAuditRoute", () => {
	it("uses the globally selected project and exposes no second chooser", async () => {
		let rescans = 0;
		const client: TextureAuditClientApi = {
			chooseProjectAndScan: () =>
				Effect.die("the route must use the Workbench header for project choice"),
			locateAsset: () => Effect.die("unused"),
			record: () => Effect.die("unused"),
			search: () => Effect.die("unused"),
			launchUnreal: () => Effect.die("unused"),
			loadConfiguredProject: () =>
				Effect.sync(() => {
					rescans += 1;
					return { status: "not_configured" as const };
				}),
			loadPreview: () => Effect.die("unused"),
			loadOfflinePreview: () => Effect.die("unused"),
			loadOfflinePreviews: () => Effect.die("unused"),
			progress: () =>
				Effect.succeed({
					completed: 0,
					phase: "idle",
					stage: "texture_audit",
					total: 0
				})
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<TextureAuditRoute client={client} />
			</EffectRuntimeProvider>
		));
		expect(await screen.findByText("No project configured.")).toBeDefined();
		expect(screen.queryByRole("button", { name: "Choose project" })).toBeNull();
		await userEvent.setup().click(screen.getByRole("button", { name: "Rescan assets" }));
		expect(rescans).toBe(2);
	});

	it("keeps saved preview generation behind an explicit fallback action", async () => {
		const objectPath = TextureObjectPath.make("/Game/Textures/T_Offline.T_Offline");
		let offlineRequests = 0;
		let locateRequests = 0;
		const record = {
			compression: { reason: "not_serialized" as const, status: "unavailable" as const },
			dimensions: {
				source: "serialized" as const,
				status: "available" as const,
				value: { height: 64, width: 64 }
			},
			filePath: "C:/Project/Content/Textures/T_Offline.uasset",
			mipGeneration: { reason: "not_serialized" as const, status: "unavailable" as const },
			objectPath,
			packageFileBytes: { source: "file" as const, status: "available" as const, value: 64 },
			sourceFormat: { reason: "not_serialized" as const, status: "unavailable" as const },
			sourceMips: { reason: "not_serialized" as const, status: "unavailable" as const },
			sRGB: { reason: "not_serialized" as const, status: "unavailable" as const },
			textureGroup: { reason: "not_serialized" as const, status: "unavailable" as const }
		};
		const warningPath = TextureObjectPath.make("/Game/Textures/T_Warning.T_Warning");
		const selectedPath = TextureObjectPath.make("/Game/Textures/T_Selected.T_Selected");
		expect(
			savedPreviewBatchPaths(
				{
					findings: [
						{
							actual: [],
							expected: [],
							explanation: "warning",
							objectPath: warningPath,
							ruleId: AuditRuleId.make("warning-rule"),
							severity: "warning"
						}
					],
					records: [
						record,
						{ ...record, objectPath: warningPath },
						{ ...record, objectPath: selectedPath }
					],
					total: 3
				},
				selectedPath
			)
		).toEqual([selectedPath, warningPath, objectPath]);
		const client: TextureAuditClientApi = {
			chooseProjectAndScan: () => Effect.die("unused"),
			locateAsset: (requestedPath) =>
				Effect.sync(() => {
					locateRequests += 1;
					return {
						contract: {
							name: "unreal-editor-asset-navigation" as const,
							version: { major: 1 as const, minor: 0 as const }
						},
						objectPath: requestedPath,
						status: "located" as const
					};
				}),
			launchUnreal: () => Effect.die("unused"),
			loadConfiguredProject: () =>
				Effect.succeed({
					status: "completed" as const,
					summary: {
						coverage: {
							discoveredPackages: 1,
							failedPackages: 0,
							inspectedPackages: 1,
							partialPackages: 0,
							textureAssets: 1
						},
						diagnosticCount: 0,
						distributions: {
							compression: [],
							maximumDimension: [],
							sRGB: [],
							textureGroup: []
						},
						findingCount: 0,
						ruleSetName: "test",
						schemaVersion: 1 as const,
						status: "complete" as const
					}
				}),
			loadOfflinePreview: () => Effect.die("the route must use the bounded batch operation"),
			loadOfflinePreviews: (request) =>
				Effect.sync(() => {
					offlineRequests += 1;
					return {
						cached: 0,
						generated: request.objectPaths.length,
						previews: request.objectPaths.map((requestedPath) => ({
							authority: "saved_asset" as const,
							contract: {
								name: "texture-preview" as const,
								version: { major: 1 as const, minor: 0 as const }
							},
							dataBase64: "iVBORw0KGgo=",
							height: 1,
							mimeType: "image/png" as const,
							objectPath: requestedPath,
							status: "available" as const,
							width: 1
						}))
					};
				}),
			loadPreview: () =>
				Effect.succeed({
					contract: {
						name: "texture-preview" as const,
						version: { major: 1 as const, minor: 0 as const }
					},
					message: "No editor is connected.",
					objectPath,
					reason: "not_connected" as const,
					retrySafe: true,
					status: "unavailable" as const
				}),
			progress: () =>
				Effect.succeed({ completed: 0, phase: "idle", stage: "texture_audit", total: 0 }),
			record: () =>
				Effect.succeed({
					record: {
						comparisons: [
							{
								findingCount: 0,
								kind: "project" as const,
								label: "Whole project",
								maximumDimension: {
									availableCount: 1,
									maximum: 64,
									median: 64,
									minimum: 64,
									percentile: 100,
									selected: 64,
									status: "available" as const
								},
								memberCount: 1,
								packageFileBytes: {
									availableCount: 1,
									maximum: 64,
									median: 64,
									minimum: 64,
									percentile: 100,
									selected: 64,
									status: "available" as const
								},
								peers: []
							}
						],
						defaultComparison: "project" as const,
						findings: [],
						record
					},
					status: "found" as const
				}),
			search: () =>
				Effect.succeed({
					page: { findings: [], records: [record], total: 1 },
					status: "ready" as const
				})
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<TextureAuditRoute client={client} />
			</EffectRuntimeProvider>
		));

		const generate = await screen.findByRole("button", { name: "Generate preview" });
		expect(offlineRequests).toBe(0);
		await userEvent.setup().click(generate);
		expect(await screen.findByText("Saved asset")).toBeDefined();
		expect(offlineRequests).toBe(1);

		expect(locateRequests).toBe(0);
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Locate T_Offline in Unreal" }));
		expect(await screen.findByText("Located")).toBeDefined();
		expect(locateRequests).toBe(1);
	});
});
