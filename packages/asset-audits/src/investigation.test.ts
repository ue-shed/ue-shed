import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { AuditRuleId, TextureObjectPath, type TextureAuditReport } from "./schema.js";
import { textureAuditQuery } from "./query.js";
import {
	exportTextureInvestigation,
	textureInvestigationPreset,
	textureInvestigationCsv,
	TextureInvestigationPreset
} from "./investigation.js";

const available = <A>(value: A) => ({
	status: "available" as const,
	source: "serialized" as const,
	value
});
const paths = Array.from({ length: 225 }, (_, i) =>
	TextureObjectPath.make(`/Game/UI/T_${String(i).padStart(3, "0")}.T_${i}`)
);
const report: TextureAuditReport = {
	schemaVersion: 1,
	status: "complete",
	ruleSetName: "Captured rules",
	ruleSet: {
		schemaVersion: 1,
		name: "Captured rules",
		rules: [
			{
				id: AuditRuleId.make("power-two"),
				kind: "dimensions_power_of_two",
				severity: "warning"
			}
		]
	},
	coverage: {
		discoveredPackages: 225,
		inspectedPackages: 225,
		textureAssets: 225,
		partialPackages: 0,
		failedPackages: 0
	},
	diagnostics: [],
	distributions: { compression: [], maximumDimension: [], sRGB: [], textureGroup: [] },
	records: paths.map((objectPath) => ({
		objectPath,
		filePath: "Content/UI/texture.uasset",
		dimensions: available({ width: 300, height: 256 }),
		textureGroup: available("TEXTUREGROUP_UI"),
		compression: available("TC_Default"),
		sRGB: available(true),
		mipGeneration: available("TMGS_FromTextureGroup"),
		sourceFormat: available("TSF_BGRA8"),
		sourceMips: available(1),
		packageFileBytes: available(1024)
	})),
	findings: paths.slice(0, 205).map((objectPath) => ({
		objectPath,
		ruleId: AuditRuleId.make("power-two"),
		severity: "warning",
		explanation: "Width is not a power of two.",
		actual: [{ label: "width", value: "300" }],
		expected: [{ label: "width", value: "power of two" }]
	}))
};

it("exports all matching textures and findings using the captured rules", async () => {
	const model = textureAuditQuery(report);
	const query = {
		findingsOnly: true,
		query: "UI",
		selection: { kind: "textureGroup" as const, key: "TEXTUREGROUP_UI" }
	};
	const preset = await Effect.runPromise(textureInvestigationPreset(model, query));
	expect(preset.rules).toEqual(report.ruleSet);
	const decoded = await Effect.runPromise(
		Schema.decodeUnknownEffect(TextureInvestigationPreset)(JSON.parse(JSON.stringify(preset)))
	);
	const document = exportTextureInvestigation(model, decoded, {
		projectRoot: "/project",
		generation: 9,
		authority: "project_files"
	});
	expect(model.search({ ...query, pageSize: 100 }).records).toHaveLength(100);
	expect(document.result.records).toHaveLength(205);
	expect(document.result.findings).toHaveLength(205);
	expect(document.result.coverage.textureAssets).toBe(225);
	expect(textureInvestigationCsv(document).split("\r\n")).toHaveLength(208);
	expect(model.export({ findingsOnly: false, query: "absent" }).records).toEqual([]);
});

it("fails clearly for legacy reports without retained rules and rejects unknown preset versions", async () => {
	const { ruleSet: _rules, ...legacy } = report;
	await expect(
		Effect.runPromise(
			textureInvestigationPreset(textureAuditQuery(legacy), {
				findingsOnly: false,
				query: ""
			})
		)
	).rejects.toMatchObject({ _tag: "InvestigationError" });
	await expect(
		Effect.runPromise(
			Schema.decodeUnknownEffect(TextureInvestigationPreset)({ schemaVersion: 2 })
		)
	).rejects.toBeDefined();
});
