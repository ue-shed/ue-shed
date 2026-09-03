import type {
	AuthoringRow,
	AuthoringTableSnapshot,
	AuthoringTypeDescriptor,
	AuthoringValue
} from "@ue-shed/protocol";
import { Schema } from "effect";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const AnalysisChartAggregate = Schema.Literals(["average", "sum", "minimum", "maximum"]);
export type AnalysisChartAggregate = Schema.Schema.Type<typeof AnalysisChartAggregate>;

export const CategoryChartDatum = Schema.Struct({
	label: Schema.String,
	value: Schema.Number
});
export type CategoryChartDatum = Schema.Schema.Type<typeof CategoryChartDatum>;

export const HistogramChartDatum = Schema.Struct({
	count: NonNegativeInt,
	label: Schema.String
});
export type HistogramChartDatum = Schema.Schema.Type<typeof HistogramChartDatum>;

export const ScatterChartDatum = Schema.Struct({
	rowName: Schema.String,
	series: Schema.String,
	x: Schema.Number,
	y: Schema.Number
});
export type ScatterChartDatum = Schema.Schema.Type<typeof ScatterChartDatum>;

const AnalysisChartPlanBase = {
	description: Schema.String,
	id: Schema.String,
	source: Schema.Literals(["specified", "suggested"]),
	title: Schema.String
};

export const AnalysisChartPlan = Schema.Union([
	Schema.Struct({
		...AnalysisChartPlanBase,
		data: Schema.Array(CategoryChartDatum),
		kind: Schema.Literals(["category-count", "category-value"]),
		xLabel: Schema.String,
		yLabel: Schema.String
	}),
	Schema.Struct({
		...AnalysisChartPlanBase,
		data: Schema.Array(HistogramChartDatum),
		kind: Schema.Literal("histogram"),
		xLabel: Schema.String,
		yLabel: Schema.String
	}),
	Schema.Struct({
		...AnalysisChartPlanBase,
		colorLabel: Schema.NullOr(Schema.String),
		data: Schema.Array(ScatterChartDatum),
		kind: Schema.Literal("scatter"),
		xLabel: Schema.String,
		yLabel: Schema.String
	})
]);
export type AnalysisChartPlan = Schema.Schema.Type<typeof AnalysisChartPlan>;

export const AnalysisPlan = Schema.Struct({
	charts: Schema.Array(AnalysisChartPlan),
	contract: Schema.Struct({
		name: Schema.Literal("unreal-authoring-analysis"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
	}),
	issues: Schema.Array(Schema.String),
	profiledColumnCount: NonNegativeInt,
	rowCount: NonNegativeInt,
	tableObjectPath: Schema.String
});
export type AnalysisPlan = Schema.Schema.Type<typeof AnalysisPlan>;

export type SpecifiedAnalysisChart =
	| {
			readonly categoryFieldName: string;
			readonly id: string;
			readonly kind: "category-count";
			readonly title: string;
	  }
	| {
			readonly aggregate: AnalysisChartAggregate;
			readonly categoryFieldName: string;
			readonly id: string;
			readonly kind: "category-value";
			readonly title: string;
			readonly valueFieldName: string;
	  }
	| {
			readonly bins?: number;
			readonly id: string;
			readonly kind: "histogram";
			readonly title: string;
			readonly valueFieldName: string;
	  }
	| {
			readonly colorFieldName?: string;
			readonly id: string;
			readonly kind: "scatter";
			readonly title: string;
			readonly xFieldName: string;
			readonly yFieldName: string;
	  };

interface AnalysisColumn {
	readonly fieldName: string;
	readonly label: string;
	readonly order: number;
	readonly type?: AuthoringTypeDescriptor;
}

interface ColumnProfile {
	readonly column: AnalysisColumn;
	readonly kind: "category" | "number" | "unsupported";
	readonly nonNullCount: number;
	readonly uniqueCount: number;
}

const analysisContract = {
	name: "unreal-authoring-analysis" as const,
	version: { major: 1 as const, minor: 0 as const }
};

function fieldValue(row: AuthoringRow, fieldName: string): AuthoringValue | undefined {
	return row.fields.find((field) => field.name === fieldName)?.value;
}

function asNumber(value: AuthoringValue | undefined): number | null {
	if (value === undefined) return null;
	switch (value.kind) {
		case "int":
		case "uint": {
			const parsed = Number(value.value);
			return Number.isFinite(parsed) ? parsed : null;
		}
		case "float":
		case "double": {
			if (
				value.value === "nan" ||
				value.value === "infinity" ||
				value.value === "-infinity"
			) {
				return null;
			}
			return value.value;
		}
		default:
			return null;
	}
}

function asCategory(value: AuthoringValue | undefined): string | null {
	if (value === undefined) return null;
	switch (value.kind) {
		case "bool":
			return value.value ? "True" : "False";
		case "enum":
		case "name":
		case "string":
		case "text": {
			const trimmed = value.value.trim();
			return trimmed.length > 0 ? trimmed : null;
		}
		default:
			return null;
	}
}

function isNumericType(type: AuthoringTypeDescriptor | undefined): boolean {
	return (
		type?.kind === "scalar" &&
		(type.valueKind === "int" ||
			type.valueKind === "uint" ||
			type.valueKind === "float" ||
			type.valueKind === "double")
	);
}

function isCategoryType(
	type: AuthoringTypeDescriptor | undefined,
	declaredCategory: boolean
): boolean {
	if (type?.kind === "enum") return true;
	if (type?.kind === "scalar" && type.valueKind === "bool") return true;
	return (
		declaredCategory &&
		type?.kind === "scalar" &&
		(type.valueKind === "name" || type.valueKind === "string" || type.valueKind === "text")
	);
}

function isInferredCategoryValue(value: AuthoringValue, declaredCategory: boolean): boolean {
	if (value.kind === "bool" || value.kind === "enum") return true;
	return (
		declaredCategory &&
		(value.kind === "name" || value.kind === "string" || value.kind === "text")
	);
}

function analysisColumns(snapshot: AuthoringTableSnapshot): readonly AnalysisColumn[] {
	if ("producer" in snapshot && snapshot.table.schema.status === "available") {
		return snapshot.table.schema.fields.map((descriptor, order) => ({
			fieldName: descriptor.name,
			label: descriptor.annotations.displayName ?? descriptor.name,
			order,
			type: descriptor.type
		}));
	}
	const columns = new Map<string, AnalysisColumn>();
	for (const row of snapshot.table.rows) {
		for (const field of row.fields) {
			if (columns.has(field.name)) continue;
			columns.set(field.name, {
				fieldName: field.name,
				label: field.name,
				order: columns.size
			});
		}
	}
	return [...columns.values()];
}

function profileColumn(
	column: AnalysisColumn,
	rows: readonly AuthoringRow[],
	declaredCategory: boolean
): ColumnProfile {
	let nonNullCount = 0;
	let numericCount = 0;
	let categoricalCount = 0;
	const unique = new Set<string>();
	const allowCategory = isCategoryType(column.type, declaredCategory);
	const allowNumber = column.type === undefined ? true : isNumericType(column.type);

	for (const row of rows) {
		const value = fieldValue(row, column.fieldName);
		if (value === undefined) continue;
		if (allowNumber) {
			const numeric = asNumber(value);
			if (numeric !== null) {
				nonNullCount++;
				numericCount++;
				unique.add(String(numeric));
				continue;
			}
		}
		if (
			allowCategory ||
			(column.type === undefined && isInferredCategoryValue(value, declaredCategory))
		) {
			const category = asCategory(value);
			if (category !== null) {
				nonNullCount++;
				categoricalCount++;
				unique.add(category);
			}
		}
	}

	if (nonNullCount > 0 && numericCount === nonNullCount) {
		return { column, kind: "number", nonNullCount, uniqueCount: unique.size };
	}
	if (nonNullCount > 0 && categoricalCount === nonNullCount && unique.size >= 2) {
		return { column, kind: "category", nonNullCount, uniqueCount: unique.size };
	}
	return { column, kind: "unsupported", nonNullCount, uniqueCount: unique.size };
}

function formatNumber(value: number): string {
	const magnitude = Math.abs(value);
	if (magnitude >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (magnitude >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	if (magnitude > 0 && magnitude < 0.01) return value.toPrecision(2);
	return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, "");
}

function categoryCountData(rows: readonly AuthoringRow[], fieldName: string): CategoryChartDatum[] {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const label = asCategory(fieldValue(row, fieldName));
		if (label === null) continue;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([label, value]) => ({ label, value }))
		.toSorted(
			(left, right) => right.value - left.value || left.label.localeCompare(right.label)
		);
}

function aggregateValues(values: readonly number[], aggregate: AnalysisChartAggregate): number {
	switch (aggregate) {
		case "average":
			return values.reduce((total, value) => total + value, 0) / values.length;
		case "sum":
			return values.reduce((total, value) => total + value, 0);
		case "minimum":
			return Math.min(...values);
		case "maximum":
			return Math.max(...values);
	}
}

function categoryValueData(
	rows: readonly AuthoringRow[],
	categoryFieldName: string,
	valueFieldName: string,
	aggregate: AnalysisChartAggregate
): CategoryChartDatum[] {
	const valuesByCategory = new Map<string, number[]>();
	for (const row of rows) {
		const label = asCategory(fieldValue(row, categoryFieldName));
		const value = asNumber(fieldValue(row, valueFieldName));
		if (label === null || value === null) continue;
		const values = valuesByCategory.get(label);
		if (values) values.push(value);
		else valuesByCategory.set(label, [value]);
	}
	return [...valuesByCategory.entries()]
		.map(([label, values]) => ({ label, value: aggregateValues(values, aggregate) }))
		.toSorted(
			(left, right) => right.value - left.value || left.label.localeCompare(right.label)
		);
}

function histogramData(
	rows: readonly AuthoringRow[],
	fieldName: string,
	requestedBins?: number
): HistogramChartDatum[] {
	const values = rows
		.map((row) => asNumber(fieldValue(row, fieldName)))
		.filter((value): value is number => value !== null);
	if (values.length === 0) return [];
	const minimum = Math.min(...values);
	const maximum = Math.max(...values);
	if (minimum === maximum) {
		return [{ count: values.length, label: formatNumber(minimum) }];
	}
	const defaultBins = Math.ceil(Math.log2(values.length) + 1);
	const binCount = Math.min(24, Math.max(2, Math.floor(requestedBins ?? defaultBins)));
	const width = (maximum - minimum) / binCount;
	const counts = Array.from({ length: binCount }, () => 0);
	for (const value of values) {
		const index = Math.min(binCount - 1, Math.floor((value - minimum) / width));
		counts[index] = (counts[index] ?? 0) + 1;
	}
	return counts.map((count, index) => {
		const start = minimum + index * width;
		const end = index === binCount - 1 ? maximum : start + width;
		return { count, label: `${formatNumber(start)}–${formatNumber(end)}` };
	});
}

function scatterData(
	rows: readonly AuthoringRow[],
	xFieldName: string,
	yFieldName: string,
	colorFieldName?: string
): ScatterChartDatum[] {
	const data: ScatterChartDatum[] = [];
	for (const row of rows) {
		const x = asNumber(fieldValue(row, xFieldName));
		const y = asNumber(fieldValue(row, yFieldName));
		if (x === null || y === null) continue;
		data.push({
			rowName: row.name,
			series: colorFieldName
				? (asCategory(fieldValue(row, colorFieldName)) ?? "Other")
				: "Rows",
			x,
			y
		});
		if (data.length >= 1_000) break;
	}
	return data;
}

function chartSignature(chart: SpecifiedAnalysisChart): string {
	switch (chart.kind) {
		case "category-count":
			return `${chart.kind}:${chart.categoryFieldName}`;
		case "category-value":
			return `${chart.kind}:${chart.categoryFieldName}:${chart.valueFieldName}:${chart.aggregate}`;
		case "histogram":
			return `${chart.kind}:${chart.valueFieldName}`;
		case "scatter":
			return `${chart.kind}:${chart.xFieldName}:${chart.yFieldName}:${chart.colorFieldName ?? ""}`;
	}
}

function buildChartPlan(
	chart: SpecifiedAnalysisChart,
	columnsByName: ReadonlyMap<string, AnalysisColumn>,
	rows: readonly AuthoringRow[],
	source: AnalysisChartPlan["source"],
	issues: string[]
): AnalysisChartPlan | null {
	function label(fieldName: string): string | null {
		const column = columnsByName.get(fieldName);
		if (!column) issues.push(`Chart ${chart.title} references missing field ${fieldName}.`);
		return column?.label ?? null;
	}

	switch (chart.kind) {
		case "category-count": {
			const xLabel = label(chart.categoryFieldName);
			if (!xLabel) return null;
			const data = categoryCountData(rows, chart.categoryFieldName);
			if (data.length === 0) return null;
			return {
				data,
				description: `${data.length} categories across ${rows.length} rows`,
				id: chart.id,
				kind: chart.kind,
				source,
				title: chart.title,
				xLabel,
				yLabel: "Rows"
			};
		}
		case "category-value": {
			const xLabel = label(chart.categoryFieldName);
			const valueLabel = label(chart.valueFieldName);
			if (!xLabel || !valueLabel) return null;
			const data = categoryValueData(
				rows,
				chart.categoryFieldName,
				chart.valueFieldName,
				chart.aggregate
			);
			if (data.length === 0) return null;
			return {
				data,
				description: `${chart.aggregate} ${valueLabel.toLocaleLowerCase()} for ${data.length} categories`,
				id: chart.id,
				kind: chart.kind,
				source,
				title: chart.title,
				xLabel,
				yLabel: valueLabel
			};
		}
		case "histogram": {
			const xLabel = label(chart.valueFieldName);
			if (!xLabel) return null;
			const data = histogramData(rows, chart.valueFieldName, chart.bins);
			if (data.length === 0) return null;
			const observationCount = data.reduce((total, datum) => total + datum.count, 0);
			return {
				data,
				description: `${observationCount} values grouped into ${data.length} numeric ranges`,
				id: chart.id,
				kind: chart.kind,
				source,
				title: chart.title,
				xLabel,
				yLabel: "Rows"
			};
		}
		case "scatter": {
			const xLabel = label(chart.xFieldName);
			const yLabel = label(chart.yFieldName);
			const colorLabel = chart.colorFieldName ? label(chart.colorFieldName) : null;
			if (!xLabel || !yLabel || (chart.colorFieldName && !colorLabel)) return null;
			const data = scatterData(
				rows,
				chart.xFieldName,
				chart.yFieldName,
				chart.colorFieldName
			);
			if (data.length === 0) return null;
			return {
				colorLabel,
				data,
				description: `${data.length} paired observations${colorLabel ? `, colored by ${colorLabel}` : ""}`,
				id: chart.id,
				kind: chart.kind,
				source,
				title: chart.title,
				xLabel,
				yLabel
			};
		}
	}
}

function suggestedCharts(profiles: readonly ColumnProfile[]): SpecifiedAnalysisChart[] {
	const categories = profiles
		.filter((profile) => profile.kind === "category")
		.toSorted(
			(left, right) =>
				left.uniqueCount - right.uniqueCount ||
				right.nonNullCount - left.nonNullCount ||
				left.column.order - right.column.order
		);
	const numbers = profiles
		.filter((profile) => profile.kind === "number" && profile.uniqueCount > 1)
		.toSorted(
			(left, right) =>
				right.nonNullCount - left.nonNullCount || left.column.order - right.column.order
		);
	const charts: SpecifiedAnalysisChart[] = [];

	for (const profile of categories.slice(0, 2)) {
		charts.push({
			categoryFieldName: profile.column.fieldName,
			id: `suggested:count:${profile.column.fieldName}`,
			kind: "category-count",
			title: `${profile.column.label} distribution`
		});
	}
	for (const profile of numbers.slice(0, 3)) {
		charts.push({
			id: `suggested:histogram:${profile.column.fieldName}`,
			kind: "histogram",
			title: `${profile.column.label} distribution`,
			valueFieldName: profile.column.fieldName
		});
	}
	const firstCategory = categories[0];
	if (firstCategory) {
		for (const profile of numbers.slice(0, 2)) {
			charts.push({
				aggregate: "average",
				categoryFieldName: firstCategory.column.fieldName,
				id: `suggested:average:${firstCategory.column.fieldName}:${profile.column.fieldName}`,
				kind: "category-value",
				title: `Average ${profile.column.label} by ${firstCategory.column.label}`,
				valueFieldName: profile.column.fieldName
			});
		}
	}
	if (numbers.length >= 2) {
		charts.push({
			...(firstCategory ? { colorFieldName: firstCategory.column.fieldName } : undefined),
			id: `suggested:scatter:${numbers[0]!.column.fieldName}:${numbers[1]!.column.fieldName}`,
			kind: "scatter",
			title: `${numbers[1]!.column.label} vs ${numbers[0]!.column.label}`,
			xFieldName: numbers[0]!.column.fieldName,
			yFieldName: numbers[1]!.column.fieldName
		});
	}

	return charts;
}

export function buildAnalysisPlan(args: {
	readonly categoricalFieldNames?: readonly string[];
	readonly charts?: readonly SpecifiedAnalysisChart[];
	readonly rows?: readonly AuthoringRow[];
	readonly snapshot: AuthoringTableSnapshot;
}): AnalysisPlan {
	const rows = args.rows ?? args.snapshot.table.rows;
	const declaredCategory = new Set(args.categoricalFieldNames ?? []);
	const columns = analysisColumns(args.snapshot);
	const profiles = columns.map((column) =>
		profileColumn(column, rows, declaredCategory.has(column.fieldName))
	);
	const columnsByName = new Map(columns.map((column) => [column.fieldName, column]));
	const issues: string[] = [];
	const charts: AnalysisChartPlan[] = [];
	const signatures = new Set<string>();

	for (const chart of args.charts ?? []) {
		const plan = buildChartPlan(chart, columnsByName, rows, "specified", issues);
		if (plan) {
			charts.push(plan);
			signatures.add(chartSignature(chart));
		}
	}
	for (const chart of suggestedCharts(profiles)) {
		const signature = chartSignature(chart);
		if (signatures.has(signature)) continue;
		const plan = buildChartPlan(chart, columnsByName, rows, "suggested", issues);
		if (plan) {
			charts.push(plan);
			signatures.add(signature);
		}
	}

	return {
		charts,
		contract: analysisContract,
		issues,
		profiledColumnCount: profiles.filter((profile) => profile.kind !== "unsupported").length,
		rowCount: rows.length,
		tableObjectPath: args.snapshot.table.objectPath
	};
}
