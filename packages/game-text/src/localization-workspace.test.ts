import { exportGameTextInvestigation } from "./export-reference.test-support.js";
import { Effect, Schema } from "effect";
import {
	GameTextInvestigationPreset,
	GameTextInvestigationExport,
	gameTextInvestigationCsv
} from "./investigation.js";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { withIndexedCorpus } from "./indexed-corpus.test-support.js";
import { qualityFixture } from "./localization-workspace.test-support.js";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	target,
	unit
} from "./localization.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { localizationKeyChanges } from "./localization-key-changes.js";
import {
	WorkspaceQualityPage,
	WorkspaceQualityRequest,
	WorkspaceQualityFocusResult,
	WorkspaceChangesResult,
	WorkspaceReportPage,
	localizationReportCsv,
	workspaceQualityCsv
} from "./localization-workspace.js";

describe("bounded localization workspace", () => {
	it("combines source, built-in and culture rules through the same culture selection", () => {
		const { workspace, files } = qualityFixture();
		const request = {
			target: files.target.name,
			culture: cultureCode("de"),
			filter: "all"
		} as const;
		const page = workspace.search(request);
		expect(Schema.decodeUnknownSync(WorkspaceQualityPage)(page)).toEqual(page);
		expect(page.counts.all).toBe(page.total);
		expect(page.counts.character_budget).toBe(2);
		expect(page.counts.terminology).toBe(1);
		expect(page.counts.format_argument_renamed).toBe(1);
		expect(
			workspace.search({ ...request, culture: cultureCode("en") }).counts.terminology
		).toBe(0);
		const filtered = workspace.search({ ...request, filter: "format_argument_renamed" });
		expect(filtered.total).toBe(page.counts.format_argument_renamed);
		const id = filtered.findings[0]?.id;
		if (!id) throw new Error("Expected a format argument finding");
		const result = workspace.focus({ ...request, id });
		expect(Schema.decodeUnknownSync(WorkspaceQualityFocusResult)(result)).toEqual(result);
		if (result.status !== "found" || result.focus.kind !== "localization")
			throw new Error("Expected localization detail");
		const focus = result.focus;
		expect(
			focus.sourceRanges.map((range) => focus.source.slice(range.start, range.end))
		).toEqual(["{PlayerName}"]);
		expect(
			focus.translationRanges.map((range) => focus.translation?.slice(range.start, range.end))
		).toEqual(["{Name}"]);
		expect(result.focus.translations.translations.map((mark) => mark.culture)).toEqual(["de"]);
		expect(result.focus.suggestedChange?.translation).toBe("Hallo {PlayerName}");
		expect(workspace.focus({ ...request, culture: cultureCode("en"), id })).toEqual({
			status: "not_found"
		});
	});

	it("bounds pages and copied proposals and omits file authority", () => {
		const { workspace, files } = qualityFixture(105);
		const request = {
			target: files.target.name,
			culture: cultureCode("de"),
			filter: "format_argument_renamed"
		} as const;
		const first = workspace.search(request);
		expect(first.findings).toHaveLength(50);
		expect(first.nextOffset).toBe(50);
		expect(workspace.search({ ...request, offset: 100 }).findings).toHaveLength(5);
		const changes = workspace.changes(request);
		expect(Schema.decodeUnknownSync(WorkspaceChangesResult)(changes)).toEqual(changes);
		if (changes.status !== "ready") throw new Error("Expected proposals");
		expect(changes.document.changes).toHaveLength(100);
		expect(changes.remaining).toBe(5);
		expect(changes.document.provenance.files).toEqual([]);
	});

	it("preserves the rules file in source investigation exports", async () => {
		const { text, document } = qualityFixture();
		const preset = Schema.decodeUnknownSync(GameTextInvestigationPreset)({
			schemaVersion: 1,
			kind: "game_text",
			sort: "domain_order",
			query: {
				mode: "quality",
				query: "",
				capability: "all",
				lens: "all",
				qualityFilter: "all"
			},
			rules: document
		});
		const exported = await Effect.runPromise(
			exportGameTextInvestigation(text, preset, {
				projectRoot: "C:/Project",
				generation: null,
				authority: "project_files"
			})
		);
		expect(Schema.decodeUnknownSync(GameTextInvestigationExport)(exported)).toEqual(exported);
		expect(exported.preset.rules).toEqual(document);
		expect(exported.result).toMatchObject({
			mode: "quality",
			report: { ruleDocumentVersion: 1, findings: [{ kind: "character_budget" }] }
		});
	});

	it.live("exports the lines a target's problem and translation pills select", () => {
		const text = corpus([unit("Renamed", "Welcome back"), unit("Other", "Other line")]);
		const files = evidence(
			[manifestEntry("Welcome", "Welcome back"), manifestEntry("Other", "Other line")],
			[archiveEntry("Welcome", "Welcome back", "Willkommen zurück")]
		);
		const joined = joinLocalizationTarget(text, files);
		const keyChangePairs = localizationKeyChanges(joined, text).pairs;
		const source = {
			projectRoot: "C:/Project",
			generation: null,
			authority: "project_files"
		} as const;
		type Query = (typeof GameTextInvestigationPreset.Encoded)["query"];
		const preset = (filter: Query["filter"], localization?: Query["localization"]) =>
			Schema.decodeUnknownSync(GameTextInvestigationPreset)({
				schemaVersion: 1,
				kind: "game_text",
				sort: "domain_order",
				query: {
					mode: "corpus",
					query: "",
					capability: "all",
					qualityFilter: "all",
					filter,
					...(localization === undefined ? undefined : { localization })
				}
			});
		const keyChanged = preset([{ field: "problem", op: "is", values: ["key_changed"] }], {
			target: target.name
		});
		const translation = preset([{ field: "translation", op: "is", values: ["missing"] }]);
		return Effect.gen(function* () {
			yield* withIndexedCorpus(text, { files, keyChangePairs }, ({ query }) =>
				Effect.gen(function* () {
					const exported = yield* exportGameTextInvestigation(
						text,
						keyChanged,
						source,
						query
					);
					expect(
						exported.result.mode === "corpus" &&
							exported.result.corpus.units.map((item) => item.id)
					).toEqual(["unreal:NS:Renamed"]);
				})
			);
			// Without the target's files the export fails with guidance rather than guessing.
			const unloaded = yield* Effect.flip(
				exportGameTextInvestigation(text, keyChanged, source)
			);
			expect(unloaded.message).toContain("not loaded");
			// A translation pill needs a target, so the engine refuses the selection without one.
			const failed = yield* withIndexedCorpus(text, {}, ({ query }) =>
				Effect.flip(exportGameTextInvestigation(text, translation, source, query))
			);
			expect(failed.cause).toMatchObject({
				_tag: "GameTextIndexError",
				cause: { code: "invalid_input" }
			});
		});
	});

	it("projects native-first report rows, zero baseline deltas and spreadsheet-safe CSV", () => {
		const { page } = qualityFixture();
		expect(Schema.decodeUnknownSync(WorkspaceReportPage)(page)).toEqual(page);
		expect(page.rows.map((row) => row.culture)).toEqual(["en", "de"]);
		expect(page.rows.every((row) => row.newWords === 0 && row.changedWords === 0)).toBe(true);
		expect(JSON.stringify(page)).not.toContain("relativePath");
		const csv = localizationReportCsv(page.rows, true);
		expect(csv.startsWith('\uFEFF"Culture"')).toBe(true);
		expect(csv.endsWith("\r\n")).toBe(true);
		expect(csv.split("\r\n")).toHaveLength(4);
		expect(csv).toContain('"New words","Changed words"');
	});
});

it("exports and replays the exact localization quality filter and culture with coverage", async () => {
	const fixture = qualityFixture();
	const selection = {
		target: fixture.files.target.name,
		culture: cultureCode("de"),
		filter: "format_arguments" as const
	};
	const { export: exportReport } = fixture.workspace;
	const report = exportReport(selection);
	expect(report.findings).toEqual(fixture.workspace.search(selection).findings);
	expect(report.corpusCoverage).toEqual(fixture.text.coverage);
	const csv = workspaceQualityCsv(report);
	expect(csv.startsWith('\uFEFF"Target"')).toBe(true);
	expect(csv.split("\r\n")[0]).toContain('"Finding ID","Scan status"');
	expect(csv.endsWith("\r\n")).toBe(true);
	const input = {
		schemaVersion: 2,
		kind: "game_text",
		sort: "domain_order",
		query: {
			mode: "quality",
			query: "",
			capability: "all",
			qualityFilter: "all",
			workspaceFilter: selection.filter,
			localization: { target: selection.target, culture: selection.culture }
		}
	};
	const preset = Schema.decodeUnknownSync(GameTextInvestigationPreset)(input);
	const source = {
		projectRoot: "C:/Project",
		generation: null,
		authority: "project_files"
	} as const;
	const exported = await Effect.runPromise(
		exportGameTextInvestigation(fixture.text, preset, source, undefined, report)
	);
	expect(exported.schemaVersion).toBe(2);
	expect(exported.result).toEqual({ mode: "localization_quality", report });
	expect(Schema.decodeUnknownSync(GameTextInvestigationExport)(exported)).toEqual(exported);
	expect(gameTextInvestigationCsv(exported)).toContain("finding_id");
	expect(gameTextInvestigationCsv(exported)).toContain("format_arguments");
	// The workspace filter belongs to a quality query over a target; other shapes are rejected.
	const { localization: _localization, ...withoutTarget } = input.query;
	for (const query of [withoutTarget, { ...input.query, mode: "corpus" }])
		expect(
			Schema.decodeUnknownResult(GameTextInvestigationPreset)({ ...input, query })._tag
		).toBe("Failure");
	const unavailable = await Effect.runPromise(
		Effect.flip(exportGameTextInvestigation(fixture.text, preset, source))
	);
	expect(unavailable.message).toBe("The localization quality workspace is unavailable.");
	expect(unavailable.recovery).not.toContain("selected");
	for (const mismatched of [
		{ ...report, filter: "all" as const },
		{ ...report, culture: cultureCode("en") },
		{
			...report,
			target: Schema.decodeUnknownSync(WorkspaceQualityRequest.fields.target)("Other")
		}
	]) {
		const failure = await Effect.runPromise(
			Effect.flip(
				exportGameTextInvestigation(fixture.text, preset, source, undefined, mismatched)
			)
		);
		expect(failure.message).toBe("The quality report does not match this preset's selection.");
	}
});
