import { textWhere } from "./query-filter.js";
import { exportGameTextInvestigation } from "./export-reference.test-support.js";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	GameTextInvestigationPreset,
	GameTextInvestigationExport,
	investigationRequest
} from "./investigation.js";
import { qualityFixture } from "./localization-workspace.test-support.js";
const decodeGameTextInvestigationExport = Schema.decodeSync(GameTextInvestigationExport);
const decodeGameTextInvestigationPreset = Schema.decodeUnknownSync(GameTextInvestigationPreset);
const decodeGameTextInvestigationPresetResult = Schema.decodeUnknownResult(
	GameTextInvestigationPreset
);

const source = {
	projectRoot: "C:/Project",
	generation: null,
	authority: "project_files"
} as const;

describe("investigation format", () => {
	it("refuses presets saved before they held the filter UE Shed runs", () => {
		for (const schemaVersion of [1, 2])
			expect(
				decodeGameTextInvestigationPresetResult({
					schemaVersion,
					kind: "game_text",
					sort: "domain_order",
					query: {
						mode: "corpus",
						query: "",
						qualityFilter: "all",
						filter: [{ field: "fact", op: "is", values: ["unresolved"] }]
					}
				})._tag
			).toBe("Failure");
	});

	it("exports a localization quality preset, with or without embedded rules", async () => {
		const { text, document, files, workspace } = qualityFixture();
		const request = { target: files.target.name, filter: "format_arguments" as const };
		const input = {
			schemaVersion: 3,
			kind: "game_text",
			sort: "domain_order",
			query: {
				mode: "quality",
				query: "",
				qualityFilter: "all",
				workspaceFilter: request.filter,
				localization: { target: request.target }
			}
		};
		for (const rules of [undefined, document]) {
			const preset = decodeGameTextInvestigationPreset({
				...input,
				...(rules ? { rules } : undefined)
			});
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
				schemaVersion: 3,
				preset: { schemaVersion: 3 },
				result: { mode: "localization_quality" }
			});
			expect(decodeGameTextInvestigationExport(exported)).toEqual(exported);
		}
	});

	it("exports corpus and source quality presets", async () => {
		const { text, document, files, workspace } = qualityFixture();
		for (const mode of ["corpus", "quality"] as const) {
			const preset = decodeGameTextInvestigationPreset({
				schemaVersion: 3,
				kind: "game_text",
				sort: "domain_order",
				query: { mode, query: "", qualityFilter: "all" },
				...(mode === "quality" ? { rules: document } : undefined)
			});
			const exported = await Effect.runPromise(
				exportGameTextInvestigation(
					text,
					preset,
					source,
					undefined,
					workspace.export({ target: files.target.name, filter: "all" })
				)
			);
			expect(exported.schemaVersion).toBe(3);
			expect(exported.result.mode).toBe(mode);
			expect(decodeGameTextInvestigationExport(exported)).toEqual(exported);
		}
	});

	it("runs a preset's filter and keeps the host's controls as it saved them", () => {
		const where = textWhere({ filter: [{ field: "fact", op: "is", values: ["unresolved"] }] })!;
		const controls = { pills: [{ field: "fact", values: ["unresolved"] }], grouped: null };
		const preset = decodeGameTextInvestigationPreset({
			schemaVersion: 3,
			kind: "game_text",
			sort: "domain_order",
			query: {
				mode: "corpus",
				query: "Hello",
				where,
				fileScope: ["Content/Menus/WBP_Main.uasset"],
				qualityFilter: "all",
				controls
			}
		});
		expect(preset.query.controls).toEqual(controls);
		expect(investigationRequest(preset.query)).toEqual({
			query: "Hello",
			where,
			fileScope: ["Content/Menus/WBP_Main.uasset"]
		});
	});
});
