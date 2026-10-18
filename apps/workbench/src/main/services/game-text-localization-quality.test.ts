import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect";
import { expect } from "vitest";
import { LocalizationTarget, makeLocalizationEvidenceTestLayer } from "@ue-shed/localization";
import { corpus, evidence, cultureCode } from "./game-text-localization.test-support.js";
import { GameTextIndexSteps } from "@ue-shed/game-text/index";
import { GameTextRuleDocument } from "@ue-shed/game-text/rules";
import {
	makeGameTextLocalizationOracle as makeGameTextLocalization,
	oracleGameTextIndexLayer,
	oracleProjectIndex
} from "./game-text-index.test-support.js";
import { makeGameTextLocalization as indexedGameTextLocalization } from "./game-text-localization.js";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { LocalFiles, makeLocalFilesTestLayer } from "../adapters/local-files.js";

const files = evidence();
const fixture = {
	text: corpus(),
	files,
	join: { target: files.target.name },
	document: Schema.decodeUnknownSync(GameTextRuleDocument)({
		schemaVersion: 2,
		roles: [
			{
				id: "menu",
				scopes: [
					{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/" }] }
				]
			}
		],
		rules: [
			{
				id: "source.limit",
				kind: "character_budget",
				role: "menu",
				maximumCharacters: 3,
				recovery: "Shorten the line."
			}
		],
		localizationRules: [
			{
				id: "translation.limit",
				kind: "localization_character_budget",
				role: "menu",
				cultures: { de: 4 },
				recovery: "Shorten the translation."
			}
		]
	})
};
const other = Schema.decodeUnknownSync(LocalizationTarget)({ ...files.target, name: "Other" });
const reader = makeLocalizationEvidenceTestLayer({
	discover: () =>
		Effect.succeed({ schemaVersion: 1, targets: [fixture.files.target], diagnostics: [] }),
	read: () => Effect.succeed(fixture.files),
	targets: () => Effect.die("Not used")
});

it.effect(
	"retains checks, reevaluates previewed culture rules and invalidates results on rescan",
	() =>
		Effect.gen(function* () {
			const document = yield* Ref.make<GameTextRuleDocument>(fixture.document);
			const text = yield* Ref.make(fixture.text);
			const host = yield* makeGameTextLocalization(
				() => Ref.get(text),
				() => Effect.succeed(oracleProjectIndex("C:/Project")),
				() => Ref.get(document)
			);
			yield* host.select(fixture.join.target);
			const request = {
				target: fixture.join.target,
				culture: cultureCode("de"),
				filter: "character_budget"
			} as const;
			const result = yield* host.qualitySearch(request);
			expect(result).toMatchObject({
				status: "ready",
				page: { total: 2, counts: { character_budget: 2 } }
			});
			if (fixture.document.schemaVersion !== 2) throw new Error("V2 fixture required");
			yield* Ref.set(document, {
				...fixture.document,
				localizationRules:
					fixture.document.localizationRules?.map((rule) =>
						rule.kind === "localization_character_budget"
							? { ...rule, cultures: Object.fromEntries([["de", 100]]) }
							: rule
					) ?? []
			});
			expect(yield* host.qualitySearch(request)).toMatchObject({
				status: "ready",
				page: { total: 1 }
			});
			const fixes = yield* host.changes({ ...request, filter: "format_arguments" });
			expect(fixes).toMatchObject({ status: "ready", document: { changes: [] } });
			expect(JSON.stringify(fixes)).not.toContain("Content/Localization");
			yield* Ref.set(text, { ...fixture.text });
			yield* host.reset();
			expect(yield* host.qualitySearch(request)).toEqual({ status: "not_ready" });
			yield* host.select(fixture.join.target);
			expect(yield* host.report({ target: fixture.join.target })).toMatchObject({
				status: "ready",
				page: { rows: [{ culture: "en" }, { culture: "de" }] }
			});
		}).pipe(Effect.provide(reader))
);

it.effect(
	"saves baselines exclusively, compares bounded metadata and exports CSV behind dialogs",
	() =>
		Effect.gen(function* () {
			const files = yield* LocalFiles;
			const host = yield* makeGameTextLocalization(
				() => Effect.succeed(fixture.text),
				() => Effect.succeed(oracleProjectIndex("C:/Project"))
			);
			yield* host.select(fixture.join.target);
			const baselinePath = "C:/Exports/baseline.json",
				csvPath = "C:/Exports/report.csv";
			const dialog = ElectronDialog.of({
				chooseDirectory: () => Effect.succeed({ status: "cancelled" }),
				chooseFiles: () => Effect.succeed({ status: "cancelled" }),
				chooseFile: () => Effect.succeed({ status: "selected", path: baselinePath }),
				chooseSaveFile: (options) =>
					Effect.succeed({
						status: "selected",
						path:
							options.title === "Save localization baseline" ? baselinePath : csvPath
					})
			});
			const request = { target: fixture.join.target, operation: "save_baseline" } as const;
			expect(yield* host.reportFile(request, dialog, files)).toEqual({
				status: "saved",
				message: "Baseline saved."
			});
			const saved = yield* files.readFile(baselinePath);
			expect(yield* host.reportFile(request, dialog, files)).toMatchObject({
				status: "failed",
				recovery: expect.stringContaining("never overwritten")
			});
			expect(yield* files.readFile(baselinePath)).toEqual(saved);
			const compared = yield* host.reportFile(
				{ ...request, operation: "compare_baseline" },
				dialog,
				files
			);
			expect(compared).toMatchObject({
				status: "compared",
				page: {
					baseline: { target: fixture.join.target },
					rows: [
						{ newWords: 0, changedWords: 0 },
						{ newWords: 0, changedWords: 0 }
					]
				}
			});
			expect(JSON.stringify(compared)).not.toContain(baselinePath);
			expect(JSON.stringify(compared)).not.toContain("relativePath");
			yield* host.reportFile({ ...request, operation: "export_csv" }, dialog, files);
			const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
				yield* files.readFile(csvPath)
			);
			expect(csv.startsWith('\uFEFF"Culture"')).toBe(true);
			expect(csv.endsWith("\r\n")).toBe(true);
			expect(csv).toContain('"New words","Changed words"');
		}).pipe(Effect.provide(Layer.mergeAll(reader, makeLocalFilesTestLayer())))
);

it.effect("selecting another target interrupts the previous target's abandoned scan", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>();
		const finalized = yield* Deferred.make<void>();
		const turns = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
			discard: true
		});
		// Every opened target's scan announces itself, then never finishes.
		const steps = Layer.effect(
			GameTextIndexSteps,
			Effect.gen(function* () {
				const oracle = yield* GameTextIndexSteps;
				return GameTextIndexSteps.of({
					...oracle,
					openTarget: (target) =>
						oracle.openTarget(target).pipe(
							Effect.map((result) =>
								Object.assign(result, {
									localizationQuality: () =>
										Deferred.succeed(started, undefined).pipe(
											Effect.andThen(Effect.never),
											Effect.ensuring(Deferred.succeed(finalized, undefined))
										)
								})
							)
						)
				});
			})
		).pipe(Layer.provide(oracleGameTextIndexLayer(() => Effect.succeed(fixture.text))));
		const readCorpus = Effect.succeed(fixture.text);
		const host = yield* indexedGameTextLocalization(
			() => Effect.succeed(readCorpus),
			() => Effect.succeed(oracleProjectIndex("C:/Project"))
		).pipe(Effect.provide(steps));
		expect(yield* host.select(fixture.join.target)).toMatchObject({ status: "ready" });
		const request = yield* Effect.forkChild(
			host.qualitySearch({ target: fixture.join.target, filter: "all" })
		);
		yield* Deferred.await(started);
		yield* Fiber.interrupt(request);
		yield* turns;
		// The scan outlives the request that started it while its target stays selected.
		expect(yield* Deferred.isDone(finalized)).toBe(false);
		expect(yield* host.select(other.name)).toMatchObject({ status: "ready" });
		yield* turns;
		expect(yield* Deferred.isDone(finalized)).toBe(true);
	}).pipe(
		Effect.provide(
			makeLocalizationEvidenceTestLayer({
				discover: () =>
					Effect.succeed({
						schemaVersion: 1,
						targets: [fixture.files.target, other],
						diagnostics: []
					}),
				read: ({ target }) => Effect.succeed({ ...fixture.files, target }),
				targets: () => Effect.die("Not used")
			})
		)
	)
);

it.effect("keeps no-target projects free of quality and report authority", () =>
	Effect.gen(function* () {
		const host = yield* makeGameTextLocalization(
			() => Effect.succeed(fixture.text),
			() => Effect.succeed(oracleProjectIndex("C:/Project"))
		);
		expect(yield* host.targets()).toEqual({ status: "ready", targets: [] });
		expect(yield* host.qualitySearch({ target: fixture.join.target, filter: "all" })).toEqual({
			status: "not_ready"
		});
		expect(yield* host.report({ target: fixture.join.target })).toEqual({
			status: "not_ready"
		});
	}).pipe(
		Effect.provide(
			makeLocalizationEvidenceTestLayer({
				discover: () => Effect.succeed({ schemaVersion: 1, targets: [], diagnostics: [] }),
				read: () => Effect.die("No targets must not load evidence"),
				targets: () => Effect.die("Not used")
			})
		)
	)
);
