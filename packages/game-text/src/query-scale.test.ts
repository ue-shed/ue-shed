import { Schema } from "effect";
import {
	LocalizationTarget,
	discoverLocalizationTargets,
	type ArchiveEntry,
	type LocalizationTargetEvidence,
	type ManifestEntry
} from "@ue-shed/localization/browser";
import { describe, expect, it } from "vitest";
import { joinLocalizationTarget } from "./localization.js";
import {
	DEFAULT_GATE_FAILURES,
	LOCALIZATION_GATE_FIELDS,
	localizationGateTarget
} from "./localization-gate.js";
import { derivedLineViews } from "./index-derived-reads.test-support.js";
import {
	archiveEntry,
	corpus,
	evidence,
	manifestEntry,
	success
} from "./localization.test-support.js";
import { textCorpusQuery } from "./query.test-support.js";
import { TextUnit, type TextCorpusSearchRequest } from "./schema.js";

const LINES = 50_000;
const CULTURES = [
	"en",
	"de",
	"fr",
	"es",
	"it",
	"pt-BR",
	"ru",
	"pl",
	"tr",
	"ja",
	"ko",
	"zh-Hans",
	"zh-Hant",
	"ar"
];

/**
 * A generated project at the scale of a shipping game: 50,000 lines across 200 folders and 14
 * cultures, with lines not gathered, changed since gather, untranslated and repeated. Nothing is
 * committed; the corpus is built here.
 */
function largeProject() {
	const discovered = success(
		discoverLocalizationTargets({
			dashboardText: "",
			configs: [
				{
					relativePath: "Config/Localization/Game.ini",
					text:
						"[CommonSettings]\nManifestName=Game.manifest\nNativeCulture=en\n" +
						CULTURES.map((culture) => `CulturesToGenerate=${culture}\n`).join("") +
						"[GatherTextStep0]\nCommandletClass=GatherTextFromAssets\nIncludePathFilters=Content/Text/*\nPackageFileNameFilters=*.uasset\nShouldExcludeDerivedClasses=false\n"
				}
			]
		})
	).targets[0];
	const target = Schema.decodeUnknownSync(LocalizationTarget)(discovered);
	const units: TextUnit[] = [];
	const manifests: ManifestEntry[] = [];
	const archives: ArchiveEntry[] = [];
	for (let index = 0; index < LINES; index++) {
		const key = `Line${index}`;
		// One line in twenty repeats another's text.
		const source = `Line ${index % 20 === 0 ? index + 1 : index}`;
		const table = `Text/Folder${index % 200}/Table${index % 1000}`;
		const objectPath = `/Game/${table}.Table${index % 1000}`;
		units.push(
			Schema.decodeUnknownSync(TextUnit)({
				id: `unit:${key}`,
				source: { status: "consistent", value: source },
				identity: { status: "resolved", namespace: "NS", key },
				occurrences: [
					{
						id: `occurrence:${key}`,
						devNotes: "",
						packageFile: `Content/${table}.uasset`,
						source,
						identity: { status: "resolved", namespace: "NS", key },
						editCapability: "source_editable",
						location: { kind: "string_table_entry", objectPath, entryKey: key }
					}
				]
			})
		);
		if (index % 50 === 0) continue;
		manifests.push(manifestEntry(key, index % 70 === 0 ? "Earlier" : source, objectPath));
		archives.push(archiveEntry(key, source, index % 30 === 0 ? "" : "Translated"));
	}
	const base = evidence(manifests, archives);
	const culture = base.cultures[0];
	if (!culture) throw new Error("The evidence helper produced no culture.");
	const gathered: LocalizationTargetEvidence = {
		...base,
		target,
		cultures: target.cultures.map((code) => ({ ...culture, culture: code }))
	};
	const packages = [
		...new Set(units.flatMap((item) => item.occurrences.map((o) => o.packageFile)))
	];
	const text = {
		...corpus(units),
		packageCoverage: packages.map((packageFile) => ({
			packageFile,
			status: "complete" as const
		}))
	};
	return { text, gathered, target };
}

function timed<A>(run: () => A) {
	const start = performance.now();
	const value = run();
	return { value, ms: performance.now() - start };
}

describe("Game Text at the scale of a shipping game", () => {
	it("joins and pages 50,000 lines in 14 cultures", { timeout: 120_000 }, () => {
		const { text, gathered, target } = largeProject();
		// Loose bounds catch quadratic work (the join once took 30 seconds here) without
		// failing on a slow machine; the plan's evidence records the measured times.
		const join = timed(() => joinLocalizationTarget(text, gathered, target));
		expect(join.ms).toBeLessThan(15_000);
		const query = textCorpusQuery(text, undefined, join.value);
		const request: TextCorpusSearchRequest = {
			query: "",
			capability: "all",
			pageSize: 50,
			localization: { target: target.name }
		};
		query.search(request);
		const plain = timed(() => query.search(request));
		const filtered = query.search({
			...request,
			filter: [
				{ field: "problem", op: "is", values: ["translation", "not_gathered"] },
				{ field: "folder", op: "is_not", values: ["Content/Text/Folder0/"] }
			]
		});
		expect(plain.value.total).toBe(LINES);
		expect(plain.value.problems).toEqual({
			key_changed: 0,
			conflicting_source: 0,
			not_gathered: 1000,
			changed_since_gather: 572,
			translation: 1142,
			finding: 5000,
			up_to_date: 43643
		});
		// Folder0 holds every 200th line from index 0: 250 lines, none of them gathered yet.
		expect(filtered.total).toBe(1000 + 1142 - 250);
		expect(plain.ms).toBeLessThan(5_000);
		// Filtering, grouping and gating do different work from the unfiltered search. A single
		// search's duration is not a stable baseline for their relative performance under CI load.

		// Groups and facets stay bounded: 1,000 tables and 200 folders.
		const grouped = query.search({
			...request,
			group: "asset",
			facets: { folder: "Content/Text", assets: true, origins: true, cultures: true }
		});
		const groups = grouped.groups;
		expect(groups?.entries).toHaveLength(200);
		expect(groups?.more).toBe(800);
		expect(groups?.entries[0]?.worst).toBe("not_gathered");
		expect(grouped.facets?.folders?.entries).toHaveLength(200);
		expect(grouped.facets?.cultures).toHaveLength(CULTURES.length);
		const open = groups?.entries[0];
		if (open === undefined) throw new Error("No groups at scale.");
		const opened = query.search({ ...request, group: "asset", openGroup: open.key });
		expect(opened.localization?.lines).toHaveLength(Math.min(50, open.count));

		// Checking a change that touches every table costs a handful of searches.
		const files = Array.from(
			{ length: 1000 },
			(_, index) => `Content/Text/Folder${index % 200}/Table${index}.uasset`
		);
		const scoped = { ...request, where: { files } };
		const fileScope = query.search({ ...scoped, pageSize: 1 }).fileScope;
		const gate = localizationGateTarget({
			lines: derivedLineViews(
				{
					lines: (selected) => query.localizationLines(selected),
					search: (selected) => query.search(selected),
					corpus: () => text,
					cultures: join.value.cultures
				},
				scoped,
				LOCALIZATION_GATE_FIELDS
			),
			...(fileScope === undefined ? undefined : { fileScope }),
			join: join.value,
			files,
			failOn: DEFAULT_GATE_FAILURES
		});
		expect(gate.lines).toBe(LINES);
		expect(gate.checks.not_gathered).toBe(1000);
		expect(gate.checks.translated_text_changed + gate.checks.text_changed).toBe(572);
		expect(gate.items).toHaveLength(200);
	});
});
