import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
	LocalizationError,
	localizationEvidenceFingerprint,
	LocalizationTarget,
	LocalizationTargetEvidence,
	parseDashboardTargets,
	type PODocument
} from "@ue-shed/localization/browser";
import {
	joinLocalizationTarget,
	localizationGatherCoverage,
	matchesUnrealWildcard
} from "./localization.js";
import { LocalizationJoin } from "./localization-schema.js";
import { TextUnit } from "./schema.js";
import { buildTextCorpus } from "./corpus.js";
import type { SavedAssetInspection } from "@ue-shed/unreal-assets";
import { localizationLinesCsv } from "./localization-export.js";
import { localizationLineUnits } from "./gathered-text.js";
import { localizationLineFingerprint } from "./localization-review.js";
import { textCorpusQuery } from "./query.js";
import {
	archiveEntry,
	corpus,
	evidence,
	ftextUnit,
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

function mixedCorpus(
	reverse: boolean,
	kind: "asset_property" | "data_table_cell",
	savedSource = "Source"
) {
	const property = {
		name: "Label",
		type: "TextProperty",
		value_kind: "text" as const,
		value: savedSource,
		history: "base" as const,
		namespace: "UI [Beta]",
		key: "K"
	};
	const table: SavedAssetInspection["assets"][number] = {
		kind: "StringTable",
		object_path: "/Game/Text/Table.Table",
		string_table_namespace: "UI [Beta]",
		string_table_metadata: {},
		string_table_entries: [{ key: "K", source: "Source", dev_notes: "" }]
	};
	const saved: SavedAssetInspection["assets"][number] =
		kind === "asset_property"
			? {
					kind: "UObject",
					object_path: "/Game/Text/Base.Base",
					class_path: "/Script/Engine.DataAsset",
					properties: [property]
				}
			: {
					kind: "DataTable",
					object_path: "/Game/Text/Base.Base",
					row_struct: "/Script/Test.TextRow",
					row_count: 1,
					rows: [{ name: "Greeting", properties: [property] }]
				};
	const inspections = [table, saved].map(
		(asset): SavedAssetInspection => ({
			schema_version: 8,
			status: "ok",
			path: `Content/Text/${asset.kind === "StringTable" ? "Table" : "Base"}.uasset`,
			package: {
				name: asset.object_path.split(".")[0] ?? "",
				version: { legacy_file: -9, legacy_ue3: 0, ue4: 522, ue5: 1018, licensee: 0 },
				package_flags: 0,
				summary_size: 1,
				total_header_size: 1
			},
			assets: [asset],
			decode_errors: []
		})
	);
	return buildTextCorpus(
		(reverse ? inspections.reverse() : inspections).map((inspection) => ({
			status: "inspected",
			packageFile: inspection.path,
			inspection
		}))
	);
}

describe("localization identity join and precedence", () => {
	it.each<[string, string, PODocument["format"]]>([
		["[PKG]", "", "Unreal"],
		["MyNamespace [PKG]", "MyNamespace", "Unreal"],
		["[A] [B]", "[A]", "Unreal"],
		["[PKG]", "", "Crowdin"],
		["MyNamespace [PKG]", "MyNamespace", "Crowdin"]
	])("joins saved namespace %j to gathered namespace %j (%s)", (saved, gathered, format) => {
		const text = corpus([ftextUnit("K", "Source", "Content/Text/Table.uasset", saved)]);
		const joined = joinLocalizationTarget(
			text,
			evidence(
				[manifestEntry("K", "Source", "/Game/Text/Table.Table", gathered)],
				[archiveEntry("K", "Source", "Translation", gathered)],
				poDocument("Translation", format, gathered)
			)
		);
		expect(joined.lines).toHaveLength(1);
		expect(joined.lines[0]?.identity).toEqual({ namespace: gathered, key: "K" });
		expect(joined.lines[0]?.cultures.map((culture) => culture.state)).toEqual([
			"translated",
			"translated"
		]);
		expect(joined.lines[0]?.cultures[0]?.po?.identity?.namespace).toBe(gathered);
		expect(text.units[0]?.identity).toMatchObject({ namespace: saved });
		expect(text.units[0]?.occurrences[0]?.identity).toMatchObject({ namespace: saved });
	});

	it("merges package variants and keeps conflicting sources visible", () => {
		const first = ftextUnit("K", "Source", "Content/Text/Table.uasset", "NS [A]");
		const second = TextUnit.make({
			...ftextUnit("K", "Other", "Content/Text/Other.uasset", "NS [B]", "data_table_cell"),
			id: TextUnit.fields.id.make("unit:other")
		});
		const joined = joinLocalizationTarget(corpus([first, second]), evidence());
		expect(joined.lines).toHaveLength(1);
		expect(joined.lines[0]?.origin).toMatchObject({
			kind: "corpus",
			unitIds: [first.id, second.id]
		});
		expect(joined.lines[0]?.cultures[0]?.unknownReasons).toContain("conflicting_source");
	});

	it.each(["Source", "Other"])(
		"keeps distinct authored String Table namespaces separate in lines and findings (%s)",
		(secondSource) => {
			const first = unit("K", "Source", "Content/Text/Table.uasset", "UI [A]");
			const other = unit("K", secondSource, "Content/Text/Other.uasset", "UI [B]");
			const second = TextUnit.make({
				...other,
				id: TextUnit.fields.id.make("unit:other"),
				occurrences: other.occurrences.map((occurrence) => ({
					...occurrence,
					location: {
						kind: "string_table_entry",
						objectPath: "/Game/Text/Other.Other",
						entryKey: "K"
					}
				}))
			});
			const text = corpus([first, second]);
			const joined = joinLocalizationTarget(
				text,
				evidence(
					[
						manifestEntry("K", "Source", "/Game/Text/Table.Table", "UI [A]"),
						manifestEntry("K", secondSource, "/Game/Text/Other.Other", "UI [B]")
					],
					[],
					poDocument("", "Unreal", "UI [A]")
				)
			);
			expect(joined.lines).toHaveLength(2);
			expect(joined.lines.map((line) => line.identity)).toEqual([
				{ namespace: "UI [A]", key: "K" },
				{ namespace: "UI [B]", key: "K" }
			]);
			const page = textCorpusQuery(text).search({
				capability: "all",
				query: "",
				pageSize: 50
			});
			expect(page.counts.shared).toBe(0);
			expect(page.counts.conflicting).toBe(0);
			expect(page.counts.duplicate_source).toBe(secondSource === "Source" ? 2 : 0);
		}
	);

	it.each([
		[false, "asset_property"],
		[true, "asset_property"],
		[false, "data_table_cell"],
		[true, "data_table_cell"]
	] as const)("joins each identity in a mixed unit (%s, %s)", (reverse, kind) => {
		const text = mixedCorpus(reverse, kind);
		const mixed = text.units[0];
		if (!mixed) throw new Error("Missing mixed unit.");
		expect(text.units).toHaveLength(1);
		expect(mixed.id).toBe("unreal:UI%20%5BBeta%5D:K");
		expect(mixed.identity).toEqual({ status: "resolved", namespace: "UI [Beta]", key: "K" });
		const namespaces = ["UI [Beta]", "UI"];
		const po = poDocument("Translation", "Unreal", "UI [Beta]");
		const files = evidence(
			namespaces.map((namespace) =>
				manifestEntry(
					"K",
					"Source",
					namespace === "UI" ? "/Game/Text/Base.Base" : "/Game/Text/Table.Table",
					namespace
				)
			),
			namespaces.map((namespace) => archiveEntry("K", "Source", "Translation", namespace)),
			{ ...po, blocks: [...po.blocks, ...poDocument("Translation", "Unreal", "UI").blocks] }
		);
		const joined = joinLocalizationTarget(text, files);
		Schema.decodeUnknownSync(LocalizationJoin)(joined);
		expect(joined.lines).toHaveLength(2);
		const units = new Map(text.units.map((unit) => [unit.id, unit]));
		for (const line of joined.lines) {
			expect(line.origin).toEqual({ kind: "corpus", unitIds: [mixed.id] });
			expect(line.cultures.map((culture) => culture.state)).toEqual([
				"translated",
				"translated"
			]);
			expect(localizationLineUnits(line, units).flatMap((unit) => unit.occurrences)).toEqual(
				mixed.occurrences.filter((occurrence) =>
					line.identity?.namespace === "UI"
						? occurrence.location.kind === kind
						: occurrence.location.kind === "string_table_entry"
				)
			);
			for (const culture of line.cultures) {
				expect(culture.facts).not.toContain("not_found");
				expect(culture.facts).not.toContain("not_gathered");
				expect(culture.archive?.namespace).toBe(line.identity?.namespace);
				expect(culture.po?.identity?.namespace).toBe(line.identity?.namespace);
				if (!line.identity) throw new Error("Missing gathered identity.");
				expect(localizationLineFingerprint(line, culture)).toBe(
					localizationEvidenceFingerprint(files, culture.culture, line.identity)
				);
			}
		}
		const query = textCorpusQuery(text, undefined, joined);
		const request = { capability: "all" as const, query: "", pageSize: 50 };
		expect(query.search(request).counts).toMatchObject({
			shared: 0,
			conflicting: 0,
			duplicate_source: 1
		});
		for (const line of joined.lines) {
			const page = query.search({
				...request,
				localization: { target: target.name },
				lines: [line.id]
			});
			expect(page.units[0]?.id).toBe(mixed.id);
			expect(page.units[0]?.occurrenceCount).toBe(1);
			expect(page.units[0]?.locationKinds).toEqual([
				line.identity?.namespace === "UI" ? kind : "string_table_entry"
			]);
			expect(page.counts).toMatchObject({ shared: 0, conflicting: 0, duplicate_source: 1 });
		}
		const { csv } = localizationLinesCsv({ join: joined, lines: joined.lines, corpus: text });
		expect(csv).toContain('"UI [Beta]","K","Source","/Game/Text/Table.Table","String table"');
		expect(csv).toContain(
			`"UI","K","Source","/Game/Text/Base.Base","${kind === "asset_property" ? "Asset" : "Data table"}"`
		);
		expect(query.export({ ...request, localization: { target: target.name } }).units).toEqual(
			text.units
		);
	});

	it("keeps sources on different gathered identities from conflicting within a mixed unit", () => {
		const text = mixedCorpus(false, "asset_property", "Other");
		const page = textCorpusQuery(text).search({ capability: "all", query: "", pageSize: 50 });
		expect(page.counts).toMatchObject({ shared: 0, conflicting: 0, duplicate_source: 0 });
		const joined = joinLocalizationTarget(
			text,
			evidence([
				manifestEntry("K", "Source", "/Game/Text/Table.Table", "UI [Beta]"),
				manifestEntry("K", "Other", "/Game/Text/Base.Base", "UI")
			])
		);
		for (const line of joined.lines) {
			expect(line.source).toBe(line.identity?.namespace === "UI" ? "Other" : "Source");
			expect(line.cultures[0]?.unknownReasons).not.toContain("conflicting_source");
			expect(line.cultures[0]?.facts).not.toContain("changed_since_gather");
		}
	});

	it.each([false, true])(
		"resolves a mixed unit's table reference by authored identity (%s)",
		(reverse) => {
			const text = mixedCorpus(reverse, "asset_property");
			const saved = ftextUnit("Ref", "", "Content/Text/Reference.uasset");
			const identity = {
				status: "string_table" as const,
				tableId: "/Game/Text/Table.Table",
				key: "K"
			};
			const reference = TextUnit.make({
				...saved,
				identity,
				occurrences: saved.occurrences.map((occurrence) => ({ ...occurrence, identity }))
			});
			const joined = joinLocalizationTarget(
				{ ...text, units: [...text.units, reference] },
				evidence([
					manifestEntry("K", "Source", "/Game/Text/Table.Table", "UI [Beta]"),
					manifestEntry("K", "Source", "/Game/Text/Base.Base", "UI")
				])
			);
			expect(joined.lines).toHaveLength(2);
			for (const line of joined.lines) {
				if (line.origin.kind !== "corpus") throw new Error("Missing corpus origin.");
				expect(line.origin.unitIds.includes(reference.id)).toBe(
					line.identity?.namespace === "UI [Beta]"
				);
				expect(line.source).toBe("Source");
				expect(line.cultures[0]?.unknownReasons).not.toContain("conflicting_source");
			}
		}
	);

	it("finds shared and conflicting FText across a mixed unit and a package variant", () => {
		const text = mixedCorpus(false, "data_table_cell");
		const other = TextUnit.make({
			...ftextUnit("K", "Other", "Content/Text/Other.uasset", "UI [Other]"),
			id: TextUnit.fields.id.make("unit:other")
		});
		const joined = joinLocalizationTarget(
			{ ...text, units: [...text.units, other] },
			evidence()
		);
		const query = textCorpusQuery(
			{ ...text, units: [...text.units, other] },
			undefined,
			joined
		);
		const request = { capability: "all" as const, query: "", pageSize: 50 };
		expect(query.search(request).counts).toMatchObject({
			shared: 2,
			conflicting: 2,
			duplicate_source: 1
		});
		expect(query.focus({ id: other.id, pageSize: 50 })?.unit.reviewSignals).not.toContain(
			"duplicate_source"
		);
		for (const line of joined.lines.filter((line) => line.origin.kind === "corpus")) {
			const page = query.search({
				...request,
				localization: { target: target.name },
				lines: [line.id]
			});
			expect(page.counts.shared).toBe(line.identity?.namespace === "UI" ? 1 : 0);
			expect(page.counts.conflicting).toBe(line.identity?.namespace === "UI" ? 1 : 0);
		}
	});

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
			identity: { status: "unresolved", reason: "culture_invariant" },
			occurrences: unit().occurrences.map((occurrence) => ({
				...occurrence,
				identity: { status: "unresolved", reason: "culture_invariant" }
			}))
		});
		expect(
			joinLocalizationTarget(corpus([unresolved]), evidence([])).lines[0]?.cultures[0]
				?.unknownReasons
		).toContain("unresolved_identity");
		const reference = Schema.decodeUnknownSync(TextUnit)({
			...unit(),
			identity: { status: "string_table", tableId: "/Game/Missing.Missing", key: "K" },
			occurrences: unit().occurrences.map((occurrence) => ({
				...occurrence,
				identity: { status: "string_table", tableId: "/Game/Missing.Missing", key: "K" }
			}))
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
	it("keeps authored String Table namespaces when resolving references and joining evidence", () => {
		const own = unit("K", "Source", "Content/Text/Table.uasset", "UI [Beta]");
		const identity = {
			status: "string_table" as const,
			tableId: "/Game/Text/Table.Table",
			key: "K"
		};
		const saved = ftextUnit("K", "", "Content/Text/Reference.uasset");
		const reference = Schema.decodeUnknownSync(TextUnit)({
			...saved,
			id: "reference",
			occurrences: saved.occurrences.map((occurrence) => ({ ...occurrence, identity })),
			identity
		});
		const joined = joinLocalizationTarget(
			corpus([own, reference]),
			evidence(
				[manifestEntry("K", "Source", "/Game/Text/Table.Table", "UI [Beta]")],
				[archiveEntry("K", "Source", "Translation", "UI [Beta]")],
				poDocument("Translation", "Unreal", "UI [Beta]")
			)
		);
		expect(joined.lines).toHaveLength(1);
		expect(joined.lines[0]?.identity).toEqual({ namespace: "UI [Beta]", key: "K" });
		expect(joined.lines[0]?.origin).toMatchObject({ unitIds: [own.id, reference.id].sort() });
		expect(joined.lines[0]?.cultures.map((culture) => culture.state)).toEqual([
			"translated",
			"translated"
		]);
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
