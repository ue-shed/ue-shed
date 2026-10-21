import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalizationEvidence, LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { CultureCode, TextKey, TextNamespace } from "@ue-shed/localization/browser";
import { assetReaderLayer } from "@ue-shed/unreal-assets";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { savedFixtureCorpus } from "./saved-corpus.test-support.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";

import { GameTextIndexRefresh, gameTextIndexRefreshLayer } from "./index-refresh.js";
import { gameTextIndexSourceNodeLayer } from "./index-source-node.js";
import { joinLocalizationTarget } from "./localization.js";
import { checkLocalizationTarget } from "./localization-checks.js";
import { applyLocalizationKeyChanges, localizationKeyChanges } from "./localization-key-changes.js";
import type { LocalizationQualityReport } from "./localization-quality-schema.js";
import type { LocalizationJoin } from "./localization-schema.js";
import {
	BuiltInQualityFilter,
	localizationQualityWorkspace,
	localizationQualityWorkspaceOf
} from "./localization-workspace.js";
import { textCorpusQuery } from "./query.test-support.js";
import {
	decodeGameTextRuleDocumentJson,
	evaluateGameTextSourceQuality
} from "./game-text-rules.js";
import type { TextCorpus, TextCorpusSearchRequest } from "./schema.js";
import { staleRuntimeCopy } from "./text-copies.js";
import { TextAudience, TextOutOfScopeReason } from "./text-audience-schema.js";

const Identity = Schema.Struct({ namespace: TextNamespace, key: TextKey });
const Cases = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: Schema.Literal("Game"),
	rules: Schema.String,
	findings: Schema.Array(
		Schema.Struct({
			case: Schema.String,
			check: Schema.String,
			culture: CultureCode,
			namespace: Schema.NullOr(TextNamespace),
			key: Schema.NullOr(TextKey),
			source: Schema.optionalKey(Schema.String),
			// Which reports have the finding: with the rule file, without it, or both.
			rules: Schema.Literals(["with", "without", "both"])
		})
	),
	sourceRules: Schema.Array(
		Schema.Struct({ case: Schema.String, ruleId: Schema.String, source: Schema.String })
	),
	signals: Schema.Struct({
		conflictingSource: Schema.Array(Identity),
		compiledCopyDiffers: Schema.Array(
			Schema.Struct({
				objectPath: Schema.String,
				source: Schema.String,
				compiledSource: Schema.String
			})
		),
		outOfScope: Schema.Array(
			Schema.Struct({
				...Identity.fields,
				reason: TextOutOfScopeReason,
				audience: TextAudience
			})
		),
		keyChanged: Schema.Array(Schema.Struct({ from: Identity, to: Identity })),
		partlyRead: Schema.Array(Schema.String)
	}),
	counts: Schema.Struct({
		without: Schema.Record(Schema.String, Schema.Int),
		with: Schema.Record(Schema.String, Schema.Int)
	})
});

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();
const NAMESPACE_PREFIX = "Fixture.GameTextProblems.";

const kindCounts = (report: LocalizationQualityReport) => {
	const counts: Record<string, number> = {};
	for (const finding of report.findings) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
};

const hasFinding = (
	report: LocalizationQualityReport,
	expected: (typeof Cases.Type.findings)[number]
) =>
	report.findings.some(
		(finding) =>
			finding.kind === expected.check &&
			"culture" in finding &&
			finding.culture === expected.culture &&
			(expected.key === null
				? finding.identity === null &&
					finding.kind === "culture_invariant_text" &&
					finding.actual.source === expected.source
				: finding.identity?.namespace === expected.namespace &&
					finding.identity?.key === expected.key)
	);

/** What the UI shows of a line: its state per culture, audience, scope and key change. */
const lineFacts = (join: LocalizationJoin) =>
	join.lines
		.filter((line) => line.identity?.namespace.startsWith(NAMESPACE_PREFIX))
		.map((line) =>
			JSON.stringify([
				line.identity!.namespace,
				line.identity!.key,
				line.source,
				line.audience ?? null,
				line.outOfScope ?? null,
				line.keyChange ? [line.keyChange.direction, line.keyChange.other] : null,
				line.cultures.map((culture) => [
					culture.culture,
					culture.state,
					[...culture.unknownReasons].sort()
				])
			])
		)
		.sort();

function keyed(join: LocalizationJoin, identity: typeof Identity.Type) {
	const line = join.lines.find(
		(item) =>
			item.identity?.namespace === identity.namespace && item.identity.key === identity.key
	);
	if (!line) throw new Error(`No line for ${identity.namespace},${identity.key}.`);
	return line;
}

const search = (target: LocalizationJoin["target"]): TextCorpusSearchRequest => ({
	query: "",
	capability: "all",
	pageSize: 50,
	localization: { target }
});

describe.skipIf(!executable)("Game Text problem cases in the saved fixture", () => {
	it("reports every authored case, in memory and from the index, with pinned counts", async () => {
		const cases = Schema.decodeUnknownSync(Schema.fromJsonString(Cases))(
			await readFile(
				join(fixture.root, "FixtureSource/GameTextProblems/expected-cases.json"),
				"utf8"
			)
		);
		const rules = Effect.runSync(
			decodeGameTextRuleDocumentJson(await readFile(join(fixture.root, cases.rules), "utf8"))
		);
		const cacheRoot = await mkdtemp(join(tmpdir(), "ue-shed-game-text-problems-"));
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						// In memory: the reader's package records, as the index reads them (with each
						// Blueprint's compiled copies folded into their places), joined with Unreal's files.
						const corpus: TextCorpus = yield* savedFixtureCorpus(
							fixture.root,
							executable!,
							true
						);
						const evidence = yield* Effect.gen(function* () {
							const service = yield* LocalizationEvidence;
							const discovery = yield* service.discover({
								projectRoot: fixture.root
							});
							const target = discovery.targets.find(
								(item) => item.name === cases.target
							);
							if (!target) throw new Error("The Game target was not discovered.");
							return yield* service.read({ projectRoot: fixture.root, target });
						});
						const joined = joinLocalizationTarget(corpus, evidence, evidence.target);
						const memoryJoin = applyLocalizationKeyChanges(
							joined,
							localizationKeyChanges(joined, corpus).pairs
						);
						const without = checkLocalizationTarget(corpus, memoryJoin, evidence);
						const withRules = checkLocalizationTarget(
							corpus,
							memoryJoin,
							evidence,
							{},
							rules
						);

						// Every authored finding, in the reports it belongs to and only those. Every
						// mismatch is listed at once.
						expect(
							cases.findings.flatMap((expected) => {
								const found = [
									hasFinding(without, expected),
									hasFinding(withRules, expected)
								];
								return found[0] === (expected.rules !== "with") &&
									found[1] === (expected.rules !== "without")
									? []
									: [
											`${expected.case}: ${expected.check} ${expected.culture} without=${found[0]} with=${found[1]}`
										];
							})
						).toEqual([]);
						const source = evaluateGameTextSourceQuality(corpus, rules);
						expect(
							cases.sourceRules.filter((expected) => {
								const unit = corpus.units.find((item) =>
									item.occurrences.some(
										(occurrence) => occurrence.source === expected.source
									)
								);
								return !source.findings.some(
									(finding) =>
										finding.ruleId === expected.ruleId &&
										finding.textUnitId === unit?.id
								);
							})
						).toEqual([]);
						expect({
							without: kindCounts(without),
							with: kindCounts(withRules)
						}).toEqual(cases.counts);
						// Only distinct places share text: the re-keyed row's historical identity
						// is the same place, while the three Back keys remain a genuine group.
						for (const report of [without, withRules])
							expect(
								report.findings
									.filter((finding) => finding.kind === "duplicate_source")
									.map((finding) => finding.actual.source)
							).toEqual(["Back"]);

						// Signals: one key with several texts, stale compiled copies, scope, key
						// changes and partly read packages.
						// Exactly these keys have several texts. The identity cases' own collisions belong to
						// their target.
						expect(
							memoryJoin.lines
								.filter(
									(line) =>
										line.identity?.namespace.startsWith(NAMESPACE_PREFIX) &&
										line.cultures.some((culture) =>
											culture.unknownReasons.includes("conflicting_source")
										)
								)
								.map((line) => line.identity!)
								.sort((a, b) =>
									`${a.namespace},${a.key}`.localeCompare(
										`${b.namespace},${b.key}`
									)
								)
						).toEqual(cases.signals.conflictingSource);
						for (const expected of cases.signals.compiledCopyDiffers) {
							const place = corpus.units
								.flatMap((unit) => unit.occurrences)
								.find((item) => item.location.objectPath === expected.objectPath);
							expect([
								place?.source,
								place && staleRuntimeCopy(place)?.source
							]).toEqual([expected.source, expected.compiledSource]);
						}
						for (const expected of cases.signals.outOfScope) {
							const line = keyed(memoryJoin, expected);
							expect([line.outOfScope, line.audience], expected.key).toEqual([
								expected.reason,
								expected.audience
							]);
						}
						for (const expected of cases.signals.keyChanged) {
							expect(keyed(memoryJoin, expected.from).keyChange?.other).toEqual(
								expected.to
							);
							expect(keyed(memoryJoin, expected.to).keyChange?.other).toEqual(
								expected.from
							);
						}
						expect(
							corpus.diagnostics
								.filter((item) => item.code === "package_partially_decoded")
								.map((item) => item.packageFile?.replace(/\\/gu, "/"))
						).toEqual(cases.signals.partlyRead);

						// The index: the same lines, problems, signals and quality pages.
						const result = yield* (yield* GameTextIndexRefresh).refresh({
							projectRoot: fixture.root,
							targetName: cases.target
						});
						// The index inspects only packages with text; everything else agrees.
						const { inspectedPackages: _indexed, ...indexedCoverage } =
							(yield* result.corpus).coverage;
						const { inspectedPackages: _read, ...readCoverage } = corpus.coverage;
						expect([(yield* result.corpus).status, indexedCoverage]).toEqual([
							corpus.status,
							readCoverage
						]);
						// The index also names the packages without text it skipped.
						const readProblems = (diagnostics: TextCorpus["diagnostics"]) =>
							diagnostics
								.filter((item) => item.code !== "package_not_gatherable")
								.map((item) => [item.code, item.packageFile]);
						expect(readProblems((yield* result.corpus).diagnostics)).toEqual(
							readProblems(corpus.diagnostics)
						);
						expect(lineFacts(yield* result.localizationJoin)).toEqual(
							lineFacts(memoryJoin)
						);
						const memoryQuery = textCorpusQuery(corpus, undefined, memoryJoin);
						const page = yield* result.search(search(memoryJoin.target));
						expect(page.problems).toEqual(
							memoryQuery.search(search(memoryJoin.target)).problems
						);
						for (const expected of cases.signals.compiledCopyDiffers) {
							const unit = corpus.units.find((item) =>
								item.occurrences.some(
									(occurrence) =>
										occurrence.location.objectPath === expected.objectPath
								)
							)!;
							expect(
								(yield* result.query.focus({ id: unit.id, pageSize: 10 }))?.unit
									.reviewSignals
							).toContain("compiled_copy_differs");
						}
						for (const ruleDocument of [undefined, rules]) {
							const indexedSource = ruleDocument
								? evaluateGameTextSourceQuality(yield* result.corpus, ruleDocument)
								: undefined;
							const report = checkLocalizationTarget(
								yield* result.corpus,
								yield* result.localizationJoin,
								result.evidence,
								{},
								ruleDocument
							);
							expect(kindCounts(report)).toEqual(
								ruleDocument ? cases.counts.with : cases.counts.without
							);
							expect(
								report.findings
									.filter((finding) => finding.kind === "duplicate_source")
									.map((finding) => finding.actual.source)
							).toEqual(["Back"]);
							const memory = localizationQualityWorkspace(
								indexedSource,
								report,
								yield* result.localizationJoin
							);
							const indexed = localizationQualityWorkspaceOf(
								indexedSource,
								yield* result.localizationQuality(ruleDocument)
							);
							for (const culture of [
								undefined,
								...(yield* result.localizationJoin).cultures
							])
								for (const filter of BuiltInQualityFilter.literals) {
									const request = {
										target: (yield* result.localizationJoin).target,
										filter,
										...(culture ? { culture } : undefined)
									};
									expect(indexed.search(request)).toEqual(memory.search(request));
									expect(indexed.export(request)).toEqual(memory.export(request));
								}
						}
					})
				).pipe(
					Effect.provide(
						Layer.mergeAll(
							gameTextIndexRefreshLayer(cacheRoot).pipe(
								Layer.provide(gameTextIndexSourceNodeLayer(cacheRoot)),
								Layer.provide(typeScriptIndexBuilderLayer),
								Layer.provide(LocalizationEvidenceNodeLive)
							),
							LocalizationEvidenceNodeLive
						)
					),
					Effect.provide(assetReaderLayer({ executable: executable! }))
				)
			);
		} finally {
			await rm(cacheRoot, { recursive: true, force: true });
		}
	}, 180_000);

	it("matches Unreal's own conflict report for keys with several texts", async () => {
		const cases = Schema.decodeUnknownSync(Schema.fromJsonString(Cases))(
			await readFile(
				join(fixture.root, "FixtureSource/GameTextProblems/expected-cases.json"),
				"utf8"
			)
		);
		const report = await readFile(
			join(fixture.root, "Content/Localization/Game/Game_Conflicts.txt")
		);
		// Unreal writes the report as UTF-16 with a BOM.
		const text = report.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
			? report.subarray(2).toString("utf16le")
			: report.toString("utf8");
		for (const identity of cases.signals.conflictingSource)
			expect(text, identity.key).toContain(`${identity.namespace} - ${identity.key}`);
	});
});
