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
	archiveEntry,
	corpus,
	evidence,
	manifestEntry,
	success
} from "./localization.test-support.js";
import { TextUnit } from "./schema.js";

const scaleLane = process.env.UE_SHED_GAME_TEXT_SCALE === "1";
const LINES = scaleLane ? 50_000 : 5_000;
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
	const base = evidence(
		manifests,
		archives,
		undefined,
		archives.map((entry) => ({ ...entry, translation: entry.source }))
	);
	const culture = base.cultures[0];
	const foreignCulture = base.cultures[1];
	if (!culture || !foreignCulture) throw new Error("The evidence helper produced no culture.");
	const gathered: LocalizationTargetEvidence = {
		...base,
		target,
		cultures: target.cultures.map((code) => ({
			...(code === target.nativeCulture ? culture : foreignCulture),
			culture: code
		}))
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
	it(`joins ${LINES.toLocaleString("en-US")} lines in 14 cultures`, { timeout: 120_000 }, () => {
		const { text, gathered, target } = largeProject();
		// Loose bounds catch quadratic work (the join once took 30 seconds here) without
		// failing on a slow machine.
		const join = timed(() => joinLocalizationTarget(text, gathered, target));
		if (scaleLane) expect(join.ms).toBeLessThan(15_000);
		const rows = Array.from({ length: LINES }, (_, index) => index);
		const notGathered = rows.filter((index) => index % 50 === 0).length;
		const changed = rows.filter((index) => index % 50 !== 0 && index % 70 === 0).length;
		const untranslated = rows.filter(
			(index) => index % 50 !== 0 && index % 70 !== 0 && index % 30 === 0
		).length;
		const states = (culture: string) => {
			const counts: Record<string, number> = {};
			for (const line of join.value.lines) {
				const state = line.cultures.find((mark) => mark.culture === culture)?.state;
				if (state !== undefined) counts[state] = (counts[state] ?? 0) + 1;
			}
			return counts;
		};
		expect(join.value.cultures).toEqual(CULTURES);
		expect(join.value.lines).toHaveLength(LINES);
		// The native culture's archive repeats each source, so only gathering decides its state.
		expect(states("en")).toEqual({
			not_gathered: notGathered,
			changed_since_gather: changed,
			translated: LINES - notGathered - changed
		});
		for (const culture of CULTURES.slice(1))
			expect(states(culture)).toEqual({
				not_gathered: notGathered,
				changed_since_gather: changed,
				not_translated: untranslated,
				translated: LINES - notGathered - changed - untranslated
			});
	});
});
