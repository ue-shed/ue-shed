import type {
	AuthoringFieldDescriptor,
	AuthoringRow,
	AuthoringTableSnapshot
} from "@ue-shed/protocol";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AnalysisPlan, buildAnalysisPlan } from "./analysis.js";
const decodeAnalysisPlan = Schema.decodeSync(AnalysisPlan);

function descriptor(
	name: string,
	type: AuthoringFieldDescriptor["type"]
): AuthoringFieldDescriptor {
	return {
		annotations: { deprecated: false, readOnly: false },
		defaultValue: { status: "unknown" },
		editability: { kind: "editable" },
		id: `field:${name}`,
		name,
		presence: "required",
		type,
		typeName: name
	};
}

function snapshot(rows: readonly AuthoringRow[]): AuthoringTableSnapshot {
	return {
		authority: { kind: "project_files", packageName: "/Game/Fixture/DT_Items" },
		completeness: "complete",
		contract: { name: "unreal-authoring", version: { major: 2, minor: 0 } },
		diagnostics: [],
		fingerprint: { algorithm: "sha256", status: "available", value: "fixture", version: 1 },
		producer: { name: "fixture", version: "1" },
		table: {
			kind: "data_table",
			objectPath: "/Game/Fixture/DT_Items.DT_Items",
			packageName: "/Game/Fixture/DT_Items",
			parentTables: [],
			rowStruct: "/Script/Fixture.Item",
			rows: [...rows],
			schema: {
				fields: [
					descriptor("Rarity", {
						kind: "enum",
						options: [{ name: "Common" }, { name: "Rare" }]
					}),
					descriptor("Price", { kind: "scalar", valueKind: "int" }),
					descriptor("Damage", { kind: "scalar", valueKind: "float" }),
					descriptor("DisplayName", { kind: "scalar", valueKind: "text" })
				],
				source: "saved_package",
				status: "available"
			}
		}
	};
}

function row(
	name: string,
	rarity: "Common" | "Rare",
	price: string,
	damage: number,
	displayName: string
): AuthoringRow {
	return {
		fields: [
			{ name: "Rarity", typeName: "EnumProperty", value: { kind: "enum", value: rarity } },
			{ name: "Price", typeName: "IntProperty", value: { kind: "int", value: price } },
			{
				name: "Damage",
				typeName: "FloatProperty",
				value: { kind: "float", value: damage }
			},
			{
				name: "DisplayName",
				typeName: "TextProperty",
				value: { kind: "text", value: displayName }
			}
		],
		id: `row:${name}`,
		name
	};
}

const items = snapshot([
	row("Sword", "Common", "100", 10, "Gear"),
	row("Axe", "Common", "120", 12, "Gear"),
	row("Wand", "Rare", "400", 25, "Magic")
]);

describe("buildAnalysisPlan", () => {
	it("suggests categorical, distribution, comparison, and relationship charts", () => {
		const plan = buildAnalysisPlan({ snapshot: items });

		expect(decodeAnalysisPlan(plan)).toEqual(plan);
		expect(plan.rowCount).toBe(3);
		expect(plan.profiledColumnCount).toBe(3);
		expect(plan.tableObjectPath).toBe("/Game/Fixture/DT_Items.DT_Items");
		expect(plan.charts.map((chart) => chart.kind)).toEqual([
			"category-count",
			"histogram",
			"histogram",
			"category-value",
			"category-value",
			"scatter"
		]);
		const count = plan.charts[0];
		expect(count?.kind).toBe("category-count");
		if (count?.kind !== "category-count") return;
		expect(count.source).toBe("suggested");
		expect(count.data).toEqual([
			{ label: "Common", value: 2 },
			{ label: "Rare", value: 1 }
		]);
	});

	it("charts tables too big to spread into Math.min and Math.max", () => {
		const rows = Array.from({ length: 300_000 }, (_, index) =>
			row(
				`Row${index}`,
				index % 2 === 0 ? "Common" : "Rare",
				String(index),
				index / 2,
				"Gear"
			)
		);
		const plan = buildAnalysisPlan({
			charts: [
				{
					bins: 4,
					id: "price",
					kind: "histogram",
					title: "Price",
					valueFieldName: "Price"
				},
				{
					aggregate: "minimum",
					categoryFieldName: "Rarity",
					id: "lowest",
					kind: "category-value",
					title: "Lowest damage",
					valueFieldName: "Damage"
				},
				{
					aggregate: "maximum",
					categoryFieldName: "Rarity",
					id: "highest",
					kind: "category-value",
					title: "Highest damage",
					valueFieldName: "Damage"
				}
			],
			rows,
			snapshot: items
		});
		const [histogram, lowest, highest] = plan.charts;
		expect(histogram?.kind).toBe("histogram");
		if (histogram?.kind !== "histogram") return;
		expect(histogram.data).toHaveLength(4);
		expect(histogram.data.reduce((total, bin) => total + bin.count, 0)).toBe(300_000);
		expect(lowest?.data).toEqual([
			{ label: "Rare", value: 0.5 },
			{ label: "Common", value: 0 }
		]);
		expect(highest?.data).toEqual([
			{ label: "Rare", value: 149_999.5 },
			{ label: "Common", value: 149_999 }
		]);
	});

	it("keeps specified charts first and does not repeat the same heuristic", () => {
		const plan = buildAnalysisPlan({
			charts: [
				{
					categoryFieldName: "Rarity",
					id: "rarity-breakdown",
					kind: "category-count",
					title: "Requested rarity breakdown"
				}
			],
			snapshot: items
		});

		expect(plan.charts[0]).toMatchObject({
			id: "rarity-breakdown",
			source: "specified",
			title: "Requested rarity breakdown"
		});
		expect(
			plan.charts.filter(
				(chart) => chart.kind === "category-count" && chart.xLabel === "Rarity"
			)
		).toHaveLength(1);
	});

	it("only promotes low-cardinality text when it is declared categorical", () => {
		const implicit = buildAnalysisPlan({ snapshot: items });
		expect(implicit.charts.some((chart) => chart.xLabel === "DisplayName")).toBe(false);

		const explicit = buildAnalysisPlan({
			categoricalFieldNames: ["DisplayName"],
			snapshot: items
		});
		const displayNameChart = explicit.charts.find(
			(chart) => chart.kind === "category-count" && chart.xLabel === "DisplayName"
		);
		expect(displayNameChart?.data).toEqual([
			{ label: "Gear", value: 2 },
			{ label: "Magic", value: 1 }
		]);
	});

	it("does not treat row names as a chart category", () => {
		const plan = buildAnalysisPlan({
			rows: items.table.rows.slice(0, 2),
			snapshot: items
		});
		expect(plan.charts.some((chart) => chart.xLabel === "Row")).toBe(false);
	});

	it("describes histogram observations instead of counting rows with missing values", () => {
		const rows = items.table.rows.map((item, index) =>
			index === 0
				? {
						...item,
						fields: item.fields.filter((field) => field.name !== "Price")
					}
				: item
		);
		const plan = buildAnalysisPlan({ rows, snapshot: items });
		const priceHistogram = plan.charts.find(
			(chart) => chart.kind === "histogram" && chart.xLabel === "Price"
		);

		expect(priceHistogram?.description).toBe("2 values grouped into 2 numeric ranges");
	});

	it("records missing specified fields without dropping other charts", () => {
		const plan = buildAnalysisPlan({
			charts: [
				{
					categoryFieldName: "Missing",
					id: "missing",
					kind: "category-count",
					title: "Missing field"
				}
			],
			snapshot: items
		});

		expect(plan.issues).toEqual(["Chart Missing field references missing field Missing."]);
		expect(plan.charts.some((chart) => chart.kind === "category-count")).toBe(true);
	});

	it("omits non-finite numeric sentinels from charts", () => {
		const rows = items.table.rows.map((item, index) =>
			index === 0
				? {
						...item,
						fields: item.fields.map((field) =>
							field.name === "Damage"
								? {
										...field,
										value: { kind: "float" as const, value: "nan" as const }
									}
								: field
						)
					}
				: item
		);
		const plan = buildAnalysisPlan({ rows, snapshot: items });
		const damageHistogram = plan.charts.find(
			(chart) => chart.kind === "histogram" && chart.xLabel === "Damage"
		);

		expect(damageHistogram?.description).toBe("2 values grouped into 2 numeric ranges");
	});

	it("infers boolean categories from snapshots that have no schema", () => {
		const untyped: AuthoringTableSnapshot = {
			authority: { kind: "project_files", packageName: "/Game/Fixture/DT_Flags" },
			completeness: "complete",
			contract: { name: "unreal-authoring", version: { major: 1, minor: 0 } },
			diagnostics: [],
			table: {
				kind: "data_table",
				objectPath: "/Game/Fixture/DT_Flags.DT_Flags",
				parentTables: [],
				rowStruct: "/Script/Fixture.Flag",
				rows: [
					{
						fields: [
							{
								name: "Enabled",
								typeName: "BoolProperty",
								value: { kind: "bool", value: true }
							}
						],
						id: "row:A",
						name: "A"
					},
					{
						fields: [
							{
								name: "Enabled",
								typeName: "BoolProperty",
								value: { kind: "bool", value: false }
							}
						],
						id: "row:B",
						name: "B"
					}
				]
			}
		};
		const plan = buildAnalysisPlan({ snapshot: untyped });
		expect(plan.charts[0]).toMatchObject({
			kind: "category-count",
			xLabel: "Enabled"
		});
	});
});
