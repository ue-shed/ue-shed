import { Effect, Schema } from "effect";
import {
	InvestigationSource,
	InvestigationFailure,
	InvestigationCancelled,
	InvestigationError,
	investigationTable
} from "@ue-shed/unreal-assets/investigation";
import { TextureAuditSearchRequest, TextureAuditRuleSet, TextureAuditReport } from "./schema.js";
import type { TextureAuditQuery } from "./query.js";

export const TextureInvestigationQuery = Schema.Struct({
	query: TextureAuditSearchRequest.fields.query,
	findingsOnly: TextureAuditSearchRequest.fields.findingsOnly,
	selection: TextureAuditSearchRequest.fields.selection
});
export type TextureInvestigationQuery = Schema.Schema.Type<typeof TextureInvestigationQuery>;
export const TextureInvestigationPreset = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	kind: Schema.Literal("texture_audit"),
	sort: Schema.Literal("object_path"),
	query: TextureInvestigationQuery,
	rules: TextureAuditRuleSet
});
export type TextureInvestigationPreset = Schema.Schema.Type<typeof TextureInvestigationPreset>;
export const TextureInvestigationPresetResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("opened"),
		path: Schema.String,
		preset: TextureInvestigationPreset
	}),
	InvestigationFailure,
	InvestigationCancelled
]);
export type TextureInvestigationPresetResult = Schema.Schema.Type<
	typeof TextureInvestigationPresetResult
>;

export const TextureInvestigationExport = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	kind: Schema.Literal("texture_audit_export"),
	source: InvestigationSource,
	preset: TextureInvestigationPreset,
	coverageScope: Schema.Literal("whole_scan"),
	result: TextureAuditReport
});
export type TextureInvestigationExport = Schema.Schema.Type<typeof TextureInvestigationExport>;

export function textureInvestigationPreset(
	model: TextureAuditQuery,
	query: TextureInvestigationQuery
): Effect.Effect<TextureInvestigationPreset, InvestigationError> {
	const rules = model.export(query).ruleSet;
	return rules === undefined
		? Effect.fail(
				new InvestigationError({
					message: "This scan did not retain its rule document.",
					recovery: "Refresh the audit with a current reader before saving or exporting."
				})
			)
		: Effect.succeed({
				schemaVersion: 1,
				kind: "texture_audit",
				sort: "object_path",
				query,
				rules
			});
}

export function exportTextureInvestigation(
	model: TextureAuditQuery,
	preset: TextureInvestigationPreset,
	source: InvestigationSource
): TextureInvestigationExport {
	return {
		schemaVersion: 1,
		kind: "texture_audit_export",
		source,
		preset,
		coverageScope: "whole_scan",
		result: model.export(preset.query)
	};
}

export function textureInvestigationCsv(document: TextureInvestigationExport): string {
	const { records, findings, ...scan } = document.result;
	const findingMap = new Map<string, Array<(typeof findings)[number]>>();
	for (const finding of findings) {
		const bucket = findingMap.get(finding.objectPath);
		if (bucket) bucket.push(finding);
		else findingMap.set(finding.objectPath, [finding]);
	}
	return investigationTable(
		{
			schemaVersion: document.schemaVersion,
			kind: document.kind,
			source: document.source,
			preset: document.preset,
			coverageScope: document.coverageScope,
			scan
		},
		[
			"object_path",
			"dimensions",
			"texture_group",
			"compression",
			"srgb",
			"finding_count",
			"findings_json",
			"record_json"
		],
		records.map((record) => [
			record.objectPath,
			JSON.stringify(record.dimensions),
			JSON.stringify(record.textureGroup),
			JSON.stringify(record.compression),
			JSON.stringify(record.sRGB),
			findingMap.get(record.objectPath)?.length ?? 0,
			JSON.stringify(findingMap.get(record.objectPath) ?? []),
			JSON.stringify(record)
		])
	);
}

export type {
	InvestigationFileResult,
	InvestigationFormat
} from "@ue-shed/unreal-assets/investigation";
