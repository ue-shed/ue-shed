import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
	LocalizationError,
	LocalizationTarget,
	LocalizationTargetEvidence,
	parseDashboardTargets
} from "@ue-shed/localization/browser";
import {
	joinLocalizationTarget,
	localizationGatherCoverage,
	matchesUnrealWildcard
} from "./localization.js";
import { LocalizationJoin } from "./localization-schema.js";
import { TextUnit } from "./schema.js";
import {
	archiveEntry,
	corpus,
	evidence,
	manifestEntry,
	poDocument,
	success,
	target,
	unit
} from "./localization.test-support.js";

function mark(textCorpus = corpus(), files = evidence()) {
	const join = joinLocalizationTarget(textCorpus, files);
	Schema.decodeUnknownSync(LocalizationJoin)(join);
	const result = join.lines[0]?.cultures[0];
	if (!result) throw new Error("Expected one localization state.");
	return result;
}

function configureGather(includes: readonly string[], excludes: readonly string[]) {
	return Schema.decodeUnknownSync(LocalizationTarget)({
		...target,
		configs: target.configs.map((config) => ({
			...config,
			steps: config.steps.map((step) => ({
				...step,
				fields: {
					...step.fields,
					IncludePathFilters: includes,
					ExcludePathFilters: excludes
				}
			}))
		}))
	});
}

describe("localization identity join and precedence", () => {
	it("evaluates translated and native cultures from the archive", () => {
		expect(mark().state).toBe("translated");
		expect(
			mark(
				corpus(),
				evidence(
					[manifestEntry()],
					[archiveEntry("K", "Source", "Source")],
					poDocument("Source")
				)
			).state
		).toBe("translated");
	});
	it("classifies absent and empty translations", () => {
		expect(mark(corpus(), evidence([manifestEntry()], [], poDocument(""))).state).toBe(
			"not_translated"
		);
		expect(
			mark(
				corpus(),
				evidence([manifestEntry()], [archiveEntry("K", "Source", "")], poDocument(""))
			).state
		).toBe("not_translated");
	});
	it("compares recorded archive source exactly, including source metadata", () => {
		expect(mark(corpus(), evidence([manifestEntry()], [archiveEntry("K", "Old")])).state).toBe(
			"needs_update"
		);
		const metadataSource = {
			...archiveEntry(),
			source: { Text: "Source", Context: "Different" }
		};
		expect(mark(corpus(), evidence([manifestEntry()], [metadataSource])).state).toBe(
			"needs_update"
		);
	});
	it("a PO translation from any tool takes precedence over outdated archives", () => {
		const result = mark(
			corpus(),
			evidence([manifestEntry()], [archiveEntry("K", "Old")], poDocument("New translation"))
		);
		expect(result.state).toBe("not_synced");
		expect(result.facts).toContain("needs_update");
		expect(
			mark(corpus(), evidence([manifestEntry()], [], poDocument("New translation"))).state
		).toBe("not_synced");
	});
	it("current-source drift precedes translation facts and retains them", () => {
		const result = mark(
			corpus([unit("K", "Changed")]),
			evidence([manifestEntry()], [archiveEntry()], poDocument("New translation"))
		);
		expect(result.state).toBe("changed_since_gather");
		expect(result.facts).toContain("not_synced");
	});
	it("observed identity inside the gather paths is not gathered", () => {
		expect(mark(corpus(), evidence([])).state).toBe("not_gathered");
	});
	it("outside target precedes gather and translation facts", () => {
		expect(mark(corpus([unit("K", "Changed", "Content/Elsewhere/Table.uasset")])).state).toBe(
			"outside_target"
		);
	});
	it("proves not found only in a fully read package, including zero-text packages", () => {
		expect(mark(corpus([])).state).toBe("not_found");
		for (const status of ["partial", "failed"] satisfies NonNullable<
			ReturnType<typeof corpus>["packageCoverage"]
		>[number]["status"][]) {
			const result = mark({
				...corpus([]),
				packageCoverage: [{ packageFile: "Content/Text/Table.uasset", status }]
			});
			expect(result.state).toBe("unknown");
			expect(result.unknownReasons).toContain(
				status === "partial" ? "package_partial" : "package_failed"
			);
		}
		const result = mark({ ...corpus([]), packageCoverage: [] });
		expect(result.state).toBe("unknown");
		expect(result.unknownReasons).toContain("package_not_scanned");
	});
	it("C++ and config source paths produce distinct evidence-only identities", () => {
		const joined = joinLocalizationTarget(
			corpus([]),
			evidence([manifestEntry("K", "Source", "Source/Text.cpp(10)")])
		);
		expect(joined.lines[0]?.cultures[0]?.state).toBe("gathered_only");
		expect(joined.lines[0]?.origin.kind).toBe("evidence");
		if (joined.lines[0]?.origin.kind === "evidence")
			expect(joined.lines[0].origin.id).toMatch(/^evidence:/u);
	});
	it("never links two equal sources under different keys", () => {
		const joined = joinLocalizationTarget(
			corpus([unit("A"), unit("B")]),
			evidence([manifestEntry("A")], [archiveEntry("A")], poDocument(""))
		);
		expect(joined.lines.find((line) => line.identity?.key === "A")?.cultures[0]?.state).toBe(
			"translated"
		);
		expect(joined.lines.find((line) => line.identity?.key === "B")?.cultures[0]?.state).toBe(
			"not_gathered"
		);
	});
	it("Crowdin joins msgid identity and marks reduced source checking", () => {
		const result = mark(
			corpus(),
			evidence(
				[manifestEntry()],
				[archiveEntry()],
				poDocument("Crowdin translation", "Crowdin")
			)
		);
		expect(result.state).toBe("not_synced");
		expect(result.reducedSourceChecking).toBe(true);
	});
	it("unavailable or duplicate evidence has typed reasons", () => {
		const files = evidence();
		const missing = Schema.decodeUnknownSync(LocalizationTargetEvidence)({
			...files,
			manifest: { ...files.locmeta, status: "failed" }
		});
		expect(mark(corpus(), missing).unknownReasons).toContain("missing_manifest");
		expect(
			mark(corpus(), evidence([manifestEntry(), manifestEntry()])).unknownReasons
		).toContain("duplicate_manifest_identity");
		expect(
			mark(corpus(), evidence([manifestEntry()], [archiveEntry(), archiveEntry()]))
				.unknownReasons
		).toContain("duplicate_archive_identity");
		const missingCulture = { ...files, cultures: [] };
		expect(mark(corpus(), missingCulture).unknownReasons).toEqual([
			"missing_archive",
			"missing_po"
		]);
	});
	it("detects duplicate PO identity and incomplete identity/corpus contracts", () => {
		const po = poDocument();
		expect(
			mark(
				corpus(),
				evidence([manifestEntry()], [archiveEntry()], {
					...po,
					blocks: [...po.blocks, ...po.blocks]
				})
			).unknownReasons
		).toContain("duplicate_po_identity");
		const unresolved = Schema.decodeUnknownSync(TextUnit)({
			...unit(),
			identity: { status: "unresolved", reason: "culture_invariant" }
		});
		expect(
			joinLocalizationTarget(corpus([unresolved]), evidence([])).lines[0]?.cultures[0]
				?.unknownReasons
		).toContain("unresolved_identity");
		const reference = Schema.decodeUnknownSync(TextUnit)({
			...unit(),
			identity: { status: "string_table", tableId: "/Game/Missing.Missing", key: "K" }
		});
		expect(
			joinLocalizationTarget(corpus([reference]), evidence([])).lines[0]?.cultures[0]
				?.unknownReasons
		).toContain("string_table_namespace_unavailable");
		const conflicted = {
			...unit(),
			occurrences: [...unit().occurrences, ...unit("K", "Other").occurrences]
		};
		expect(mark(corpus([conflicted])).unknownReasons).toContain("conflicting_source");
		const unavailable = { ...evidence(), target: { ...target, configs: [] } };
		expect(mark(corpus(), unavailable).unknownReasons).toContain("gather_settings_unavailable");
		const collapsed = Schema.decodeUnknownSync(LocalizationTargetEvidence)({
			...evidence(),
			target: { ...target, collapseMode: "IdenticalNamespaceAndSource" }
		});
		expect(mark(corpus(), collapsed).unknownReasons).toContain("ambiguous_po_identity");
	});
	it("resolves String Table references by table namespace and entry key", () => {
		const own = unit();
		const reference = Schema.decodeUnknownSync(TextUnit)({
			...unit(),
			id: "reference",
			occurrences: unit("K", "").occurrences,
			identity: { status: "string_table", tableId: "/Game/Text/Table.Table", key: "K" }
		});
		const joined = joinLocalizationTarget(corpus([own, reference]), evidence());
		expect(joined.lines).toHaveLength(1);
		expect(joined.lines[0]?.identity).toMatchObject({ namespace: "NS", key: "K" });
		expect(joined.lines[0]?.cultures[0]?.state).toBe("translated");
	});
	it("distinguishes confirmed file absence from unreadable evidence", () => {
		const files = evidence();
		const missingArchive = Schema.decodeUnknownSync(LocalizationTargetEvidence)({
			...files,
			cultures: files.cultures.map((culture) => ({ ...culture, archive: files.locmeta }))
		});
		expect(mark(corpus(), missingArchive).state).toBe("not_synced");
		const missingPO = Schema.decodeUnknownSync(LocalizationTargetEvidence)({
			...files,
			cultures: files.cultures.map((culture) => ({ ...culture, po: files.locmeta }))
		});
		expect(mark(corpus(), missingPO).state).toBe("translated");
		const unreadable = Schema.decodeUnknownSync(LocalizationTargetEvidence)({
			...files,
			cultures: files.cultures.map((culture) => ({
				...culture,
				archive: {
					status: "failed",
					relativePath: null,
					error: new LocalizationError({
						code: "file_unreadable",
						message: "Evidence is unreadable.",
						recovery: "Repair file access."
					})
				}
			}))
		});
		expect(mark(corpus(), unreadable).state).toBe("unknown");
		expect(mark(corpus(), unreadable).facts).not.toContain("not_synced");
	});
	it("a match elsewhere does not prove the original package still contains an identity", () => {
		expect(mark(corpus([unit("K", "Source", "Content/Text/Other.uasset")])).state).toBe(
			"not_found"
		);
	});
});

describe("Unreal gather wildcard coverage", () => {
	it.each([
		["Content/Text/Table.uasset", "inside"],
		["Content/Text/Excluded/Table.uasset", "outside"],
		["Content/Localization/Table.uasset", "outside"],
		["Content/L10N/de/Table.uasset", "outside"]
	])("resolves Dashboard token filters for %s", (packageFile, status) => {
		const configured = configureGather(
			["%LOCPROJECTROOT%Content/*"],
			[
				"%LOCPROJECTROOT%Content/Text/Excluded/*",
				"Content/Localization/*",
				"%LOCPROJECTROOT%Content/L10N/*"
			]
		);
		const occurrence = unit("K", "Source", packageFile).occurrences[0];
		if (!occurrence) throw new Error("Missing test occurrence.");
		expect(localizationGatherCoverage(configured, occurrence)).toEqual({ status });
	});
	it.each(["%LOCPROJECTROOT%/", "%locprojectroot%\\"])(
		"resolves case and slash direction in %s",
		(prefix) => {
			const configured = configureGather([`${prefix}Content\\Text\\*`], []);
			const occurrence = unit().occurrences[0];
			if (!occurrence) throw new Error("Missing test occurrence.");
			expect(localizationGatherCoverage(configured, occurrence)).toEqual({
				status: "inside"
			});
			expect(
				joinLocalizationTarget(corpus(), evidence(), configured).lines[0]?.cultures[0]
					?.state
			).toBe("translated");
		}
	);
	it.each([
		[["%LOCENGINEROOT%Content/*"], [], "outside"],
		[["%LOCENGINEROOT%Content/*", "Content/Text/*"], [], "inside"],
		[["Content/Text/*"], ["%LOCENGINEROOT%Content/Text/*"], "inside"]
	] satisfies readonly [readonly string[], readonly string[], string][])(
		"ignores engine tokens in includes %j and excludes %j",
		(includes, excludes, status) => {
			const occurrence = unit().occurrences[0];
			if (!occurrence) throw new Error("Missing test occurrence.");
			expect(
				localizationGatherCoverage(configureGather(includes, excludes), occurrence)
			).toEqual({
				status
			});
		}
	);
	it.each([
		[["%FOO%Content/*"], []],
		[["Content/*"], ["%FOO%Content/Excluded/*"]],
		[["Content/%FOO%/*"], []],
		[["%LOCPROJECTROOT%../Content/*"], []],
		[["%LOCPROJECTROOT%/D:/Content/*"], []]
	] satisfies readonly [readonly string[], readonly string[]][])(
		"qualifies unresolved includes %j and excludes %j",
		(includes, excludes) => {
			const occurrence = unit().occurrences[0];
			if (!occurrence) throw new Error("Missing test occurrence.");
			expect(
				localizationGatherCoverage(configureGather(includes, excludes), occurrence)
			).toEqual({
				status: "unknown",
				reason: "gather_settings_unavailable"
			});
		}
	);
	it("preserves Dashboard settings coverage and its Engine-root uncertainty", () => {
		const parsed = success(
			parseDashboardTargets(
				readFileSync(
					new URL(
						"../../../fixtures/unreal-project/Config/DefaultEditor.ini",
						import.meta.url
					),
					"utf8"
				)
			)
		);
		const dashboard = parsed.targets.find((item) => item.name === "FixtureGame");
		const occurrence = unit("K", "Source", "Content/Fixture/Localization/Table.uasset")
			.occurrences[0];
		if (!dashboard || !occurrence) throw new Error("Missing test Dashboard or occurrence.");
		const configured = Schema.decodeUnknownSync(LocalizationTarget)({
			...target,
			configs: [],
			dashboard
		});
		expect(localizationGatherCoverage(configured, occurrence)).toEqual({ status: "inside" });
		const engineRoot = Schema.decodeUnknownSync(LocalizationTarget)({
			...configured,
			dashboard: {
				...dashboard,
				settings: {
					...dashboard.settings,
					GatherFromPackages: {
						...dashboard.settings.GatherFromPackages,
						ExcludePathWildcards: [{ PathRoot: "Engine", Pattern: "Content/*" }]
					}
				}
			}
		});
		expect(localizationGatherCoverage(engineRoot, occurrence)).toEqual({
			status: "unknown",
			reason: "gather_settings_unavailable"
		});
	});
	it.each([
		["Content/Text/A.uasset", "content/*", true],
		["Content/Text/A.uasset", "Content/*.uasset", true],
		["AB", "A?B", true],
		["AXB", "A?B", true],
		["AXXB", "A?B", false],
		["A+B", "A+B", true],
		["AAAB", "A+B", false]
	] satisfies readonly [string, string, boolean][])(
		"matches %s against %s",
		(value, pattern, expected) => {
			expect(matchesUnrealWildcard(value, pattern)).toBe(expected);
		}
	);
	it("narrow includes outrank broad excludes, and excludes win ties", () => {
		const occurrence = unit().occurrences[0];
		if (!occurrence) throw new Error("Missing test occurrence.");
		expect(
			localizationGatherCoverage(
				configureGather(["Content/Text/*"], ["Content/*"]),
				occurrence
			).status
		).toBe("inside");
		expect(
			localizationGatherCoverage(
				configureGather(["Content/Text/*"], ["Content/Text/*"]),
				occurrence
			).status
		).toBe("outside");
	});
	it("excludes extensions and explicit classes and qualifies unavailable ancestry", () => {
		const occurrence = unit().occurrences[0];
		if (!occurrence) throw new Error("Missing test occurrence.");
		expect(
			localizationGatherCoverage(target, {
				...occurrence,
				packageFile: "Content/Text/Table.txt"
			}).status
		).toBe("outside");
		const excluded = (name: string, derived: boolean) =>
			Schema.decodeUnknownSync(LocalizationTarget)({
				...target,
				configs: target.configs.map((config) => ({
					...config,
					steps: config.steps.map((step) => ({
						...step,
						fields: {
							...step.fields,
							ExcludeClasses: [name],
							ShouldExcludeDerivedClasses: derived
						}
					}))
				}))
			});
		expect(localizationGatherCoverage(excluded("StringTable", false), occurrence).status).toBe(
			"outside"
		);
		expect(localizationGatherCoverage(excluded("OtherClass", true), occurrence)).toEqual({
			status: "unknown",
			reason: "class_hierarchy_unavailable"
		});
		expect(
			localizationGatherCoverage(excluded("DataTable", false), {
				...occurrence,
				location: {
					kind: "data_table_cell",
					objectPath: "/Game/Text/Table.Table",
					row: "Row",
					propertyPath: "Text"
				}
			})
		).toEqual({ status: "unknown", reason: "asset_class_unavailable" });
		expect(
			localizationGatherCoverage(target, {
				...occurrence,
				packageFile: "/outside/Table.uasset"
			})
		).toEqual({ status: "unknown", reason: "path_not_project_relative" });
	});
});
