import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Effect, Layer, Schema } from "effect";
import { textProblems } from "@ue-shed/game-text/checks";
import {
	GameTextIndexBuilderLive,
	GameTextIndexRefresh,
	gameTextIndexRefreshLayer,
	gameTextIndexSourceNodeLayer,
	nativeIndexQueryLayer
} from "@ue-shed/game-text/index";
import { decodeGameTextRuleDocumentJson, localizationWordCount } from "@ue-shed/game-text/rules";
import type { LocalizationLineId } from "@ue-shed/game-text/schema";
import { CultureCode, LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { ErrorCauseFields, ErrorGuidanceFields } from "@ue-shed/protocol";
import { assetReaderLayer } from "@ue-shed/unreal-assets";
import {
	corpusExpectationsName,
	corpusPlanName,
	decodeCorpusExpectations,
	diffCorpus,
	type CorpusExpectations,
	type CorpusFinding,
	type CorpusSubject
} from "./contract.js";
import { triageCorpusDifferences } from "./defects.js";
import { gatheredNamespace } from "./localization.js";
import { decodeCorpusPlan, probeSubject } from "./plan.js";

/** Opt-in checks the comparison also reads through Browse, as a findings layer. */
const signalCheckIds = ["shared", "long"] as const;

/** The corpus folder lacks a readable plan, answers or collapse probe. */
export class GameTextCorpusError extends Schema.TaggedError<GameTextCorpusError>()(
	"GameTextCorpusError",
	{ ...ErrorGuidanceFields, ...ErrorCauseFields }
) {}

/** One expected subject or probe, and what the scan reported for it. */
export interface GameTextCorpusDifference {
	readonly case: string;
	readonly subject?: string;
	readonly expected: unknown;
	readonly actual: unknown;
}

/** A comparison: the answers, the scan's subjects and probes, and every disagreement's triage. */
export interface GameTextCorpusComparison {
	readonly expected: CorpusExpectations;
	readonly actual: readonly CorpusSubject[];
	readonly observations: readonly GameTextCorpusDifference[];
	readonly differences: readonly GameTextCorpusDifference[];
	readonly triage: ReturnType<typeof triageCorpusDifferences>;
}

const regenerate = "Regenerate this scratch corpus with corpus:generate.";
const readCorpus = (folder: string) =>
	Effect.tryPromise({
		try: async () => ({
			plan: decodeCorpusPlan(await readFile(join(folder, corpusPlanName), "utf8")),
			expected: decodeCorpusExpectations(
				await readFile(join(folder, corpusExpectationsName), "utf8")
			)
		}),
		catch: (cause) =>
			new GameTextCorpusError({
				cause,
				message: `${folder} has no readable corpus plan and answers.`,
				recovery: regenerate,
				retrySafe: true,
				nextStep: "fix_input"
			})
	});

/** UE Shed's own index over `cacheRoot`, reading packages with `executable`. */
export function gameTextCorpusIndexLayer(options: {
	readonly executable: string;
	readonly cacheRoot: string;
}): Layer.Layer<GameTextIndexRefresh, unknown> {
	const { executable, cacheRoot } = options;
	return gameTextIndexRefreshLayer(cacheRoot).pipe(
		Layer.provide(gameTextIndexSourceNodeLayer(cacheRoot)),
		Layer.provide(GameTextIndexBuilderLive),
		Layer.provide(
			nativeIndexQueryLayer({ executable, timeoutMs: 600_000, catalogTimeoutMs: 600_000 })
		),
		Layer.provide(LocalizationEvidenceNodeLive),
		Layer.provide(assetReaderLayer({ executable }))
	);
}

/** One corpus folder, scanned through the index and compared with its answers. */
const compareFolder = Effect.fnUntraced(function* (
	folder: string,
	changedFiles: readonly string[] | undefined
) {
	const { plan, expected } = yield* readCorpus(folder);
	let projectRoot = folder;
	for (const _part of plan.root.split("/").slice(1)) projectRoot = dirname(projectRoot);
	const scanned = yield* Effect.scoped(
		Effect.gen(function* () {
			const model = yield* (yield* GameTextIndexRefresh).refresh({
				projectRoot,
				targetName: plan.target,
				...(changedFiles ? { changedFiles } : undefined)
			});
			const corpus = yield* model.corpus;
			const joined = {
				...model.localization,
				lines: yield* model.query.readLocalizationLines()
			};
			const rules = yield* decodeGameTextRuleDocumentJson(JSON.stringify(plan.rules));
			const quality = yield* model.localizationCheck(rules);
			const sourceQuality = yield* (yield* model.sourceQuality(rules)).export("all");
			// Browse's findings are the rules': with a layer of only the shared and long
			// checks, each line's findings are the rules the report lists for it, and no others.
			const signalRules = yield* decodeGameTextRuleDocumentJson(
				JSON.stringify({
					schemaVersion: 1,
					roles: [],
					rules: signalCheckIds.map((kind) => ({ kind }))
				})
			);
			const signalReport = yield* model.localizationCheck(signalRules);
			const signalChecksByLine = new Map<string, Set<string>>();
			for (const finding of signalReport.findings)
				if ("culture" in finding)
					signalChecksByLine.set(
						finding.lineId,
						(signalChecksByLine.get(finding.lineId) ?? new Set()).add(finding.ruleId)
					);
			const signalLayer = (yield* model.localizationQuality(signalRules)).findings;
			if (!signalLayer)
				return yield* Effect.die(
					new Error("The shared and long checks made no findings layer.")
				);
			const browseFindings = new Map<string, readonly string[]>();
			let findingsCursor: LocalizationLineId | undefined;
			do {
				const page = yield* model.search({
					query: "",
					capability: "all",
					pageSize: 50,
					findings: signalLayer,
					localization: { target: model.localization.target },
					...(findingsCursor ? { localizationCursor: findingsCursor } : undefined)
				});
				for (const line of page.localization?.lines ?? [])
					browseFindings.set(line.id, line.findings ?? []);
				findingsCursor = page.localization?.nextCursor;
			} while (findingsCursor !== undefined);
			const signalChecks: {
				case: string;
				subject: string;
				expected: unknown;
				actual: unknown;
			}[] = [];
			const findings = quality.findings.map((finding) => ({ finding }));
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
								line.origin.kind === "corpus" ? (unit?.reviewSignals ?? []) : [],
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
								(entry) => entry.msgctxt === namespace && entry.msgid === source
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
						? line.origin.unitIds.flatMap((id) => units.get(id)?.occurrences ?? [])
						: [];
				const matches = new Map<string, (typeof placements)[number] & { source: string }>();
				for (const occurrence of occurrences) {
					// The plan places text in assets; code text is checked by unreal-code's conformance.
					const location = occurrence.location;
					if (location.kind === "code_place") continue;
					const path = location.objectPath.split(".")[0]!;
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
									location.objectPath.includes(text.field.split(".")[0]!) ||
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
								occurrence.location.propertyPath.startsWith("ScriptBytecode[") &&
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
								field: location.objectPath,
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
							line.identity?.namespace === gatheredNamespace(text.namespace) &&
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
							stages: stages(culture, line.source, line.identity?.namespace ?? ""),
							absent: []
						});
				const signalled = [...(browseFindings.get(line.id) ?? [])].sort();
				const checked = [...(signalChecksByLine.get(line.id) ?? [])].sort();
				if (!isDeepStrictEqual(signalled, checked))
					signalChecks.push({
						case:
							[...matches.values()][0]?.text.case ??
							`unplanned:${line.identity?.key ?? line.id}`,
						subject: "signal-checks",
						expected: signalled,
						actual: checked
					});
				for (const { owner, text, source } of matches.values()) {
					for (const probe of plan.probes.filter((probe) => probe.case === text.case)) {
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
								page.localization?.lines.some((row) => row.id === line.id) ?? false;
						} else if (probe.kind === "word-count")
							observed = queryFacts.get(`${line.id}\0${probe.culture}`)?.words;
						else if (probe.kind === "localization-word-count")
							observed = localizationWordCount(source);
						else {
							// The line page reads the line with the list's culture scope.
							const detail = yield* model.query.localizationDetail({
								target: model.localization.target,
								selection: { kind: "line", id: line.id },
								...(probe.culture === undefined
									? undefined
									: { culture: CultureCode.make(probe.culture) })
							});
							observed = detail?.problems ?? null;
						}
						observations.push({
							case: probe.case,
							subject: probeSubject(probe),
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
							stages: stages(mark, line.source, line.identity?.namespace ?? ""),
							absent: []
						});
					}
				}
			}
			return { subjects, observations, signalChecks };
		})
	);
	for (const probe of plan.probes)
		if (
			!scanned.observations.some(
				(item) => item.case === probe.case && item.subject === probeSubject(probe)
			)
		)
			scanned.observations.push({
				case: probe.case,
				subject: probeSubject(probe),
				expected: probe.expected,
				actual: null
			});
	const differences: GameTextCorpusDifference[] = [
		...diffCorpus(expected, scanned.subjects),
		...scanned.observations.filter((item) => !isDeepStrictEqual(item.expected, item.actual)),
		// Never pinned: a signal check must agree with Browse's signal.
		...scanned.signalChecks
	];
	return { plan, projectRoot, expected, scanned, differences };
});

/**
 * Compares a generated corpus folder with its planted answers through the host's
 * `GameTextIndexRefresh`. Never launches Unreal or changes the corpus; a host that shares the
 * machine with Unreal holds its own lock around the run.
 */
export const compareGameTextCorpus = Effect.fn("GameTextCorpus.compare")(function* (
	corpusRoot: string,
	options: {
		/** The files changed since the index's last scan of this corpus. */
		readonly changedFiles?: readonly string[];
	} = {}
) {
	const main = yield* compareFolder(resolve(corpusRoot), options.changedFiles);
	const differences = [...main.differences];
	const activeSubjects = [...main.expected.subjects];
	const activeProbes = [...main.scanned.observations];
	if (main.plan.scenario === "main") {
		const probeRoot = join(
			main.projectRoot,
			"Saved",
			"UEShedCorpus",
			"CollapseProbe",
			"Content",
			...main.plan.root.split("/").slice(2)
		);
		if (!existsSync(probeRoot))
			return yield* new GameTextCorpusError({
				message: "The corpus has no collapse probe.",
				recovery: regenerate,
				retrySafe: true,
				nextStep: "fix_input"
			});
		// The probe is its own project, scanned whole through the same index.
		const probe = yield* compareFolder(probeRoot, undefined);
		differences.push(...probe.differences);
		activeSubjects.push(...probe.expected.subjects);
		activeProbes.push(...probe.scanned.observations);
	}
	const comparison: GameTextCorpusComparison = {
		expected: main.expected,
		actual: main.scanned.subjects,
		observations: main.scanned.observations,
		differences,
		triage: triageCorpusDifferences(differences, activeSubjects, activeProbes)
	};
	return comparison;
});
