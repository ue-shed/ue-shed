// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type {
	ContentObservatoryClientShape,
	ContentObservatoryHistoryRequest
} from "./content-observatory-client.js";
import { ContentObservatoryState } from "./content-observatory-client.js";
import { ContentObservatoryRoute } from "./content-observatory-route.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

function completeState() {
	return Schema.decodeUnknownSync(ContentObservatoryState)({
		maps: [{ label: "Example map", mapPath: "Content/Maps/L_Example.umap" }],
		projectRoot: "C:/Project",
		request: {
			limits: {
				maxChangelists: 250,
				maxConcurrency: 4,
				maxDurationMs: 120000,
				maxMaterializedFiles: 4000,
				maxPackages: 4000
			},
			mapPath: "Content/Maps/L_Example.umap",
			range: { since: "2026-07-20T00:00:00.000Z", until: "2026-07-27T00:00:00.000Z" }
		},
		jobId: "world-log-complete",
		status: "complete",
		history: {
			baseline: { change: 9, status: "available" },
			completeness: "complete",
			diagnostics: [],
			mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
			query: {
				limits: {
					maxChangelists: 250,
					maxConcurrency: 4,
					maxDurationMs: 120000,
					maxMaterializedFiles: 4000,
					maxPackages: 4000
				},
				mapPath: "Content/Maps/L_Example.umap",
				projectRoot: "C:/Project",
				range: {
					since: "2026-07-20T00:00:00.000Z",
					until: "2026-07-27T00:00:00.000Z"
				}
			},
			rangeEndSnapshot: {
				actors: [
					{
						actorGuid: "actor-key-lamp",
						actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.KeyLamp",
						classPath: "/Script/Engine.PointLight",
						label: "Key lamp",
						packageName: "/Game/Actors/KeyLamp",
						position: { location: { x: 10, y: 20, z: 30 }, status: "resolved" }
					},
					{
						actorGuid: "actor-ground",
						actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Ground",
						classPath: "/Script/Engine.StaticMeshActor",
						label: "Ground mesh",
						packageName: "/Game/Actors/Ground",
						position: { location: { x: 100, y: 200, z: 0 }, status: "resolved" }
					}
				],
				completeness: "complete",
				diagnostics: [],
				mapPackage: "/Game/Maps/L_Example",
				mapPath: "Content/Maps/L_Example.umap",
				sourceKind: "level",
				summary: {
					failedPackages: 0,
					partialPackages: 0,
					resolvedActors: 2,
					scannedPackages: 1
				}
			},
			revisions: [
				{
					change: 10,
					changes: [
						{
							after: {
								actorGuid: "actor-key-lamp",
								actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.KeyLamp",
								classPath: "/Script/Engine.PointLight",
								label: "Key lamp",
								packageName: "/Game/Actors/KeyLamp",
								position: {
									location: { x: 10, y: 20, z: 30 },
									status: "resolved"
								}
							},
							identity: { actorGuid: "actor-key-lamp", kind: "actor_guid" },
							kind: "actor_added"
						},
						{
							after: {
								actorGuid: "actor-ground",
								actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Ground",
								classPath: "/Script/Engine.StaticMeshActor",
								label: "Ground mesh",
								packageName: "/Game/Actors/Ground",
								position: {
									location: { x: 100, y: 200, z: 0 },
									status: "resolved"
								}
							},
							before: {
								actorGuid: "actor-ground",
								actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Ground",
								classPath: "/Script/Engine.StaticMeshActor",
								label: "Old ground",
								packageName: "/Game/Actors/Ground",
								position: {
									location: { x: 100, y: 200, z: 0 },
									status: "resolved"
								}
							},
							identity: { actorGuid: "actor-ground", kind: "actor_guid" },
							kind: "actor_label_changed"
						}
					],
					completeness: "complete",
					diagnostics: [],
					files: [],
					submittedAt: "2026-07-22T00:00:00.000Z",
					unclassifiedPackageChanges: []
				}
			],
			schemaVersion: 1
		}
	});
}

describe("ContentObservatoryRoute", () => {
	it("explains the project prerequisite without exposing filesystem authority", async () => {
		const client: ContentObservatoryClientShape = {
			cancel: () => Effect.succeed({ status: "not_configured" as const }),
			start: () => Effect.succeed({ status: "not_configured" as const }),
			status: () => Effect.succeed({ status: "not_configured" as const })
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ContentObservatoryRoute client={client} />
			</EffectRuntimeProvider>
		));
		expect(await screen.findByText("Content Observatory has no project root.")).toBeDefined();
		expect(screen.getByText("UE_SHED_PROJECT_ROOT")).toBeDefined();
	});

	it("starts a bounded map query from the selected configured map", async () => {
		let received: ContentObservatoryHistoryRequest | undefined;
		const maps = [
			{
				label: "Map History World",
				mapPath: "Content/Fixture/History/L_MapHistoryWorld.umap"
			}
		];
		const ready = Schema.decodeUnknownSync(ContentObservatoryState)({
			maps,
			projectRoot: "C:/Project",
			status: "ready" as const
		});
		const running = Schema.decodeUnknownSync(ContentObservatoryState)({
			jobId: "map-history-1",
			maps,
			progress: {
				phase: "listing_changes" as const,
				processedChangelists: 0,
				totalChangelists: 0
			},
			projectRoot: "C:/Project",
			request: {
				limits: {
					maxChangelists: 250,
					maxConcurrency: 4,
					maxDurationMs: 120000,
					maxMaterializedFiles: 4000,
					maxPackages: 4000
				},
				mapPath: "Content/Fixture/History/L_MapHistoryWorld.umap",
				range: { since: "2026-07-20T00:00:00.000Z", until: "2026-07-27T00:00:00.000Z" }
			},
			status: "running" as const
		});
		const client: ContentObservatoryClientShape = {
			cancel: () => Effect.succeed(running),
			start: (request) =>
				Effect.sync(() => {
					received = request;
					return running;
				}),
			status: () => Effect.succeed(ready)
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ContentObservatoryRoute client={client} />
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup();
		await screen.findByDisplayValue("Content/Fixture/History/L_MapHistoryWorld.umap");
		await user.click(screen.getByRole("button", { name: /read history/i }));
		expect(received?.mapPath).toBe("Content/Fixture/History/L_MapHistoryWorld.umap");
		expect(received?.limits.maxChangelists).toBe(250);
		expect(await screen.findByText("listing changes")).toBeDefined();
	});

	it("uses the point map and outliner to narrow changelist evidence to one saved actor", async () => {
		const complete = completeState();
		const client: ContentObservatoryClientShape = {
			cancel: () => Effect.succeed(complete),
			start: () => Effect.succeed(complete),
			status: () => Effect.succeed(complete)
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ContentObservatoryRoute client={client} />
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup();
		await screen.findByRole("application", { name: "Top-down saved actor points map" });

		await user.click(screen.getByRole("button", { name: "Key lamp, 1 changes in range" }));
		expect(
			await screen.findByText("1 explained actor changes for selected actor")
		).toBeDefined();
		expect(screen.getByRole("heading", { name: "Key lamp" })).toBeDefined();

		const actorSearch = screen.getByRole("textbox", { name: "Find World Log actor" });
		await user.clear(actorSearch);
		await user.type(actorSearch, "staticmesh");
		const outliner = screen.getByRole("complementary", { name: "Saved actor outliner" });
		expect(within(outliner).getByRole("button", { name: /ground mesh/i })).toBeDefined();
		expect(within(outliner).queryByRole("button", { name: /key lamp/i })).toBeNull();
	});
});
