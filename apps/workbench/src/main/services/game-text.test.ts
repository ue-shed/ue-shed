import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorkbenchTestConfigurationLayer as makeWorkbenchConfigurationLayer } from "../test-configuration.js";
import { it } from "@effect/vitest";
import {
	makeTextCorpusServiceTestLayer,
	makeTextUnitId,
	TextCorpusScanError,
	TextQualityRuleId,
	TextQualityRuleDocument,
	TextRoleId
} from "@ue-shed/game-text";
import type { SavedAssetScan } from "@ue-shed/unreal-assets";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";
import { expect } from "vitest";
import { WorkbenchGameText, WorkbenchGameTextLive } from "./game-text.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { makeLocalFilesTestLayer } from "../adapters/local-files.js";

const gameTextAdapters = Layer.mergeAll(
	Layer.succeed(
		ElectronDialog,
		ElectronDialog.of({
			chooseDirectory: () => Effect.succeed({ status: "cancelled" }),
			chooseFile: () => Effect.succeed({ status: "cancelled" }),
			chooseFiles: () => Effect.succeed({ status: "cancelled" }),
			chooseSaveFile: () => Effect.succeed({ status: "cancelled" })
		})
	),
	makeLocalFilesTestLayer()
);
const gameTextLive = WorkbenchGameTextLive.pipe(Layer.provide(gameTextAdapters));

const qualityRulesPath = "C:/FixtureProject/game-text-quality.json";

function qualityGameTextLive(contents: string, files = new Map<string, Uint8Array>()) {
	files.set(qualityRulesPath, new TextEncoder().encode(contents));
	return WorkbenchGameTextLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(
					ElectronDialog,
					ElectronDialog.of({
						chooseDirectory: () => Effect.succeed({ status: "cancelled" }),
						chooseFile: () =>
							Effect.succeed({ path: qualityRulesPath, status: "selected" }),
						chooseFiles: () => Effect.succeed({ status: "cancelled" }),
						chooseSaveFile: () => Effect.succeed({ status: "cancelled" })
					})
				),
				makeLocalFilesTestLayer(files)
			)
		)
	);
}

const emptyCorpus = {
	coverage: {
		discoveredPackages: 0,
		failedPackages: 0,
		inspectedPackages: 0,
		partialPackages: 0,
		resolvedOccurrences: 0,
		textOccurrences: 0,
		textUnits: 0,
		unresolvedOccurrences: 0,
		unsupportedTextProperties: 0
	},
	diagnostics: [],
	schemaVersion: 1 as const,
	status: "complete" as const,
	units: []
};

const configuration = makeWorkbenchConfigurationLayer({
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "configured", projectRoot: "C:/FixtureProject" },
	remoteControlEndpoint: "http://127.0.0.1:30001",
	review: { status: "not_configured" },
	sourceCheckout: { status: "not_configured" },
	textureAuditRules: { status: "not_configured" }
});

const projectSummary = {
	inputAtlas: "ready" as const,
	mapCount: 0,
	packageCount: 0,
	projectName: "FixtureProject",
	projectRoot: "C:/FixtureProject"
};
const projectIndex: SavedAssetScan = {
	assets: [],
	failures: [],
	summary: {
		cacheHits: 0,
		depth: "header",
		diagnostics: [],
		emittedAssets: 0,
		failedAssets: 0,
		partialAssets: 0,
		projectRoot: "C:/FixtureProject",
		roots: ["C:/FixtureProject/Content"],
		scannedAssets: 0,
		schema_version: 8,
		skippedAssets: 0
	}
};
const selectedProject = makeWorkbenchProjectTestLayer({
	choose: () => Effect.succeed({ project: projectSummary, status: "ready" as const }),
	current: () => Effect.succeed({ project: projectSummary, status: "ready" as const }),
	inputAtlas: () => Effect.die("not used"),
	candidates: (kind) => {
		expect(kind).toBe("game_text");
		return Effect.succeed(projectIndex);
	},
	savedTables: () => Effect.die("savedTables is not used"),
	savedProject: () => Effect.succeed({ maps: [], projectRoot: "C:/FixtureProject" })
});
const unselectedProject = makeWorkbenchProjectTestLayer({
	choose: () => Effect.succeed({ status: "cancelled" as const }),
	current: () => Effect.succeed({ status: "not_configured" as const }),
	inputAtlas: () => Effect.die("not used"),
	savedTables: () => Effect.die("savedTables is not used"),
	savedProject: () => Effect.die("not used")
});

it.effect("reuses navigation results and refreshes only when requested", () =>
	Effect.gen(function* () {
		const scans = yield* Ref.make(0);
		yield* Effect.gen(function* () {
			const service = yield* WorkbenchGameText;
			expect((yield* service.configuredRefresh(false)).status).toBe("completed");
			expect((yield* service.configuredRefresh(false)).status).toBe("completed");
			expect(yield* Ref.get(scans)).toBe(1);
			expect((yield* service.configuredRefresh(true)).status).toBe("completed");
			expect(yield* Ref.get(scans)).toBe(2);
		}).pipe(
			Effect.provide(
				gameTextLive.pipe(
					Layer.provide(selectedProject),
					Layer.provide(
						makeTextCorpusServiceTestLayer({
							scan: () => Effect.die("unused"),
							scanFromProjectIndex: () =>
								Ref.update(scans, (value) => value + 1).pipe(Effect.as(emptyCorpus))
						})
					)
				)
			)
		);
	})
);

it.effect("an old project's scan cannot overwrite a newer project's result", () =>
	Effect.gen(function* () {
		const root = yield* Ref.make("C:/A");
		const started = yield* Deferred.make<void>();
		const release = yield* Deferred.make<void>();
		const current = () =>
			Ref.get(root).pipe(
				Effect.map((projectRoot) => ({
					status: "ready" as const,
					project: { ...projectSummary, projectRoot }
				}))
			);
		const project = makeWorkbenchProjectTestLayer({
			current,
			choose: current,
			candidates: () =>
				Ref.get(root).pipe(
					Effect.map((projectRoot) => ({
						...projectIndex,
						summary: { ...projectIndex.summary, projectRoot }
					}))
				),
			inputAtlas: () => Effect.die("unused"),
			savedProject: () => Effect.die("unused"),
			savedTables: () => Effect.die("unused")
		});
		const corpus = makeTextCorpusServiceTestLayer({
			scan: () => Effect.die("unused"),
			scanFromProjectIndex: (index) =>
				(index.summary.projectRoot === "C:/A"
					? Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Deferred.await(release))
						)
					: Effect.void
				).pipe(Effect.as(emptyCorpus))
		});
		yield* Effect.gen(function* () {
			const service = yield* WorkbenchGameText;
			const first = yield* Effect.forkChild(service.configuredRefresh(false));
			yield* Deferred.await(started);
			yield* Ref.set(root, "C:/B");
			expect((yield* service.configuredRefresh(false)).status).toBe("completed");
			yield* Deferred.succeed(release, undefined);
			expect((yield* Fiber.join(first)).status).toBe("failed");
			expect(
				(yield* service.search({ query: "", pageSize: 50, capability: "all", lens: "all" }))
					.status
			).toBe("ready");
		}).pipe(Effect.provide(gameTextLive.pipe(Layer.provide(project), Layer.provide(corpus))));
	})
);

it.effect("returns not_configured without a project root", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchGameText;
		const result = yield* service.configuredScan();
		expect(result).toEqual({ status: "not_configured" });
	}).pipe(
		Effect.provide(
			gameTextLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer({
							authoringAsset: { status: "not_configured" },
							expectedProject: { status: "not_configured" },
							project: { status: "not_configured" },
							remoteControlEndpoint: "http://127.0.0.1:30001",
							review: { status: "not_configured" },
							sourceCheckout: { status: "not_configured" },
							textureAuditRules: { status: "not_configured" }
						}),
						makeTextCorpusServiceTestLayer({ scan: () => Effect.die("not used") }),
						unselectedProject
					)
				)
			)
		)
	)
);

const qualityRoleId = TextRoleId.make("menu.prompt");
const qualityRuleId = TextQualityRuleId.make("menu.prompt.characters");
const validQualityDocument = TextQualityRuleDocument.make({
	roles: [
		{
			id: qualityRoleId,
			scopes: [{ matchers: [{ kind: "location_kind", value: "string_table_entry" }] }]
		}
	],
	rules: [
		{
			id: qualityRuleId,
			kind: "character_budget",
			maximumCharacters: 32,
			recovery: "Shorten the prompt.",
			role: qualityRoleId
		}
	],
	schemaVersion: 1
});

it.effect("scans the configured project", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchGameText;
		const result = yield* service.configuredScan();
		expect(result).toEqual({ corpus: emptyCorpus, status: "completed" });
	}).pipe(
		Effect.provide(
			gameTextLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						configuration,
						makeTextCorpusServiceTestLayer({
							scan: () => Effect.die("full project scan is not used"),
							scanFromProjectIndex: () => Effect.succeed(emptyCorpus)
						}),
						selectedProject
					)
				)
			)
		)
	)
);

it.effect("keeps refreshed corpus data in main and serves bounded query results", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchGameText;
		const refreshed = yield* service.configuredRefresh();
		expect(refreshed).toEqual({
			status: "completed",
			summary: {
				coverage: emptyCorpus.coverage,
				diagnosticCount: 0,
				review: {
					all: 0,
					conflicting: 0,
					duplicateSource: 0,
					long: 0,
					shared: 0,
					unresolved: 0
				},
				schemaVersion: 1,
				sources: { assetProperty: 0, dataTable: 0, mixed: 0, stringTable: 0 },
				status: "complete"
			}
		});
		expect(yield* service.search({ capability: "all", pageSize: 50, query: "" })).toEqual({
			page: { total: 0, units: [] },
			status: "ready"
		});
		expect(
			yield* service.focus({ id: makeTextUnitId("unreal:UI:Missing"), pageSize: 50 })
		).toEqual({
			status: "not_found"
		});
	}).pipe(
		Effect.provide(
			gameTextLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						configuration,
						makeTextCorpusServiceTestLayer({
							scan: () => Effect.die("full project scan is not used"),
							scanFromProjectIndex: () => Effect.succeed(emptyCorpus)
						}),
						selectedProject
					)
				)
			)
		)
	)
);

it.effect("translates a typed scan failure into the failed result variant", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchGameText;
		const result = yield* service.configuredScan();
		expect(result).toEqual({
			error: {
				code: "invalid_project",
				message: "boom",
				recovery: "retry",
				retrySafe: false
			},
			status: "failed"
		});
	}).pipe(
		Effect.provide(
			gameTextLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						configuration,
						makeTextCorpusServiceTestLayer({
							scan: () => Effect.die("full project scan is not used"),
							scanFromProjectIndex: () =>
								Effect.fail(
									new TextCorpusScanError({
										code: "invalid_project",
										message: "boom",
										recovery: "retry",
										retrySafe: false
									})
								)
						}),
						selectedProject
					)
				)
			)
		)
	)
);

it.effect("uses the globally selected project when scanning", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchGameText;
		const result = yield* service.chooseAndScan();
		expect(result).toEqual({ corpus: emptyCorpus, status: "completed" });
	}).pipe(
		Effect.provide(
			gameTextLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						configuration,
						makeTextCorpusServiceTestLayer({
							scan: () => Effect.die("full project scan is not used"),
							scanFromProjectIndex: () => Effect.succeed(emptyCorpus)
						}),
						selectedProject
					)
				)
			)
		)
	)
);

it.effect("cancels choose-and-scan when global project selection is cancelled", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchGameText;
		const result = yield* service.chooseAndScan();
		expect(result).toEqual({ status: "cancelled" });
	}).pipe(
		Effect.provide(
			gameTextLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						configuration,
						makeTextCorpusServiceTestLayer({ scan: () => Effect.die("not used") }),
						unselectedProject
					)
				)
			)
		)
	)
);

it.effect(
	"returns typed actionable rule failures without replacing the retained corpus query",
	() =>
		Effect.gen(function* () {
			const service = yield* WorkbenchGameText;
			expect(yield* service.chooseQualityRules()).toEqual({ status: "not_ready" });
			expect((yield* service.configuredRefresh()).status).toBe("completed");
			const reviewed = yield* service.chooseQualityRules();
			expect(reviewed).toEqual({
				error: {
					code: "invalid_rules",
					message: "The Game Text quality rule file is not valid JSON.",
					recovery: "Correct the JSON syntax and retry with a version-1 rule document.",
					retrySafe: true
				},
				status: "failed"
			});
			expect(yield* service.search({ capability: "all", pageSize: 50, query: "" })).toEqual({
				page: { total: 0, units: [] },
				status: "ready"
			});
			expect(yield* service.qualitySearch({ filter: "all", pageSize: 50 })).toEqual({
				status: "not_ready"
			});
		}).pipe(
			Effect.provide(
				qualityGameTextLive("{secret-authored-term").pipe(
					Layer.provide(
						Layer.mergeAll(
							configuration,
							makeTextCorpusServiceTestLayer({
								scan: () => Effect.die("full project scan is not used"),
								scanFromProjectIndex: () => Effect.succeed(emptyCorpus)
							}),
							selectedProject
						)
					)
				)
			)
		)
);

it.effect(
	"previews validated rule edits, rejects invalid drafts, and saves the active file",
	() => {
		const files = new Map<string, Uint8Array>();
		const revisedDocument = TextQualityRuleDocument.make({
			roles: [
				{
					id: qualityRoleId,
					scopes: [{ matchers: [{ kind: "location_kind", value: "string_table_entry" }] }]
				}
			],
			rules: [
				{
					id: qualityRuleId,
					kind: "character_budget",
					maximumCharacters: 64,
					recovery: "Shorten the prompt.",
					role: qualityRoleId
				}
			],
			schemaVersion: 1
		});
		const invalidDocument = TextQualityRuleDocument.make({
			roles: [
				{
					id: qualityRoleId,
					scopes: [{ matchers: [{ kind: "location_kind", value: "string_table_entry" }] }]
				},
				{
					id: qualityRoleId,
					scopes: [{ matchers: [{ kind: "location_kind", value: "string_table_entry" }] }]
				}
			],
			rules: revisedDocument.rules,
			schemaVersion: 1
		});
		return Effect.gen(function* () {
			const service = yield* WorkbenchGameText;
			expect((yield* service.configuredRefresh()).status).toBe("completed");
			const loaded = yield* service.chooseQualityRules();
			expect(loaded.status).toBe("completed");
			if (loaded.status !== "completed") return;
			expect(loaded.document).toEqual(validQualityDocument);

			const previewed = yield* service.previewQualityRules(revisedDocument);
			expect(previewed.status).toBe("completed");
			const invalid = yield* service.previewQualityRules(invalidDocument);
			expect(invalid).toMatchObject({
				error: { code: "invalid_rules" },
				status: "failed"
			});
			expect((yield* service.qualitySearch({ filter: "all", pageSize: 50 })).status).toBe(
				"ready"
			);

			const saved = yield* service.saveQualityRules(revisedDocument);
			expect(saved.status).toBe("completed");
			const persisted = files.get(qualityRulesPath);
			expect(persisted).toBeDefined();
			expect(new TextDecoder().decode(persisted)).toContain('"maximumCharacters": 64');
		}).pipe(
			Effect.provide(
				qualityGameTextLive(JSON.stringify(validQualityDocument), files).pipe(
					Layer.provide(
						Layer.mergeAll(
							configuration,
							makeTextCorpusServiceTestLayer({
								scan: () => Effect.die("full project scan is not used"),
								scanFromProjectIndex: () => Effect.succeed(emptyCorpus)
							}),
							selectedProject
						)
					)
				)
			)
		);
	}
);

it("exports one captured generation when the project changes during the save dialog", async () => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-export-snapshot-"));
	const path = join(root, "export.json");
	let activeRoot = projectSummary.projectRoot;
	let dialogs = 0;
	try {
		const current = () =>
			Effect.sync(() => ({
				status: "ready" as const,
				project: { ...projectSummary, projectRoot: activeRoot, generation: 7 }
			}));
		const project = makeWorkbenchProjectTestLayer({
			current,
			choose: current,
			candidates: () => Effect.succeed(projectIndex),
			inputAtlas: () => Effect.die("unused"),
			savedTables: () => Effect.die("unused"),
			savedProject: () => Effect.die("unused")
		});
		const dialog = Layer.succeed(
			ElectronDialog,
			ElectronDialog.of({
				chooseDirectory: () => Effect.succeed({ status: "cancelled" }),
				chooseFile: () => Effect.succeed({ status: "cancelled" }),
				chooseFiles: () => Effect.succeed({ status: "cancelled" }),
				chooseSaveFile: () =>
					Effect.sync(() => {
						dialogs++;
						activeRoot = "C:/AnotherProject";
						return { status: "selected" as const, path };
					})
			})
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* WorkbenchGameText;
				expect((yield* service.configuredRefresh(false)).status).toBe("completed");
				const query = {
					mode: "corpus" as const,
					query: "",
					capability: "all" as const,
					lens: "all" as const,
					qualityFilter: "all" as const
				};
				expect(yield* service.investigationExport(query, "json")).toMatchObject({
					status: "saved",
					rowCount: 0,
					path
				});
				expect(yield* service.investigationExport(query, "json")).toMatchObject({
					status: "failed"
				});
			}).pipe(
				Effect.provide(
					WorkbenchGameTextLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								project,
								dialog,
								makeLocalFilesTestLayer(),
								makeTextCorpusServiceTestLayer({
									scan: () => Effect.die("unused"),
									scanFromProjectIndex: () => Effect.succeed(emptyCorpus)
								})
							)
						)
					)
				)
			)
		);
		expect(dialogs).toBe(1);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			source: { projectRoot: projectSummary.projectRoot, generation: 7 },
			result: { mode: "corpus", corpus: { units: [] } }
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("restores embedded rules without retaining another rule file's write destination", async () => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-preset-rules-"));
	const presetPath = join(root, "preset.json");
	const outputPath = join(root, "export.json");
	let openPath = qualityRulesPath;
	const original = JSON.stringify(validQualityDocument);
	const files = new Map([[qualityRulesPath, new TextEncoder().encode(original)]]);
	const query = {
		mode: "corpus" as const,
		query: "",
		capability: "all" as const,
		lens: "all" as const,
		qualityFilter: "all" as const
	};
	const preset = {
		schemaVersion: 1,
		kind: "game_text",
		sort: "domain_order",
		query,
		rules: validQualityDocument
	};
	try {
		await writeFile(presetPath, JSON.stringify(preset));
		const dialog = Layer.succeed(
			ElectronDialog,
			ElectronDialog.of({
				chooseDirectory: () => Effect.succeed({ status: "cancelled" }),
				chooseFiles: () => Effect.succeed({ status: "cancelled" }),
				chooseFile: () =>
					Effect.sync(() => ({ status: "selected" as const, path: openPath })),
				chooseSaveFile: () => Effect.succeed({ status: "selected", path: outputPath })
			})
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* WorkbenchGameText;
				expect((yield* service.configuredRefresh(false)).status).toBe("completed");
				expect((yield* service.chooseQualityRules()).status).toBe("completed");
				openPath = presetPath;
				expect((yield* service.investigationOpen()).status).toBe("opened");
				expect(yield* service.saveQualityRules(validQualityDocument)).toMatchObject({
					status: "failed",
					error: { code: "write_failed" }
				});
				expect(new TextDecoder().decode(files.get(qualityRulesPath))).toBe(original);
				const { rules: _rules, ...withoutRules } = preset;
				yield* Effect.promise(() => writeFile(presetPath, JSON.stringify(withoutRules)));
				expect((yield* service.investigationOpen()).status).toBe("opened");
				expect(yield* service.qualitySearch({ filter: "all", pageSize: 50 })).toEqual({
					status: "not_ready"
				});
				expect((yield* service.investigationExport(query, "json")).status).toBe("saved");
			}).pipe(
				Effect.provide(
					WorkbenchGameTextLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								selectedProject,
								dialog,
								makeLocalFilesTestLayer(files),
								makeTextCorpusServiceTestLayer({
									scan: () => Effect.die("unused"),
									scanFromProjectIndex: () => Effect.succeed(emptyCorpus)
								})
							)
						)
					)
				)
			)
		);
		expect(JSON.parse(await readFile(outputPath, "utf8")).preset.rules).toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
