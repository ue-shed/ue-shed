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
import {
	ContentObservatoryState,
	ContentObservatoryTargetCatalog
} from "./content-observatory-client.js";
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
			mode: "deep",
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

function fastCompleteState(): CompletedContentObservatoryState {
	const complete = completeState();
	const encoded = Schema.encodeSync(ContentObservatoryState)(complete) as Extract<
		Schema.Codec.Encoded<typeof ContentObservatoryState>,
		{ readonly status: "complete" }
	>;
	return Schema.decodeUnknownSync(ContentObservatoryState)({
		...encoded,
		request: {
			...encoded.request,
			mode: "fast",
			target: { classPath: "/Script/Game.Npc", kind: "actor_class" }
		},
		history: {
			...encoded.history,
			coverage: {
				acquiredPackages: [
					{
						depotFileSpec: "//Project/Main/Content/Maps/L_Example.*",
						packageName: "/Game/Maps/L_Example",
						role: "selected_map"
					}
				],
				claimsCompleteMapCoverage: false,
				claimsHistoricalClassCoverage: false,
				investigationTarget: {
					classPath: "/Script/Game.Npc",
					currentActorCount: 1,
					kind: "actor_class"
				},
				kind: "targeted"
			},
			mode: "fast",
			query: {
				...encoded.history.query,
				mode: "fast",
				target: { classPath: "/Script/Game.Npc", kind: "actor_class" }
			}
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
				mode: "deep",
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
		await screen.findByRole("combobox", { name: "Saved map" });
		expect(screen.queryByLabelText("Advanced scan limits")).toBeNull();
		await user.click(screen.getByRole("button", { name: "ADVANCED LIMITS" }));
		await user.clear(screen.getByLabelText("CHANGE LISTS"));
		await user.type(screen.getByLabelText("CHANGE LISTS"), "12");
		await user.click(screen.getByRole("button", { name: /read deep history/i }));
		expect(received?.mapPath).toBe("Content/Fixture/History/L_MapHistoryWorld.umap");
		expect(received?.limits.maxChangelists).toBe(12);
		expect(await screen.findByText("listing changes")).toBeDefined();
	});

	it("mounts one interactive map immediately and updates that map after history", async () => {
		const complete = completeState();
		const currentWorld = complete.history.rangeEndSnapshot!;
		const maps = complete.maps;
		const ready = Schema.decodeUnknownSync(ContentObservatoryState)({
			maps,
			projectRoot: "C:/Project",
			status: "ready" as const
		});
		const catalog = Schema.decodeUnknownSync(ContentObservatoryTargetCatalog)({
			authority: { kind: "project_files", mapPackage: currentWorld.mapPackage },
			completeness: currentWorld.completeness,
			contract: { name: "unreal-saved-world", version: { major: 1, minor: 0 } },
			diagnostics: currentWorld.diagnostics,
			mapPath: currentWorld.mapPath,
			actors: currentWorld.actors,
			sourceKind: currentWorld.sourceKind,
			summary: currentWorld.summary
		});
		const client: ContentObservatoryClientShape = {
			cancel: () => Effect.succeed(complete),
			start: () => Effect.succeed(complete),
			status: () => Effect.succeed(ready),
			targets: () => Effect.succeed(catalog)
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ContentObservatoryRoute client={client} />
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup();
		const pointMap = await screen.findByRole("application", {
			name: "Top-down saved actor points map"
		});

		expect(screen.getByRole("complementary", { name: "Saved actor outliner" })).toBeDefined();
		expect(screen.getByRole("complementary", { name: "Selected saved actor" })).toBeDefined();
		expect(
			screen.getAllByRole("application", { name: "Top-down saved actor points map" })
		).toHaveLength(1);
		expect(
			screen.getByRole("heading", { name: "CURRENT SAVED STATE point map" })
		).toBeDefined();

		await user.click(screen.getByRole("button", { name: /READ DEEP HISTORY/ }));
		await screen.findByRole("heading", { name: "AFTER CL 11 point map" });

		expect(screen.getByRole("application", { name: "Top-down saved actor points map" })).toBe(
			pointMap
		);
		expect(
			screen.getAllByRole("application", { name: "Top-down saved actor points map" })
		).toHaveLength(1);
	});

	it("keeps Deep History as the default and sends an explicit Fast actor target", async () => {
		let received: ContentObservatoryHistoryRequest | undefined;
		const maps = [
			{
				label: "Map History World",
				mapPath: "Content/Fixture/History/L_MapHistoryWorld.umap"
			}
		];
		const selectedMap = maps[0]!;
		const actor = {
			actorGuid: "actor-npc-1",
			actorPath: "/Game/Maps/L_MapHistoryWorld.L_MapHistoryWorld:PersistentLevel.Npc",
			classPath: "/Script/Game.Npc",
			label: "North NPC",
			packageName: "/Game/Maps/L_MapHistoryWorld",
			position: { location: { x: 10, y: 20, z: 0 }, status: "resolved" as const }
		};
		const ready = Schema.decodeUnknownSync(ContentObservatoryState)({
			maps,
			projectRoot: "C:/Project",
			status: "ready" as const
		});
		const catalog = Schema.decodeUnknownSync(ContentObservatoryTargetCatalog)({
			authority: { kind: "project_files", mapPackage: "/Game/Maps/L_MapHistoryWorld" },
			completeness: "complete",
			contract: { name: "unreal-saved-world", version: { major: 1, minor: 0 } },
			diagnostics: [],
			mapPath: selectedMap.mapPath,
			actors: [actor],
			sourceKind: "level",
			summary: {
				failedPackages: 0,
				partialPackages: 0,
				resolvedActors: 1,
				scannedPackages: 1
			}
		});
		const running = Schema.decodeUnknownSync(ContentObservatoryState)({
			jobId: "map-history-fast-1",
			maps,
			progress: {
				phase: "resolving_scope" as const,
				processedChangelists: 0,
				totalChangelists: 0
			},
			projectRoot: "C:/Project",
			request: {
				mode: "fast",
				limits: {
					maxChangelists: 250,
					maxConcurrency: 4,
					maxDurationMs: 120000,
					maxMaterializedFiles: 4000,
					maxPackages: 4000
				},
				mapPath: selectedMap.mapPath,
				range: { since: "2026-07-20T00:00:00.000Z", until: "2026-07-27T00:00:00.000Z" },
				target: {
					identity: { actorGuid: actor.actorGuid, kind: "actor_guid" },
					kind: "actor"
				}
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
			status: () => Effect.succeed(ready),
			targets: () => Effect.succeed(catalog)
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ContentObservatoryRoute client={client} />
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup();
		await screen.findByRole("combobox", { name: "Saved map" });
		expect(
			screen.getByRole("button", { name: "DEEP HISTORY" }).getAttribute("aria-pressed")
		).toBe("true");
		await user.click(screen.getByRole("button", { name: "FAST HISTORY" }));
		const targetExplorer = screen.getByRole("region", { name: "Fast History actor explorer" });
		await user.click(within(targetExplorer).getByRole("button", { name: /North NPC/ }));
		await user.click(screen.getByRole("button", { name: /READ FAST HISTORY/ }));
		expect(received?.mode).toBe("fast");
		expect(received?.mode).toBe("fast");
		if (received?.mode === "fast" && received.target.kind === "actor") {
			expect(received.target.identity).toEqual({
				actorGuid: actor.actorGuid,
				kind: "actor_guid"
			});
		}
	});

	it("sends an explicit Fast actor-class target", async () => {
		let received: ContentObservatoryHistoryRequest | undefined;
		const selectedMap = {
			label: "Map History World",
			mapPath: "Content/Fixture/History/L_MapHistoryWorld.umap"
		};
		const ready = Schema.decodeUnknownSync(ContentObservatoryState)({
			maps: [selectedMap],
			projectRoot: "C:/Project",
			status: "ready" as const
		});
		const catalog = Schema.decodeUnknownSync(ContentObservatoryTargetCatalog)({
			authority: { kind: "project_files", mapPackage: "/Game/Maps/L_MapHistoryWorld" },
			completeness: "complete",
			contract: { name: "unreal-saved-world", version: { major: 1, minor: 0 } },
			diagnostics: [],
			mapPath: selectedMap.mapPath,
			actors: [
				{
					actorGuid: "actor-npc-1",
					actorPath: "/Game/Maps/L_MapHistoryWorld.L_MapHistoryWorld:PersistentLevel.Npc",
					classPath: "/Script/Game.Npc",
					label: "North NPC",
					packageName: "/Game/Maps/L_MapHistoryWorld",
					position: { location: { x: 10, y: 20, z: 0 }, status: "resolved" as const }
				}
			],
			sourceKind: "level",
			summary: {
				failedPackages: 0,
				partialPackages: 0,
				resolvedActors: 1,
				scannedPackages: 1
			}
		});
		const client: ContentObservatoryClientShape = {
			cancel: () => Effect.succeed(ready),
			start: (request) => {
				received = request;
				return Effect.succeed(ready);
			},
			status: () => Effect.succeed(ready),
			targets: () => Effect.succeed(catalog)
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ContentObservatoryRoute client={client} />
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup();
		await screen.findByRole("combobox", { name: "Saved map" });
		await user.click(screen.getByRole("button", { name: "FAST HISTORY" }));
		await user.click(screen.getByRole("button", { name: "ACTOR CLASS" }));
		const targetExplorer = screen.getByRole("region", { name: "Fast History actor explorer" });
		await user.click(
			within(targetExplorer).getByRole("button", {
				name: "Toggle actor class filters"
			})
		);
		await user.click(
			within(within(targetExplorer).getByLabelText("Actor class filters")).getByRole(
				"button",
				{ name: /Npc/ }
			)
		);
		await user.click(screen.getByRole("button", { name: /READ FAST HISTORY/ }));
		expect(received?.mode).toBe("fast");
		if (received?.mode === "fast") {
			expect(received.target).toEqual({ classPath: "/Script/Game.Npc", kind: "actor_class" });
		}
	});

	it("preserves Fast coverage when decoding a completed actor-class result", async () => {
		const complete = fastCompleteState();
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
		await screen.findByRole("region", { name: "Fast History coverage" });
		expect(
			screen.getByText("This result follows 1 current actor of /Script/Game.Npc.")
		).toBeDefined();
		expect(
			screen.getByText(/Deleted or historically reclassified actors are outside this result/)
		).toBeDefined();
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
		expect(screen.getByRole("heading", { name: "Key lamp" })).toBeDefined();
		await user.click(screen.getByRole("tab", { name: "Changelists" }));
		expect(await screen.findByText("3 map actor changes")).toBeDefined();
		expect(screen.getByRole("button", { name: "Select changelist 11" })).toBeDefined();
		await user.click(screen.getByRole("tab", { name: "World state" }));

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
		await user.click(screen.getByRole("tab", { name: "Changelists" }));
		await user.click(
			screen.getByRole("button", { name: /added\s*key lamp\s*new saved actor/i })
		);

		expect(await screen.findByText("3 map actor changes")).toBeDefined();
		const evidence = screen.getByRole("complementary", {
			name: "Selected changelist evidence"
		});
		expect(within(evidence).getByRole("heading", { name: "CL 10" })).toBeDefined();
		await user.click(screen.getByRole("tab", { name: "World state" }));
		expect(screen.getByRole("heading", { name: "Key lamp" })).toBeDefined();
		expect(await screen.findByLabelText("Selected changelist map overlay")).toBeDefined();
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
		await user.click(screen.getByRole("tab", { name: "Changelists" }));
		await user.click(screen.getByRole("button", { name: "Select changelist 10" }));
		await user.click(screen.getByRole("tab", { name: "World state" }));
		const pointMap = await screen.findByRole("application", {
			name: "Top-down saved actor points map"
		});
		expect(screen.getByText("CL 10 DIFF OVERLAY")).toBeDefined();
		pointMap.focus();
		await user.keyboard("{ArrowRight}");

		expect(screen.getByText("CL 10 DIFF OVERLAY")).toBeDefined();
		await user.click(screen.getByRole("tab", { name: "Changelists" }));
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

		const evidence = await screen.findByRole("complementary", {
			name: "Selected changelist evidence"
		});
		expect(within(evidence).getByRole("heading", { name: "CL 10" })).toBeDefined();
		await user.click(screen.getByRole("tab", { name: "World state" }));
		expect(await screen.findByLabelText("Selected changelist map overlay")).toBeDefined();
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

		const mapPicker = screen.getByRole("combobox", { name: "Saved map" });
		await user.selectOptions(mapPicker, "__custom__");
		await user.clear(screen.getByRole("textbox", { name: "Custom map path" }));
		await user.type(
			screen.getByRole("textbox", { name: "Custom map path" }),
			"Content/Maps/L_Other.umap"
		);

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
