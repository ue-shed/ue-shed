import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Layer } from "effect";
import type { LocalizationLineId } from "../packages/game-text/dist/entry-schema.js";
import {
	corpusExpectationsName,
	corpusPlanName,
	decodeCorpusExpectations,
	diffCorpus,
	type CorpusSubject,
	type CorpusFinding
} from "./game-text-corpus-contract.ts";
import { gatheredNamespace } from "./game-text-corpus-localization.ts";
import { decodeCorpusPlan } from "./game-text-corpus-plan.ts";
import { ensureUassetExecutable } from "./native-tools.ts";
import { withCorpusUnrealLock } from "./game-text-corpus-lock.ts";
import {
	triageCorpusDifferences,
	formatCorpusComparisonSummary
} from "./game-text-corpus-defects.ts";

/** A corpus folder, not a repository fixture. Never launches Unreal or changes its inputs. */
async function compareGameTextCorpusLocked(
	corpusRoot: string,
	executable = ensureUassetExecutable(),
	options: {
		cacheRoot?: string;
		changedFiles?: readonly string[];
	} = {}
) {
	const [localization, assets, index, rulesApi, checks] = await Promise.all([
		import("../packages/localization/dist/index.js"),
		import("../packages/unreal-assets/dist/index.js"),
		import("../packages/game-text/dist/entry-index.js"),
		import("../packages/game-text/dist/entry-rules.js"),
		import("../packages/game-text/dist/entry-checks.js")
	]);
	const { LocalizationEvidenceNodeLive, CultureCode } = localization;
	const { assetReaderLayer } = assets;
	const {
		GameTextIndexRefresh,
		GameTextIndexBuilderLive,
		nativeIndexQueryLayer,
		gameTextIndexRefreshLayer,
		gameTextIndexSourceNodeLayer
	} = index;
	const { decodeGameTextRuleDocumentJson, localizationWordCount } = rulesApi;
	const { textProblems } = checks;

	const folder = resolve(corpusRoot);
	const plan = decodeCorpusPlan(await readFile(join(folder, corpusPlanName), "utf8"));
	const expected = decodeCorpusExpectations(
		await readFile(join(folder, corpusExpectationsName), "utf8")
	);
	let projectRoot = folder;
	for (const _part of plan.root.split("/").slice(1)) projectRoot = dirname(projectRoot);
	const cacheRoot =
		options.cacheRoot ?? (await mkdtemp(join(tmpdir(), "ue-shed-corpus-compare-")));
	try {
		const scanned = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const model = yield* (yield* GameTextIndexRefresh).refresh({
						projectRoot,
						targetName: plan.target,
						...(options.changedFiles
							? { changedFiles: options.changedFiles }
							: undefined)
					});
					const corpus = yield* model.corpus;
					const joined = {
						...model.localization,
						lines: yield* model.query.readLocalizationLines()
					};
					const rules = yield* decodeGameTextRuleDocumentJson(JSON.stringify(plan.rules));
					const quality = yield* model.localizationQuality(rules);
					const sourceQuality = yield* (yield* model.sourceQuality(rules)).export("all");
					const findings = yield* quality.findings.items(
						Array.from({ length: quality.findings.length }, (_, i) => i)
					);
					const findingsByLine = new Map<string, CorpusFinding[]>();
					for (const { finding } of findings)
						if ("culture" in finding) {
							const key = `${finding.lineId}\0${finding.culture}`,
								items = findingsByLine.get(key) ?? [];
							items.push({
								check: finding.ruleId,
								actual: finding.actual,
								expectation: finding.expectation,
								...(expected.findingFixes &&
								"suggestedChange" in finding &&
								finding.suggestedChange
									? { fix: finding.suggestedChange }
									: undefined)
							});
							findingsByLine.set(key, items);
						}

					const observations: {
						case: string;
						subject: string;
						expected: unknown;
						actual: unknown;
					}[] = [];
					const queryFacts = new Map<
						string,
						{
							signals: readonly string[];
							problems: readonly string[];
							words: number | null;
						}
					>();
					for (const culture of plan.cultures) {
						let cursor: LocalizationLineId | undefined;
						do {
							const page = yield* model.search({
								query: "",
								capability: "all",
								pageSize: 50,
								localization: {
									target: model.localization.target,
									cultures: [CultureCode.make(culture)]
								},
								...(cursor ? { localizationCursor: cursor } : undefined)
							});
							for (const line of page.localization?.lines ?? []) {
								const unit = page.units.find(
									(unit) =>
										line.origin.kind === "corpus" &&
										line.origin.unitIds.includes(unit.id)
								);
								queryFacts.set(`${line.id}\0${culture}`, {
									signals:
										line.origin.kind === "corpus"
											? (unit?.reviewSignals ?? [])
											: [],
									problems: line.problems ?? [],
									words: unit?.wordCount ?? null
								});
							}
							cursor = page.localization?.nextCursor;
						} while (cursor !== undefined);
					}
					const units = new Map(corpus.units.map((unit) => [unit.id, unit]));
					const placements = plan.packages.flatMap((owner) =>
						owner.texts.map((text) => ({ owner, text }))
					);
					const placementsByPackage = new Map<string, typeof placements>();
					for (const placement of placements) {
						const group = placementsByPackage.get(placement.owner.path) ?? [];
						group.push(placement);
						placementsByPackage.set(placement.owner.path, group);
					}

					const subjects: CorpusSubject[] = [];
					// Physical stage values remain observable even when today's join rejects a collapse dialect.
					const stages = (
						mark: (typeof joined.lines)[number]["cultures"][number],
						source: string,
						namespace: string
					) => {
						const file = model.evidence.cultures.find(
							(entry) => entry.culture === mark.culture
						)?.po;
						const collapseEntry =
							plan.scenario === "collapse" && file?.status === "read"
								? file.value.entries.find(
										(entry) =>
											entry.msgctxt === namespace && entry.msgid === source
									)
								: undefined;
						return {
							po: mark.po?.msgstr["0"] ?? collapseEntry?.msgstr["0"] ?? null,
							archive: mark.archive?.translation.Text ?? null,
							compiled: null,
							importPending: false,
							compilePending: false
						};
					};
					for (const line of joined.lines) {
						const occurrences =
							line.origin.kind === "corpus"
								? line.origin.unitIds.flatMap(
										(id) => units.get(id)?.occurrences ?? []
									)
								: [];
						const matches = new Map<
							string,
							(typeof placements)[number] & { source: string }
						>();
						for (const occurrence of occurrences) {
							const path = occurrence.location.objectPath.split(".")[0]!;
							const local = placementsByPackage.get(path) ?? [];
							const candidates = local.filter(
								({ owner, text }) =>
									owner.path === path &&
									text.exists &&
									(text.mode === "reference"
										? occurrence.identity.status === "string_table" &&
											occurrence.identity.tableId === text.table &&
											occurrence.identity.key === text.tableKey
										: text.mode === "invariant" || text.mode === "scaffold"
											? occurrence.identity.status === "unresolved" &&
												occurrence.source === text.source
											: occurrence.identity.status === "resolved" &&
												occurrence.identity.key === text.key &&
												occurrence.identity.namespace === text.namespace)
							);
							const placement =
								candidates.find(({ text }) =>
									occurrence.location.kind === "data_table_cell"
										? text.field.split(".")[0] === occurrence.location.row
										: occurrence.location.kind === "string_table_entry" ||
											occurrence.location.objectPath.includes(
												text.field.split(".")[0]!
											) ||
											(occurrence.location.kind === "asset_property" &&
												occurrence.location.propertyPath.includes(
													text.field.split(".")[0]!
												))
								) ??
								local.find(
									({ owner, text }) =>
										owner.path === path &&
										text.kind === "blueprintPin" &&
										(occurrence.source === text.compiledSource ||
											occurrence.source === text.source) &&
										occurrence.location.kind === "asset_property" &&
										occurrence.location.propertyPath.startsWith(
											"ScriptBytecode["
										) &&
										occurrence.identity.status === "resolved" &&
										occurrence.identity.key === text.key &&
										gatheredNamespace(occurrence.identity.namespace) ===
											gatheredNamespace(text.namespace)
								);
							if (placement) {
								const key = `${placement.owner.path}\0${placement.text.field}`;
								// Bytecode and its pin are representations of one planned authoring subject.
								// Retain native state/signals, including any incorrect conflict classification.
								if (
									!matches.has(key) ||
									occurrence.source !== placement.text.compiledSource
								)
									matches.set(key, {
										...placement,
										source:
											placement.text.mode === "reference" && line.identity
												? line.source
												: occurrence.source
									});
							} else
								for (const culture of line.cultures)
									subjects.push({
										case: "unplanned",
										packagePath: path,
										namespace:
											occurrence.identity.status === "resolved"
												? occurrence.identity.namespace
												: "",
										key: "unplanned",
										kind: "manifest",
										field: occurrence.location.objectPath,
										source: occurrence.source,
										gatheredSource: line.manifest[0]?.source.Text ?? null,
										culture: culture.culture,
										state: culture.state,
										facts: culture.facts,
										unknownReasons: culture.unknownReasons,
										signals: [],
										problems: [],
										findings: [],
										stages: stages(
											culture,
											line.source,
											line.identity?.namespace ?? ""
										),
										absent: []
									});
						}
						if (line.origin.kind === "evidence")
							for (const placement of placements.filter(
								({ text }) =>
									!text.exists &&
									line.identity?.namespace ===
										gatheredNamespace(text.namespace) &&
									line.identity.key === text.key
							))
								matches.set(`${placement.owner.path}\0${placement.text.field}`, {
									...placement,
									source: line.source
								});
						if (matches.size === 0 && occurrences.length === 0)
							for (const culture of line.cultures)
								subjects.push({
									case: "unplanned",
									packagePath: "",
									namespace: line.identity?.namespace ?? "",
									key: line.identity?.key ?? "",
									kind: "manifest",
									field: "",
									source: line.source,
									gatheredSource: line.manifest[0]?.source.Text ?? null,
									culture: culture.culture,
									state: culture.state,
									facts: culture.facts,
									unknownReasons: culture.unknownReasons,
									signals: [],
									problems: [],
									findings: [],
									stages: stages(
										culture,
										line.source,
										line.identity?.namespace ?? ""
									),
									absent: []
								});
						for (const { owner, text, source } of matches.values()) {
							for (const probe of plan.probes.filter(
								(probe) => probe.case === text.case
							)) {
								let observed: unknown;
								if (probe.kind === "without-notes") {
									const page = yield* model.search({
										query: "",
										capability: "all",
										pageSize: 50,
										withoutNotes: true,
										filter: [{ field: "source", op: "is", values: [source] }],
										localization: { target: model.localization.target }
									});
									observed =
										page.localization?.lines.some(
											(row) => row.id === line.id
										) ?? false;
								} else if (probe.kind === "word-count")
									observed = queryFacts.get(
										`${line.id}\0${probe.culture}`
									)?.words;
								else if (probe.kind === "localization-word-count")
									observed = localizationWordCount(source);
								else {
									const detail = yield* model.query.localizationDetail({
										target: model.localization.target,
										selection: { kind: "line", id: line.id }
									});
									const id =
										line.origin.kind === "corpus"
											? line.origin.unitIds[0]
											: undefined;
									const focus = id
										? yield* model.query.focus({
												id,
												localization: {
													target: model.localization.target,
													id: line.id
												},
												pageSize: 50
											})
										: undefined;
									observed = textProblems({
										signals: focus?.unit.reviewSignals ?? [],
										keyChanged: detail?.keyChange?.direction === "to",
										marks: detail?.translations ?? []
									});
								}
								observations.push({
									case: probe.case,
									subject: `probe:${probe.kind}:${probe.culture}`,
									expected: probe.expected,
									actual: observed ?? null
								});
							}
							for (const mark of line.cultures) {
								const facts = queryFacts.get(`${line.id}\0${mark.culture}`);
								const reported: CorpusFinding[] = [
									...(findingsByLine.get(`${line.id}\0${mark.culture}`) ?? [])
								];
								if (
									mark.culture === model.localization.nativeCulture &&
									line.origin.kind === "corpus"
								) {
									const unitIds = line.origin.unitIds;
									for (const finding of sourceQuality.findings)
										if (unitIds.includes(finding.textUnitId))
											reported.push({
												check: finding.ruleId,
												actual: finding.actual,
												expectation: finding.expectation
											});
								}
								subjects.push({
									case: text.case,
									packagePath: owner.path,
									namespace: text.namespace,
									key: text.key,
									kind: text.kind,
									field: text.field,
									source,
									gatheredSource: line.manifest[0]?.source.Text ?? null,
									culture: mark.culture,
									state: mark.state,
									facts: mark.facts,
									unknownReasons: mark.unknownReasons,
									signals: facts?.signals ?? [],
									problems:
										facts?.problems ??
										textProblems({
											signals: [],
											keyChanged: false,
											marks: [mark]
										}),
									findings: reported,
									stages: stages(
										mark,
										line.source,
										line.identity?.namespace ?? ""
									),
									absent: []
								});
							}
						}
					}
					return { subjects, observations };
				})
			).pipe(
				Effect.provide(
					gameTextIndexRefreshLayer(cacheRoot).pipe(
						Layer.provide(gameTextIndexSourceNodeLayer(cacheRoot)),
						Layer.provide(GameTextIndexBuilderLive),
						Layer.provide(
							nativeIndexQueryLayer({
								executable,
								timeoutMs: 600_000,
								catalogTimeoutMs: 600_000
							})
						),
						Layer.provide(LocalizationEvidenceNodeLive)
					)
				),
				Effect.provide(assetReaderLayer({ executable }))
			)
		);
		for (const probe of plan.probes)
			if (
				!scanned.observations.some(
					(item) =>
						item.case === probe.case &&
						item.subject === `probe:${probe.kind}:${probe.culture}`
				)
			)
				scanned.observations.push({
					case: probe.case,
					subject: `probe:${probe.kind}:${probe.culture}`,
					expected: probe.expected,
					actual: null
				});
		const differences = [
			...diffCorpus(expected, scanned.subjects),
			...scanned.observations.filter((item) => !isDeepStrictEqual(item.expected, item.actual))
		];
		const activeSubjects = [...expected.subjects];
		const activeProbes = [...scanned.observations];
		const probeRoot = join(
			projectRoot,
			"Saved",
			"UEShedCorpus",
			"CollapseProbe",
			"Content",
			...plan.root.split("/").slice(2)
		);
		if (plan.scenario === "main") {
			if (!existsSync(probeRoot))
				throw new Error(
					"Missing collapse probe; regenerate this scratch corpus with corpus:generate."
				);
			const probe = await compareGameTextCorpusLocked(probeRoot, executable);
			differences.push(...probe.differences);
			activeSubjects.push(...probe.expected.subjects);
			activeProbes.push(...probe.observations);
		}
		return {
			expected,
			actual: scanned.subjects,
			observations: scanned.observations,
			differences,
			triage: triageCorpusDifferences(differences, activeSubjects, activeProbes)
		};
	} finally {
		if (!options.cacheRoot) await rm(cacheRoot, { recursive: true, force: true });
	}
}

/** The lease covers the complete native scan, including the recursive collapse probe. */
export async function compareGameTextCorpus(
	corpusRoot: string,
	executable = ensureUassetExecutable(),
	options: Parameters<typeof compareGameTextCorpusLocked>[2] = {}
) {
	return withCorpusUnrealLock(() => compareGameTextCorpusLocked(corpusRoot, executable, options));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const root = process.argv[2] ?? process.env.UE_SHED_GAME_TEXT_CORPUS;
	if (!root) {
		process.stdout.write(
			"SKIP: generate with pnpm corpus:generate --project <scratch.uproject> --seed 1 --lines 256, then pass its Content corpus folder or set UE_SHED_GAME_TEXT_CORPUS.\n"
		);
	} else {
		const result = await compareGameTextCorpus(root);
		process.stdout.write(`${JSON.stringify(result.triage, null, 2)}\n`);
		process.stdout.write(
			formatCorpusComparisonSummary(
				result.actual.length,
				result.differences.length,
				result.triage.pinned
			)
		);
		process.exitCode = result.triage.unexpected.length || result.triage.stale.length ? 1 : 0;
	}
}
