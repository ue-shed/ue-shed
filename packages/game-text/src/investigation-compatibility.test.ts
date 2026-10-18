import { exportGameTextInvestigation } from "./export-reference.test-support.js";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	GameTextInvestigationQuery,
	GameTextInvestigationPreset,
	GameTextInvestigationExport
} from "./investigation.js";
import { qualityFixture } from "./localization-workspace.test-support.js";

// Freeze the fields and version check shipped in 0.11.0. Its decoder ignores unknown fields.
const legacyPreset = Schema.Struct({
	...GameTextInvestigationPreset.fields,
	schemaVersion: Schema.Literal(1),
	query: Schema.Struct({
		withoutNotes: GameTextInvestigationQuery.fields.withoutNotes,
		mode: GameTextInvestigationQuery.fields.mode,
		query: GameTextInvestigationQuery.fields.query,
		capability: GameTextInvestigationQuery.fields.capability,
		lens: GameTextInvestigationQuery.fields.lens,
		where: GameTextInvestigationQuery.fields.where,
		filter: GameTextInvestigationQuery.fields.filter,
		group: GameTextInvestigationQuery.fields.group,
		localization: GameTextInvestigationQuery.fields.localization,
		qualityFilter: GameTextInvestigationQuery.fields.qualityFilter
	})
}).check(
	Schema.makeFilter((preset) => preset.query.mode !== "quality" || preset.rules !== undefined)
);

const source = {
	projectRoot: "C:/Project",
	generation: null,
	authority: "project_files"
} as const;

describe("investigation format compatibility", () => {
	it("rejects new localization presets in legacy readers, including embedded rules", async () => {
		const { text, document, files, workspace } = qualityFixture();
		const request = { target: files.target.name, filter: "format_arguments" as const };
		const input = {
			schemaVersion: 2,
			kind: "game_text",
			sort: "domain_order",
			query: {
				mode: "quality",
				query: "",
				capability: "all",
				qualityFilter: "all",
				workspaceFilter: request.filter,
				localization: { target: request.target }
			}
		};
		for (const rules of [undefined, document]) {
			const encoded = { ...input, ...(rules ? { rules } : undefined) };
			const preset = Schema.decodeUnknownSync(GameTextInvestigationPreset)(encoded);
			expect(Schema.decodeUnknownResult(legacyPreset)(encoded)._tag).toBe("Failure");
			expect(
				Schema.decodeUnknownResult(GameTextInvestigationPreset)({
					...encoded,
					schemaVersion: 1
				})._tag
			).toBe("Failure");
			const exported = await Effect.runPromise(
				exportGameTextInvestigation(
					text,
					preset,
					source,
					undefined,
					workspace.export(request)
				)
			);
			expect(exported).toMatchObject({
				schemaVersion: 2,
				preset: { schemaVersion: 2 },
				result: { mode: "localization_quality" }
			});
			expect(Schema.decodeUnknownSync(GameTextInvestigationExport)(exported)).toEqual(
				exported
			);
			expect(
				Schema.decodeUnknownResult(GameTextInvestigationExport)({
					...exported,
					schemaVersion: 1
				})._tag
			).toBe("Failure");
			const failed = await Effect.runPromise(
				Effect.flip(
					exportGameTextInvestigation(
						text,
						{ ...preset, schemaVersion: 1 },
						source,
						undefined,
						workspace.export(request)
					)
				)
			);
			expect(failed.message).toBe("Localization quality presets require schemaVersion 2.");
		}
		// This is the original failure: v1 plus rules silently loses the localization selection.
		const unsafe = Schema.decodeUnknownSync(legacyPreset)({
			...input,
			schemaVersion: 1,
			rules: document
		});
		expect(unsafe.query).not.toHaveProperty("workspaceFilter");
	});

	it("reads and replays v1 corpus and source quality investigations without changing their format", async () => {
		const { text, document, files, workspace } = qualityFixture();
		for (const mode of ["corpus", "quality"] as const) {
			const encoded = {
				schemaVersion: 1,
				kind: "game_text",
				sort: "domain_order",
				query: { mode, query: "", capability: "all", qualityFilter: "all" },
				...(mode === "quality" ? { rules: document } : undefined)
			};
			const preset = Schema.decodeUnknownSync(GameTextInvestigationPreset)(encoded);
			expect(Schema.decodeUnknownSync(legacyPreset)(encoded)).toEqual(preset);
			const exported = await Effect.runPromise(
				exportGameTextInvestigation(
					text,
					preset,
					source,
					undefined,
					workspace.export({ target: files.target.name, filter: "all" })
				)
			);
			expect(exported.schemaVersion).toBe(1);
			expect(exported.result.mode).toBe(mode);
			expect(Schema.decodeUnknownSync(GameTextInvestigationExport)(exported)).toEqual(
				exported
			);
			expect(
				Schema.decodeUnknownResult(GameTextInvestigationExport)({
					...exported,
					schemaVersion: 2
				})._tag
			).toBe("Failure");
		}
	});
});
