import { it } from "@effect/vitest";
import {
	GameTextIndexError,
	GameTextIndexSteps,
	makeTextCorpusServiceTestLayer,
	SnapshotStoreError,
	TextCorpusScanError,
	type IndexFailure
} from "@ue-shed/game-text/index";
import {
	GAME_TEXT_RULES_RELATIVE_PATH,
	GameTextRuleDocument,
	STARTER_CHECK_RULES,
	STARTER_GAME_TEXT_RULES
} from "@ue-shed/game-text/rules";
import {
	makeTextOccurrenceId,
	makeTextUnitId,
	TextQualityRuleId,
	TextRoleId,
	TextUnit
} from "@ue-shed/game-text/schema";
import { makeLocalizationEvidenceTestLayer } from "@ue-shed/localization";
import { AssetReaderError, type SavedAssetScan } from "@ue-shed/unreal-assets";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { LocalFilesLive, makeLocalFilesTestLayer } from "../adapters/local-files.js";
import { makeWorkbenchTestConfigurationLayer as makeWorkbenchConfigurationLayer } from "../test-configuration.js";
import {
	oracleGameTextIndexLayer,
	workbenchGameTextIndexOracleLayer
} from "./game-text-index.test-support.js";
import {
	cultureCode,
	corpus as localizationCorpus,
	evidence as localizationEvidence,
	target as localizationTarget,
	unit as localizationUnit,
	poDocument
} from "./game-text-localization.test-support.js";
import {
	WorkbenchGameTextLive as indexedWorkbenchGameTextLive,
	WorkbenchGameText
} from "./game-text.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";

const WorkbenchGameTextLive = indexedWorkbenchGameTextLive.pipe(
	Layer.provide(workbenchGameTextIndexOracleLayer)
);

const noLocalization = makeLocalizationEvidenceTestLayer({
	discover: () => Effect.succeed({ schemaVersion: 1, targets: [], diagnostics: [] }),
	read: () => Effect.die("No targets"),
	targets: () => Effect.die("Not used")
});

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
const gameTextLive = WorkbenchGameTextLive.pipe(
	Layer.provide(noLocalization),
	Layer.provide(gameTextAdapters)
);

const qualityRulesPath = "C:/FixtureProject/game-text-quality.json";

function qualityGameTextLive(contents: string, files = new Map<string, Uint8Array>()) {
	files.set(qualityRulesPath, new TextEncoder().encode(contents));
	return WorkbenchGameTextLive.pipe(
		Layer.provide(noLocalization),
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
const projectIndex: SavedAssetScan & { readonly generation: number } = {
	generation: 0,
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
const noProblems = {
	key_changed: 0,
	conflicting_source: 0,
	not_gathered: 0,
	changed_since_gather: 0,
	translation: 0,
	finding: 0,
	unchecked: 0,
	up_to_date: 0
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

it.effect(
	"scans and Unreal operations exclude each other while retained reads remain available",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const finish = yield* Deferred.make<void>();
			const scans = yield* Ref.make(0);
			yield* Effect.gen(function* () {
				const service = yield* WorkbenchGameText;
				const scan = yield* service.configuredRefresh(true).pipe(Effect.forkChild);
				yield* Deferred.await(started);
				expect(yield* service.beginOperation()).toBe(false);
				expect(yield* service.operationBusyReason()).toContain("scan");
				yield* Deferred.succeed(finish, undefined);
				expect((yield* Fiber.join(scan)).status).toBe("completed");
				expect(yield* service.beginOperation()).toBe(true);
				expect(yield* service.beginOperation()).toBe(false);
				expect((yield* service.configuredRefresh(false)).status).toBe("completed");
				expect((yield* service.configuredRefresh(true)).status).toBe("failed");
				expect((yield* service.configuredScan()).status).toBe("failed");
				expect(yield* service.saveQualityRules(STARTER_GAME_TEXT_RULES)).toMatchObject({
					status: "failed",
					error: { code: "write_failed" }
				});
				expect(yield* service.createStarterRules(false)).toMatchObject({
					status: "failed",
					error: { code: "write_failed" }
				});
				expect(yield* Ref.get(scans)).toBe(1);
				yield* service.endOperation();
				expect(yield* service.operationBusyReason()).toBeUndefined();
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
									Effect.gen(function* () {
										yield* Ref.update(scans, (count) => count + 1);
										yield* Deferred.succeed(started, undefined);
										yield* Deferred.await(finish);
										return emptyCorpus;
									})
							})
						)
					)
				)
			);
		})
);

function splitUnit(): TextUnit {
	const table = localizationUnit();
	const occurrence = table.occurrences[0];
	if (!occurrence) throw new Error("Missing saved occurrence.");
	const identity = { status: "resolved" as const, namespace: "UI [Beta]", key: "K" };
	return TextUnit.make({
		...table,
		identity,
		source: { status: "conflicting", values: ["Base label", "Table label"] },
		occurrences: [
			{ ...occurrence, identity, source: "Table label" },
			{
				...occurrence,
				id: makeTextOccurrenceId("occurrence:base"),
				identity,
				source: "Base label",
				packageFile: "Content/Text/Base.uasset",
				location: {
					kind: "asset_property",
					objectPath: "/Game/Text/Base.Base",
					classPath: "/Script/Engine.DataAsset",
					propertyPath: "Label"
				}
			}
		]
	});
}

it.effect("passes localization corpus focus through the selected target's query", () =>
	Effect.gen(function* () {
		const saved = splitUnit();
		const service = yield* WorkbenchGameText;
		yield* service.configuredRefresh();
		yield* service.localizationTarget(localizationTarget.name);
		const result = yield* service.search({
			capability: "all",
			query: "",
			pageSize: 50,
			localization: { target: localizationTarget.name }
		});
		if (result.status !== "ready") throw new Error("Missing search results.");
		const lines =
			result.page.localization?.lines.filter((line) => line.origin.kind === "corpus") ?? [];
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			const focused = yield* service.focus({
				id: saved.id,
				localization: { target: localizationTarget.name, id: line.id },
				pageSize: 50
			});
			const occurrence = saved.occurrences.find((occurrence) =>
				line.identity?.namespace === "UI"
					? occurrence.location.kind === "asset_property"
					: occurrence.location.kind === "string_table_entry"
			);
			expect(focused).toMatchObject({
				status: "found",
				focus: {
					unit: {
						id: saved.id,
						source: { status: "consistent", value: occurrence?.source }
					},
					occurrences: [occurrence],
					totalOccurrences: 1
				}
			});
		}
		expect(yield* service.focus({ id: saved.id, pageSize: 50 })).toMatchObject({
			status: "found",
			focus: { unit: { source: saved.source }, occurrences: saved.occurrences }
		});
	}).pipe(
		Effect.provide(
			WorkbenchGameTextLive.pipe(
				Layer.provide(gameTextAdapters),
				Layer.provide(selectedProject),
				Layer.provide(
					makeLocalizationEvidenceTestLayer({
						discover: () =>
							Effect.succeed({
								schemaVersion: 1,
								targets: [localizationTarget],
								diagnostics: []
							}),
						read: () => Effect.succeed(localizationEvidence()),
						targets: () => Effect.die("unused")
					})
				),
				Layer.provide(
					makeTextCorpusServiceTestLayer({
						scan: () => Effect.die("unused"),
						scanFromProjectIndex: () =>
							Effect.succeed(localizationCorpus([splitUnit()]))
					})
				)
			)
		)
	)
);

it.effect("operation refresh reloads evidence and gathers also rescan the retained corpus", () =>
	Effect.gen(function* () {
		const reads = yield* Ref.make(0);
		const scans = yield* Ref.make(0);
		let translation = "Pending";
		const reader = makeLocalizationEvidenceTestLayer({
			discover: () =>
				Effect.succeed({
					schemaVersion: 1,
					targets: [localizationTarget],
					diagnostics: []
				}),
			read: () =>
				Ref.updateAndGet(reads, (count) => count + 1).pipe(
					Effect.map(() => localizationEvidence(poDocument(translation)))
				),
			targets: () => Effect.die("unused")
		});
		yield* Effect.gen(function* () {
			const service = yield* WorkbenchGameText;
			yield* service.configuredRefresh(true);
			expect(yield* service.localizationTarget(localizationTarget.name)).toMatchObject({
				notSynced: 2
			});
			expect(yield* service.beginOperation()).toBe(true);
			translation = "Translation";
			expect(yield* service.refreshAfterOperation(localizationTarget.name, false)).toBe(true);
			expect(yield* service.localizationTarget(localizationTarget.name)).toMatchObject({
				notSynced: 0
			});
			// Selection borrows the published model; the explicit operation refresh reads again.
			expect(yield* Ref.get(reads)).toBe(2);
			expect(yield* Ref.get(scans)).toBe(1);
			expect(yield* service.refreshAfterOperation(localizationTarget.name, true)).toBe(true);
			expect(yield* Ref.get(reads)).toBe(4);
			expect(yield* Ref.get(scans)).toBe(2);
			yield* service.endOperation();
		}).pipe(
			Effect.provide(
				WorkbenchGameTextLive.pipe(
					Layer.provide(gameTextAdapters),
					Layer.provide(selectedProject),
					Layer.provide(reader),
					Layer.provide(
						makeTextCorpusServiceTestLayer({
							scan: () => Effect.die("unused"),
							scanFromProjectIndex: () =>
								Ref.update(scans, (count) => count + 1).pipe(
									Effect.as(localizationCorpus())
								)
						})
					)
				)
			)
		);
	})
);

it.effect(
	"reloads localization evidence on Rescan and leaves no-target projects on the source query",
	() =>
		Effect.gen(function* () {
			let reads = 0;
			let available = true;
			let translation = "Pending";
			const reader = makeLocalizationEvidenceTestLayer({
				discover: () =>
					Effect.succeed({
						schemaVersion: 1,
						targets: available ? [localizationTarget] : [],
						diagnostics: []
					}),
				read: ({ projectRoot }) =>
					Effect.sync(() => {
						expect(projectRoot).toBe(projectSummary.projectRoot);
						reads++;
						return localizationEvidence(poDocument(translation));
					}),
				targets: () => Effect.die("Not used")
			});
			yield* Effect.gen(function* () {
				const service = yield* WorkbenchGameText;
				expect(yield* service.localizationTargets()).toEqual({ status: "not_ready" });
				yield* service.configuredRefresh(true);
				expect(yield* service.localizationTargets()).toMatchObject({
					status: "ready",
					targets: [{ name: localizationTarget.name }]
				});
				expect(yield* service.localizationTarget(localizationTarget.name)).toMatchObject({
					status: "ready",
					notSynced: 2
				});
				yield* service.configuredRefresh(false);
				yield* service.localizationTarget(localizationTarget.name);
				expect(reads).toBe(1);
				translation = "Translation";
				yield* service.configuredRefresh(true);
				expect(yield* service.localizationTarget(localizationTarget.name)).toMatchObject({
					status: "ready",
					notSynced: 0
				});
				expect(reads).toBe(2);
				available = false;
				yield* service.configuredRefresh(true);
				expect(yield* service.localizationTargets()).toEqual({
					status: "ready",
					targets: []
				});
				expect(
					yield* service.search({ query: "Source", capability: "all", pageSize: 50 })
				).toMatchObject({
					status: "ready",
					page: { total: 1 }
				});
				expect(reads).toBe(2);
			}).pipe(
				Effect.provide(
					WorkbenchGameTextLive.pipe(
						Layer.provide(gameTextAdapters),
						Layer.provide(selectedProject),
						Layer.provide(reader),
						Layer.provide(
							makeTextCorpusServiceTestLayer({
								scan: () => Effect.die("Not used"),
								scanFromProjectIndex: () => Effect.sync(() => localizationCorpus())
							})
						)
					)
				)
			);
		})
);

it.effect("reuses navigation results and refreshes only when requested", () =>
	Effect.gen(function* () {
		const scans = yield* Ref.make(0);
		yield* Effect.gen(function* () {
			const service = yield* WorkbenchGameText;
			expect((yield* service.configuredRefresh(false)).status).toBe("not_scanned");
			expect(yield* Ref.get(scans)).toBe(0);
			expect((yield* service.configuredRefresh(true)).status).toBe("completed");
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

it("creates starter rules exclusively, reloads the file and retains it through rescans", async () => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-starter-rules-"));
	const path = join(root, GAME_TEXT_RULES_RELATIVE_PATH);
	const current = () =>
		Effect.succeed({
			status: "ready" as const,
			project: { ...projectSummary, projectRoot: root }
		});
	const project = makeWorkbenchProjectTestLayer({
		current,
		choose: current,
		refresh: current,
		candidates: () =>
			Effect.succeed({
				...projectIndex,
				summary: { ...projectIndex.summary, projectRoot: root }
			}),
		inputAtlas: () => Effect.die("unused"),
		savedTables: () => Effect.die("unused"),
		savedProject: () => Effect.die("unused")
	});
	const live = WorkbenchGameTextLive.pipe(
		Layer.provide(noLocalization),
		Layer.provide(
			Layer.mergeAll(
				project,
				LocalFilesLive,
				Layer.succeed(
					ElectronDialog,
					ElectronDialog.of({
						chooseDirectory: () => Effect.succeed({ status: "cancelled" }),
						chooseFile: () => Effect.die("Reload must use the retained file"),
						chooseFiles: () => Effect.succeed({ status: "cancelled" }),
						chooseSaveFile: () => Effect.succeed({ status: "cancelled" })
					})
				),
				makeTextCorpusServiceTestLayer({
					scan: () => Effect.die("unused"),
					scanFromProjectIndex: () => Effect.succeed(emptyCorpus)
				})
			)
		)
	);
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* WorkbenchGameText;
				expect(yield* service.createStarterRules(false)).toEqual({ status: "not_ready" });
				expect((yield* service.configuredRefresh(true)).status).toBe("completed");
				expect(yield* service.createStarterRules(false)).toMatchObject({
					status: "completed",
					document: STARTER_GAME_TEXT_RULES
				});
				const original = yield* Effect.promise(() => readFile(path, "utf8"));
				expect(yield* service.createStarterRules(false)).toMatchObject({
					status: "failed",
					error: { code: "already_exists", retrySafe: true }
				});
				expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(original);
				expect((yield* service.createStarterRules(true)).status).toBe("completed");
				const revised = {
					...STARTER_GAME_TEXT_RULES,
					rules: STARTER_GAME_TEXT_RULES.rules.map((rule) =>
						rule.kind === "character_budget" ? { ...rule, maximumCharacters: 9 } : rule
					)
				};
				yield* Effect.promise(() => writeFile(path, JSON.stringify(revised)));
				expect(yield* service.reloadQualityRules()).toMatchObject({
					status: "completed",
					document: revised
				});
				expect((yield* service.configuredRefresh(true)).status).toBe("completed");
				expect((yield* service.qualitySearch({ filter: "all", pageSize: 50 })).status).toBe(
					"ready"
				);
				expect((yield* service.saveQualityRules(revised)).status).toBe("completed");
				expect(JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")))).toEqual(
					revised
				);
				yield* Effect.promise(() => writeFile(path, "{"));
				expect(yield* service.reloadQualityRules()).toMatchObject({
					status: "failed",
					error: { code: "invalid_rules" }
				});
				expect(yield* service.createStarterRules(true)).toMatchObject({
					status: "failed",
					error: { code: "invalid_rules" }
				});
			}).pipe(Effect.provide(live))
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

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
			const first = yield* Effect.forkChild(service.configuredRefresh(true));
			yield* Deferred.await(started);
			yield* Ref.set(root, "C:/B");
			expect((yield* service.configuredRefresh(true)).status).toBe("completed");
			yield* Deferred.succeed(release, undefined);
			expect((yield* Fiber.join(first)).status).toBe("failed");
			expect(
				(yield* service.search({ query: "", pageSize: 50, capability: "all", lens: "all" }))
					.status
			).toBe("ready");
		}).pipe(Effect.provide(gameTextLive.pipe(Layer.provide(project), Layer.provide(corpus))));
	})
);

for (const phase of ["candidates", "scan"] as const) {
	it.effect(
		`rejects a same-project generation change during ${phase} and retries with fresh membership`,
		() =>
			Effect.gen(function* () {
				const generation = yield* Ref.make(1);
				const started = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const pause = Deferred.succeed(started, undefined).pipe(
					Effect.andThen(Deferred.await(release))
				);
				const current = () =>
					Ref.get(generation).pipe(
						Effect.map((generation) => ({
							status: "ready" as const,
							project: { ...projectSummary, generation }
						}))
					);
				const project = makeWorkbenchProjectTestLayer({
					current,
					choose: current,
					candidates: () =>
						Effect.gen(function* () {
							const captured = yield* Ref.get(generation);
							if (phase === "candidates" && captured === 1) yield* pause;
							return { ...projectIndex, generation: captured };
						}),
					inputAtlas: () => Effect.die("unused"),
					savedProject: () => Effect.die("unused"),
					savedTables: () => Effect.die("unused")
				});
				const scanner = makeTextCorpusServiceTestLayer({
					scan: () => Effect.die("unused"),
					scanFromProjectIndex: () =>
						Effect.gen(function* () {
							if (phase === "scan" && (yield* Ref.get(generation)) === 1)
								yield* pause;
							return emptyCorpus;
						})
				});
				yield* Effect.gen(function* () {
					const service = yield* WorkbenchGameText;
					const first = yield* Effect.forkChild(service.configuredRefresh(true));
					yield* Deferred.await(started);
					yield* Ref.set(generation, 2);
					yield* Deferred.succeed(release, undefined);
					expect((yield* Fiber.join(first)).status).toBe("failed");
					expect(
						(yield* service.search({
							query: "",
							pageSize: 50,
							capability: "all",
							lens: "all"
						})).status
					).not.toBe("ready");
					expect(
						(yield* service.investigationExport(
							{
								mode: "corpus",
								query: "",
								capability: "all",
								lens: "all",
								qualityFilter: "all"
							},
							"json"
						)).status
					).toBe("failed");
					expect((yield* service.configuredRefresh(true)).status).toBe("completed");
					expect(
						(yield* service.search({
							query: "",
							pageSize: 50,
							capability: "all",
							lens: "all"
						})).status
					).toBe("ready");
				}).pipe(
					Effect.provide(
						gameTextLive.pipe(Layer.provide(Layer.mergeAll(project, scanner)))
					)
				);
			})
	);
}

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
const validQualityDocument = GameTextRuleDocument.make({
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

for (const code of ["reader_failed"] as const) {
	for (const operation of ["configuredScan", "configuredRefresh"] as const) {
		it.effect(`preserves ${code} in ${operation} failures`, () =>
			Effect.gen(function* () {
				const service = yield* WorkbenchGameText;
				const result = yield* service[operation]();
				expect(result).toEqual({
					error: {
						code,
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
												nextStep: "fix_input",
												code,
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
	}
}

it.effect(
	"returns typed actionable rule failures without replacing the retained corpus query",
	() =>
		Effect.gen(function* () {
			const service = yield* WorkbenchGameText;
			expect(yield* service.chooseQualityRules()).toEqual({ status: "not_ready" });
			const refreshed = yield* service.configuredRefresh();
			expect(refreshed).toMatchObject({
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

			expect(
				yield* service.focus({ id: makeTextUnitId("unreal:UI:Missing"), pageSize: 50 })
			).toEqual({
				status: "not_found"
			});
			const reviewed = yield* service.chooseQualityRules();
			expect(reviewed).toEqual({
				error: {
					code: "invalid_rules",
					message: "The Game Text rule file is not valid JSON.",
					recovery: "Correct the JSON syntax and retry with a version-1 rule file.",
					retrySafe: true
				},
				status: "failed"
			});
			expect(yield* service.search({ capability: "all", pageSize: 50, query: "" })).toEqual({
				page: {
					total: 0,
					units: [],
					counts: {
						all: 0,
						shared: 0,
						duplicate_source: 0,
						long: 0,
						unresolved: 0,
						conflicting: 0,
						editable: 0,
						readOnly: 0,
						withoutNotes: 0,
						origins: {
							string_table: 0,
							data_table: 0,
							asset: 0,
							cpp: 0,
							other_source: 0
						}
					},
					problems: noProblems
				},
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
		const revisedDocument = GameTextRuleDocument.make({
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
		const invalidDocument = GameTextRuleDocument.make({
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
			// The renderer learns that Save has a destination, but never the destination's path.
			expect(loaded.ruleFile).toBe("attached");
			expect(JSON.stringify(loaded)).not.toContain(qualityRulesPath);

			const previewed = yield* service.previewQualityRules(revisedDocument);
			expect(previewed).toMatchObject({ status: "completed", ruleFile: "attached" });
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
			candidates: () => Effect.succeed({ ...projectIndex, generation: 7 }),
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
				expect((yield* service.configuredRefresh(true)).status).toBe("completed");
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
						Layer.provide(noLocalization),
						Layer.provide(
							Layer.mergeAll(
								project,
								dialog,
								// Exports go through the host file hooks; this test reads them from disk.
								LocalFilesLive,
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

it("exports the selected target's localization quality list as a replayable report", async () => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-localization-quality-"));
	let outputPath = join(root, "export.json");
	const dialog = Layer.succeed(
		ElectronDialog,
		ElectronDialog.of({
			chooseDirectory: () => Effect.succeed({ status: "cancelled" }),
			chooseFile: () => Effect.succeed({ status: "cancelled" }),
			chooseFiles: () => Effect.succeed({ status: "cancelled" }),
			chooseSaveFile: () =>
				Effect.sync(() => ({ status: "selected" as const, path: outputPath }))
		})
	);
	const reader = makeLocalizationEvidenceTestLayer({
		discover: () =>
			Effect.succeed({ schemaVersion: 1, targets: [localizationTarget], diagnostics: [] }),
		read: () => Effect.succeed(localizationEvidence(poDocument(""))),
		targets: () => Effect.die("unused")
	});
	const query = {
		mode: "quality" as const,
		query: "",
		capability: "all" as const,
		lens: "all" as const,
		qualityFilter: "all" as const,
		workspaceFilter: "empty_translation" as const,
		localization: { target: localizationTarget.name, culture: cultureCode("de") }
	};
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* WorkbenchGameText;
				expect((yield* service.configuredRefresh(true)).status).toBe("completed");
				// Without rules nothing runs; preview the starter's checks.
				expect((yield* service.previewQualityRules(STARTER_CHECK_RULES)).status).toBe(
					"completed"
				);
				// Without a loaded target the export reports guidance instead of an empty list.
				expect(yield* service.investigationExport(query, "json")).toMatchObject({
					status: "failed"
				});
				expect(yield* service.localizationTarget(localizationTarget.name)).toMatchObject({
					status: "ready"
				});
				const listed = yield* service.localizationQualitySearch({
					target: localizationTarget.name,
					culture: cultureCode("de"),
					filter: "empty_translation"
				});
				if (listed.status !== "ready") throw new Error("Missing quality list.");
				expect(listed.page.total).toBeGreaterThan(0);
				expect(yield* service.investigationExport(query, "json")).toMatchObject({
					status: "saved",
					rowCount: listed.page.total
				});
				const exported = JSON.parse(
					yield* Effect.promise(() => readFile(outputPath, "utf8"))
				);
				expect(exported.schemaVersion).toBe(2);
				expect(exported.preset.schemaVersion).toBe(2);
				expect(exported.preset.query).toEqual(query);
				expect(exported.result).toMatchObject({
					mode: "localization_quality",
					report: {
						target: localizationTarget.name,
						culture: "de",
						filter: "empty_translation",
						total: listed.page.total
					}
				});
				expect(exported.result.report.findings).toEqual(listed.page.findings);
				outputPath = join(root, "preset.json");
				expect((yield* service.investigationSave(query)).status).toBe("saved");
				const savedPreset = JSON.parse(
					yield* Effect.promise(() => readFile(outputPath, "utf8"))
				);
				expect(savedPreset).toMatchObject({ schemaVersion: 2, query });
				outputPath = join(root, "export.csv");
				expect((yield* service.investigationExport(query, "csv")).status).toBe("saved");
				const csv = yield* Effect.promise(() => readFile(outputPath, "utf8"));
				expect(csv.split("\r\n")[0]).toContain('"Finding ID","Scan status"');
			}).pipe(
				Effect.provide(
					WorkbenchGameTextLive.pipe(
						Layer.provide(reader),
						Layer.provide(
							Layer.mergeAll(
								selectedProject,
								dialog,
								// Exports go through the host file hooks; this test reads them from disk.
								LocalFilesLive,
								makeTextCorpusServiceTestLayer({
									scan: () => Effect.die("unused"),
									scanFromProjectIndex: () => Effect.succeed(localizationCorpus())
								})
							)
						)
					)
				)
			)
		);
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
		// Presets are read through the same file hooks as the rules file.
		files.set(presetPath, new TextEncoder().encode(JSON.stringify(preset)));
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
				expect((yield* service.configuredRefresh(true)).status).toBe("completed");
				expect((yield* service.chooseQualityRules()).status).toBe("completed");
				openPath = presetPath;
				expect((yield* service.investigationOpen()).status).toBe("opened");
				// Embedded preset rules have no file, so a remounted editor offers Save preset.
				expect(yield* service.previewQualityRules(validQualityDocument)).toMatchObject({
					status: "completed",
					ruleFile: "none"
				});
				expect(yield* service.saveQualityRules(validQualityDocument)).toMatchObject({
					status: "failed",
					error: { code: "write_failed" }
				});
				expect(new TextDecoder().decode(files.get(qualityRulesPath))).toBe(original);
				const { rules: _rules, ...withoutRules } = preset;
				files.set(presetPath, new TextEncoder().encode(JSON.stringify(withoutRules)));
				expect((yield* service.investigationOpen()).status).toBe("opened");
				expect(yield* service.qualitySearch({ filter: "all", pageSize: 50 })).toEqual({
					status: "not_ready"
				});
				expect((yield* service.investigationExport(query, "json")).status).toBe("saved");
				// Problem and translation pills need the target's files; none are loaded here.
				expect(
					yield* service.investigationExport(
						{ ...query, localization: { target: localizationTarget.name } },
						"json"
					)
				).toMatchObject({
					status: "failed",
					message: expect.stringContaining("not loaded")
				});
			}).pipe(
				Effect.provide(
					WorkbenchGameTextLive.pipe(
						Layer.provide(noLocalization),
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
		expect(
			JSON.parse(new TextDecoder().decode(files.get(outputPath))).preset.rules
		).toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function failedIndexSteps(failure: IndexFailure) {
	return Layer.effect(
		GameTextIndexSteps,
		Effect.gen(function* () {
			const steps = yield* GameTextIndexSteps;
			return GameTextIndexSteps.of({ ...steps, prepareTarget: () => Effect.fail(failure) });
		})
	).pipe(Layer.provide(oracleGameTextIndexLayer(() => Effect.succeed(emptyCorpus))));
}

for (const failure of [
	{
		code: "reader_failed",
		error: new AssetReaderError({
			kind: "process",
			operation: "scan",
			message: "reader exited",
			recovery: "Reopen the reader.",
			retrySafe: false,
			nextStep: "reconcile"
		})
	},
	{
		code: "index_failed",
		error: new GameTextIndexError({
			code: "index_failed",
			operation: "join",
			message: "writer lost publication",
			recovery: "Reopen the committed state before publishing again.",
			retrySafe: false,
			nextStep: "reconcile",
			cause: new AssetReaderError({
				kind: "process",
				operation: "game_text_index",
				message: "transport stopped",
				recovery: "Retry the process.",
				retrySafe: true,
				nextStep: "retry"
			})
		})
	}
] as const) {
	for (const operation of ["configuredScan", "configuredRefresh"] as const) {
		it.effect(`reports ${failure.code} in ${operation} without blaming the project`, () =>
			Effect.gen(function* () {
				const service = yield* WorkbenchGameText;
				expect(yield* service[operation]()).toEqual({
					status: "failed",
					error: {
						code: failure.code,
						message: failure.error.message,
						recovery: failure.error.recovery,
						retrySafe: false
					}
				});
			}).pipe(
				Effect.provide(
					indexedWorkbenchGameTextLive.pipe(
						Layer.provide(
							failedIndexSteps(
								failure.error._tag === "AssetReaderError"
									? new GameTextIndexError({
											code: "index_failed",
											operation: "reader_failure",
											cause: failure.error,
											message: failure.error.message,
											recovery: failure.error.recovery,
											retrySafe: failure.error.retrySafe,
											nextStep: failure.error.nextStep
										})
									: failure.error
							)
						),
						Layer.provide(noLocalization),
						Layer.provide(gameTextAdapters),
						Layer.provide(configuration),
						Layer.provide(selectedProject)
					)
				)
			)
		);
	}
}

for (const native of [
	{
		code: "invalid_cache",
		recovery: "Close the failed session and rebuild the disposable index.",
		retrySafe: false,
		nextStep: "reconcile"
	},
	{
		code: "timeout",
		recovery: "Reopen the last committed state before a new build session.",
		retrySafe: false,
		nextStep: "reconcile"
	},
	{
		code: "busy",
		recovery: "Wait for the writer before opening another session.",
		retrySafe: true,
		nextStep: "retry"
	}
] as const) {
	for (const operation of ["configuredRefresh"] as const) {
		it.effect(`retains native ${native.code} recovery in ${operation}`, () => {
			const failure = new SnapshotStoreError({
				...native,
				operation: "native-index-builder",
				message: "native writer failed",
				cause: new AssetReaderError({
					code: native.code,
					kind: "process",
					operation: "game_text_index",
					message: "native writer failed",
					recovery: "Check the executable and retry.",
					retrySafe: true,
					nextStep: "retry"
				})
			});
			const failedSteps = failedIndexSteps(failure);
			return Effect.gen(function* () {
				const service = yield* WorkbenchGameText;
				expect(yield* service[operation]()).toEqual({
					status: "failed",
					error: {
						code: "index_failed",
						message: failure.message,
						recovery: native.recovery,
						retrySafe: native.retrySafe
					}
				});
			}).pipe(
				Effect.provide(
					indexedWorkbenchGameTextLive.pipe(
						Layer.provide(failedSteps),
						Layer.provide(noLocalization),
						Layer.provide(gameTextAdapters),
						Layer.provide(configuration),
						Layer.provide(selectedProject)
					)
				)
			);
		});
	}
}
