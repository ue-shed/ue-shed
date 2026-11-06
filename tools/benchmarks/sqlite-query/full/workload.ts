import { Schema } from "effect";
import { TextCorpusSearchRequest } from "../../../../packages/game-text/src/schema.ts";
import { LocalizationFocusRequest } from "../../../../packages/game-text/src/localization-view.ts";
import { LocalizationLineField } from "../../../../packages/game-text/src/index-reads.ts";
import {
	TextAggregateRequest,
	TextAggregateDimension
} from "../../../../packages/game-text/src/index-reads.ts";
import type { RetainedInput, LineRecord, UnitRecord, Json } from "./model.ts";

export type Case = { readonly name: string; readonly benchmark?: boolean } & (
	| {
			readonly operation: "rows" | "search" | "select" | "export";
			readonly request: TextCorpusSearchRequest;
			readonly fields?: readonly string[];
	  }
	| { readonly operation: "corpus" | "lines" | "fingerprint" }
	| { readonly operation: "line"; readonly id: string }
	| { readonly operation: "detail"; readonly request: LocalizationFocusRequest }
	| { readonly operation: "aggregate"; readonly request: TextAggregateRequest }
);
export function workload(
	input: RetainedInput,
	lines: readonly LineRecord[],
	units: readonly UnitRecord[]
): Case[] {
	const result: Case[] = [
		{ name: "full-corpus", operation: "corpus" },
		{ name: "full-lines", operation: "lines" }
	];
	result.push({ name: "corpus-fingerprint", operation: "fingerprint" });
	const request = (localized: boolean, overrides: Record<string, Json> = {}) =>
		Schema.decodeUnknownSync(TextCorpusSearchRequest)({
			query: "",
			capability: "all",
			pageSize: 50,
			...(localized && { localization: { target: input.target } }),
			...overrides
		});
	for (const localized of [false, true]) {
		const prefix = localized ? "target" : "source";
		const add = (name: string, overrides: Record<string, Json> = {}, benchmark = false) => {
			const req = request(localized, overrides);
			result.push({
				name: `${prefix}/rows/${name}`,
				operation: "rows",
				request: req,
				benchmark
			});
			result.push({
				name: `${prefix}/search/${name}`,
				operation: "search",
				request: req,
				benchmark
			});
		};
		add("first50", {}, true);
		add("first5000", { pageSize: 5000 }, true);
		add("one", { pageSize: 1 });
		add("dense-text", { query: "taluma" }, true);
		add("selective-text", { query: "210" }, true);
		add("missing-text", { query: "there_is_no_such_generated_text" });
		add("multiple-terms", { query: "taluma 210" });
		add("case-fold", { query: "TALUMA" });
		for (const capability of ["source_editable", "read_only"])
			add(capability, { capability, withoutNotes: true });
		for (const [field, values] of [
			["audience", ["player"]],
			["origin", ["data_table"]],
			["editing", ["editable"]],
			["notes", ["missing"]],
			["namespace", [""]],
			["fact", ["unresolved"]],
			["problem", ["unchecked"]],
			["translation", ["missing", "not_synced"]],
			["asset_type", ["blueprint"]],
			["finding", ["no-such-rule"]],
			["folder", ["/Game/Velora"]],
			["asset", ["Content/Velora/Oriven/Fenori/Taluma/Package0.uasset"]],
			["source", [lines[0]!.line.source]],
			[
				"translation_key",
				[
					JSON.stringify(
						lines.find((line) => line.line.identity)!.line.identity && [
							lines.find((line) => line.line.identity)!.line.identity!.namespace,
							lines.find((line) => line.line.identity)!.line.identity!.key
						]
					)
				]
			]
		] as const)
			if (localized || field !== "translation")
				for (const op of ["is", "is_not"])
					add(`${field}-${op}`, { filter: [{ field, op, values }] });
		add("same-place", {
			capability: "source_editable",
			withoutNotes: true,
			where: {
				kinds: ["data_table"],
				pathPrefix: "/Game/Velora",
				files: ["Content/Velora/Oriven/Fenori/Taluma/Package0.uexp"]
			}
		});
		for (const group of [
			"problem",
			"origin",
			"audience",
			"namespace",
			"source",
			"folder",
			"asset"
		] as const) {
			result.push({
				name: `${prefix}/group/${group}`,
				operation: "search",
				request: request(localized, { group, minGroupSize: 2 }),
				benchmark: group === "namespace"
			});
		}
		for (const group of ["problem", "audience"] as const) {
			add(`opened-${group}`, {
				group,
				openGroups:
					group === "problem"
						? ["unchecked", "up_to_date", "translation"]
						: ["player", "editor", "unknown"],
				firstRows: 10
			});
			add(`open-budget-${group}`, {
				group,
				openGroups:
					group === "problem"
						? ["unchecked", "up_to_date", "translation"]
						: ["player", "editor", "unknown"],
				firstRows: 500
			});
		}
		add("folder-facets", {
			facets: { folder: "Content/Velora", facts: true, cultures: true }
		});
		for (const field of ["audience", "origin", "asset", "problem"] as const)
			add(`facet-self-${field}`, {
				filter: [
					{
						field,
						op: "is",
						values:
							field === "audience"
								? ["player"]
								: field === "origin"
									? ["data_table"]
									: field === "asset"
										? ["Content/Velora/Oriven/Fenori/Taluma/Package0"]
										: ["unchecked"]
					}
				],
				facets: {
					origins: true,
					audiences: true,
					assets: true,
					assetTypes: true,
					findings: true
				}
			});
		const cursor = localized ? lines[10]?.line.id : units[10]?.unit.id;
		if (cursor)
			add("continuation", { [localized ? "localizationCursor" : "cursor"]: cursor }, true);
		add("missing-cursor", { [localized ? "localizationCursor" : "cursor"]: "missing-id" });
		if (cursor)
			add("filtered-cursor-restarts", {
				query: "210",
				[localized ? "localizationCursor" : "cursor"]: cursor
			});
	}
	for (const culture of ["de", "en"]) {
		result.push({
			name: `target/culture/${culture}`,
			operation: "search",
			request: request(true, { localization: { target: input.target, culture } }),
			benchmark: culture === "de"
		});
		result.push({
			name: `target/translations/${culture}`,
			operation: "search",
			request: request(true, {
				query: `${culture} Velori`,
				localization: { target: input.target, culture, searchTranslations: true }
			}),
			benchmark: culture === "de"
		});
	}
	for (const state of ["not_translated", "not_synced", "unknown", "outside_target"] as const)
		result.push({
			name: `target/state/${state}`,
			operation: "search",
			request: request(true, {
				localization: { target: input.target, cultures: input.cultures.slice(0, 2), state }
			})
		});
	for (const review of [
		"reviewed",
		"not_reviewed",
		"not_proofread",
		"changed_since_review",
		"machine_translated"
	])
		result.push({
			name: `target/review/${review}`,
			operation: "search",
			request: request(true, { localization: { target: input.target, review } })
		});
	result.push({
		name: "target/key-changed",
		operation: "search",
		request: request(true, { localization: { target: input.target, keyChanged: true } })
	});
	result.push({
		name: "target/unicode-positive",
		operation: "search",
		request: request(true, { query: "漢字" })
	});
	result.push({
		name: input.scale >= 0.1 ? "target/all-fields-picked-1000" : "target/all-fields",
		operation: "select",
		request: request(
			true,
			input.scale >= 0.1 ? { lines: lines.map((record) => record.line.id) } : {}
		),
		fields: LocalizationLineField.literals,
		benchmark: true
	});
	result.push({
		name: "target/identity-source",
		operation: "select",
		request: request(true),
		fields: ["identity", "source"],
		benchmark: true
	});
	for (const dimension of TextAggregateDimension.literals) {
		const by = [
			"state",
			"fact",
			"unknown_reason",
			"review",
			"review_status",
			"review_flag"
		].includes(dimension)
			? ["culture", dimension]
			: [dimension];
		result.push({
			name: `aggregate/${by.join("+")}`,
			operation: "aggregate",
			request: Schema.decodeUnknownSync(TextAggregateRequest)({
				query: "",
				capability: "all",
				localization: { target: input.target },
				by,
				measures: ["lines", "sourceWords", "lineBreakWords"]
			}),
			benchmark: dimension === "state"
		});
	}
	for (const by of [
		["culture", "state", "audience", "origin"],
		["namespace", "problem"],
		["review_signal", "asset"]
	])
		result.push({
			name: `aggregate/${by.join("+")}`,
			operation: "aggregate",
			request: Schema.decodeUnknownSync(TextAggregateRequest)({
				query: "",
				capability: "all",
				localization: { target: input.target, cultures: input.cultures.slice(0, 2) },
				by,
				measures: ["sourceWords", "lineBreakWords"]
			})
		});
	result.push({
		name: "source/export-filtered",
		operation: "export",
		request: request(false, { query: "210" })
	});
	for (const line of lines.slice(0, 5)) {
		result.push({ name: `line/${line.line.id}`, operation: "line", id: line.line.id });
		for (const offsets of [{}, { cultureOffset: 8, locationOffset: 2, poContextOffset: 1 }])
			result.push({
				name: `detail/${line.line.id}/${Object.keys(offsets).length}`,
				operation: "detail",
				request: Schema.decodeUnknownSync(LocalizationFocusRequest)({
					target: input.target,
					selection: { kind: "line", id: line.line.id },
					...offsets
				})
			});
	}
	return result;
}
