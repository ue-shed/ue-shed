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

type CompletedContentObservatoryState = Extract<ContentObservatoryState, { status: "complete" }>;

HTMLCanvasElement.prototype.getContext = (() =>
	({
		arc: () => undefined,
		beginPath: () => undefined,
		clearRect: () => undefined,
		fill: () => undefined,
		fillStyle: "",
		lineTo: () => undefined,
		lineWidth: 1,
		moveTo: () => undefined,
		setTransform: () => undefined,
		stroke: () => undefined,
		strokeStyle: ""
	}) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext;

function completeState(): CompletedContentObservatoryState {
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
			rangeStartSnapshot: {
				actors: [
					{
						actorGuid: "actor-departed",
						actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Departed",
						classPath: "/Script/Game.Npc",
						label: "Departed NPC",
						packageName: "/Game/Actors/Departed",
						position: { location: { x: -50, y: -60, z: 0 }, status: "resolved" }
					},
					{
						actorGuid: "actor-ground",
						actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Ground",
						classPath: "/Script/Engine.StaticMeshActor",
						label: "Old ground",
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
						},
						{
							before: {
								actorGuid: "actor-departed",
								actorPath:
									"/Game/Maps/L_Example.L_Example:PersistentLevel.Departed",
								classPath: "/Script/Game.Npc",
								label: "Departed NPC",
								packageName: "/Game/Actors/Departed",
								position: {
									location: { x: -50, y: -60, z: 0 },
									status: "resolved"
								}
							},
							identity: { actorGuid: "actor-departed", kind: "actor_guid" },
							kind: "actor_removed"
						}
					],
					completeness: "complete",
					diagnostics: [],
					files: [],
					submittedAt: "2026-07-22T00:00:00.000Z",
					unclassifiedPackageChanges: []
				},
				{
					change: 11,
					changes: [],
					completeness: "complete",
					diagnostics: [],
					files: [],
					submittedAt: "2026-07-23T00:00:00.000Z",
					unclassifiedPackageChanges: [
						{
							action: "edit",
							afterRevision: 2,
							actorIdentities: [],
							beforeRevision: 1,
							depotPath: "//Project/Main/Content/Maps/L_Example.umap",
							packageName: "/Game/Maps/L_Example",
							reason: "projection_unchanged"
						}
					]
				}
			],
			schemaVersion: 1
		}
	}) as CompletedContentObservatoryState;
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
		expect(screen.queryByLabelText("Advanced scan limits")).toBeNull();
		await user.click(screen.getByRole("button", { name: "ADVANCED LIMITS" }));
		await user.clear(screen.getByLabelText("CHANGE LISTS"));
		await user.type(screen.getByLabelText("CHANGE LISTS"), "12");
		await user.click(screen.getByRole("button", { name: /read history/i }));
		expect(received?.mapPath).toBe("Content/Fixture/History/L_MapHistoryWorld.umap");
		expect(received?.limits.maxChangelists).toBe(12);
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

		const pointMap = screen.getByRole("application", {
			name: "Top-down saved actor points map"
		});
		pointMap.focus();
		await user.keyboard("{ArrowRight}");
		await user.keyboard("{ArrowRight}");
		expect(await screen.findByText("3 map actor changes")).toBeDefined();
		expect(screen.getByRole("heading", { name: "Key lamp" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Select changelist 11" })).toBeDefined();

		const actorSearch = screen.getByRole("textbox", { name: "Find World Log actor" });
		await user.clear(actorSearch);
		await user.type(actorSearch, "staticmesh");
		const outliner = screen.getByRole("complementary", { name: "Saved actor outliner" });
		expect(within(outliner).getByRole("button", { name: /ground mesh/i })).toBeDefined();
		expect(within(outliner).queryByRole("button", { name: /key lamp/i })).toBeNull();
	});

	it("keeps attributable actor focus and package evidence together for a timeline change", async () => {
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
		await user.click(
			screen.getByRole("button", { name: /added\s*key lamp\s*new saved actor/i })
		);

		expect(await screen.findByText("3 map actor changes")).toBeDefined();
		expect(screen.getByRole("heading", { name: "Key lamp" })).toBeDefined();
		const evidence = screen.getByRole("complementary", {
			name: "Selected changelist evidence"
		});
		expect(within(evidence).getByRole("heading", { name: "CL 10" })).toBeDefined();
		expect(
			await screen.findByRole("application", { name: "Top-down changelist 10 diff map" })
		).toBeDefined();
	});

	it("keeps a selected changelist visible while its diff map focuses an actor", async () => {
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
		await user.click(screen.getByRole("button", { name: "Select changelist 10" }));
		const changelistMap = await screen.findByRole("application", {
			name: "Top-down changelist 10 diff map"
		});
		changelistMap.focus();
		await user.keyboard("{ArrowRight}");

		expect(screen.getByRole("heading", { name: "CL 10 map diff" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Select changelist 11" })).toBeDefined();
	});

	it("uses field-qualified actor View Filters and opens a selected actor event locally", async () => {
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
		const outliner = screen.getByRole("complementary", { name: "Saved actor outliner" });
		const actorSearch = screen.getByRole("textbox", { name: "Find World Log actor" });
		await user.type(actorSearch, "class:pointlight");
		expect(within(outliner).getByRole("button", { name: /key lamp/i })).toBeDefined();
		expect(within(outliner).queryByRole("button", { name: /ground mesh/i })).toBeNull();

		await user.click(within(outliner).getByRole("button", { name: /key lamp/i }));
		const inspector = screen.getByRole("complementary", { name: "Selected saved actor" });
		expect(within(inspector).getByText("added in range")).toBeDefined();
		await user.click(within(inspector).getByRole("button", { name: /CL 10.*key lamp/i }));

		expect(
			await screen.findByRole("application", { name: "Top-down changelist 10 diff map" })
		).toBeDefined();
	});

	it("keeps a range-removed actor inspectable with its lifecycle evidence", async () => {
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
		const outliner = screen.getByRole("complementary", { name: "Saved actor outliner" });
		await user.type(
			screen.getByRole("textbox", { name: "Find World Log actor" }),
			"label:departed"
		);
		const departed = within(outliner).getByRole("button", { name: /departed npc/i });
		expect(within(departed).getByText("REMOVED")).toBeDefined();
		await user.click(departed);

		const inspector = screen.getByRole("complementary", { name: "Selected saved actor" });
		expect(within(inspector).getByText("removed in range")).toBeDefined();
		expect(within(inspector).getByText("REMOVED")).toBeDefined();
	});

	it("replays discrete saved actor frames without another history request", async () => {
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

		await user.click(screen.getByRole("button", { name: "Show state at range start" }));
		expect(screen.getByRole("heading", { name: "RANGE START point map" })).toBeDefined();
		const outliner = screen.getByRole("complementary", { name: "Saved actor outliner" });
		await user.click(within(outliner).getByRole("button", { name: /old ground/i }));

		const inspector = screen.getByRole("complementary", { name: "Selected saved actor" });
		expect(within(inspector).getByRole("heading", { name: "Old ground" })).toBeDefined();
		expect(within(inspector).getByText("RANGE START")).toBeDefined();
		expect(within(inspector).getByText("AT FRAME")).toBeDefined();

		await user.click(screen.getByRole("button", { name: "Show state after CL 10" }));
		expect(within(inspector).getByRole("heading", { name: "Ground mesh" })).toBeDefined();
		expect(within(inspector).getByText("AFTER CL 10")).toBeDefined();

		await user.click(screen.getByRole("button", { name: "Show state after CL 11" }));
		expect(
			screen.getByText(
				"1 unclassified package change at this frame. Their changed bytes remain in the changelist evidence ledger."
			)
		).toBeDefined();
	});

	it("retains and labels a completed result when its map query becomes stale", async () => {
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
		expect(screen.queryByLabelText("Stale World Log result")).toBeNull();

		await user.clear(screen.getByLabelText("MAP PATH"));
		await user.type(screen.getByLabelText("MAP PATH"), "Content/Maps/L_Other.umap");

		expect(screen.getByLabelText("Stale World Log result")).toBeDefined();
		expect(screen.getByRole("heading", { name: "AFTER CL 11 point map" })).toBeDefined();
	});

	it("labels partial and empty saved frames without presenting them as failures", async () => {
		const complete = completeState();
		const partial: CompletedContentObservatoryState = {
			...complete,
			history: {
				...complete.history,
				completeness: "partial",
				revisions: complete.history.revisions.map((revision, index) =>
					index === 0 ? { ...revision, completeness: "partial" } : revision
				)
			}
		};
		const partialClient: ContentObservatoryClientShape = {
			cancel: () => Effect.succeed(partial),
			start: () => Effect.succeed(partial),
			status: () => Effect.succeed(partial)
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ContentObservatoryRoute client={partialClient} />
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup();
		await screen.findByRole("application", { name: "Top-down saved actor points map" });
		await user.click(screen.getByRole("button", { name: "Show state after CL 10" }));
		expect(
			screen.getByText(
				"Partial saved-world coverage at this frame. Actor state is limited to the packages that could be read."
			)
		).toBeDefined();
		cleanup();

		const {
			rangeEndSnapshot: _rangeEndSnapshot,
			rangeStartSnapshot: _rangeStartSnapshot,
			...emptyHistory
		} = complete.history;
		const empty: CompletedContentObservatoryState = {
			...complete,
			history: {
				...emptyHistory,
				baseline: { status: "map_not_yet_created" },
				revisions: []
			}
		};
		const emptyClient: ContentObservatoryClientShape = {
			cancel: () => Effect.succeed(empty),
			start: () => Effect.succeed(empty),
			status: () => Effect.succeed(empty)
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ContentObservatoryRoute client={emptyClient} />
			</EffectRuntimeProvider>
		));
		expect(
			await screen.findByText(
				"This range begins before the map was created. The empty state is a saved baseline, not a failed reconstruction."
			)
		).toBeDefined();
	});
});
