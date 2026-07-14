import type { TextureAuditReport, TextureRecord } from "./schema.js";

export type DistributionSelection =
	| { readonly kind: "maximumDimension"; readonly key: string }
	| { readonly kind: "textureGroup"; readonly key: string }
	| { readonly kind: "compression"; readonly key: string }
	| { readonly kind: "sRGB"; readonly key: string };

export function maximumDimensionKey(record: TextureRecord): string {
	if (record.dimensions.status !== "available") return "unavailable";
	const maximum = Math.max(record.dimensions.value.width, record.dimensions.value.height);
	if (maximum <= 256) return "le-256";
	if (maximum <= 512) return "257-512";
	if (maximum <= 1024) return "513-1024";
	return "gt-1024";
}

function matchesSelection(record: TextureRecord, selection: DistributionSelection): boolean {
	if (selection.kind === "maximumDimension") return maximumDimensionKey(record) === selection.key;
	const evidence = record[selection.kind];
	const key = evidence.status === "available" ? String(evidence.value) : "Unavailable";
	return key === selection.key;
}

export function filterTextureReport(
	report: TextureAuditReport,
	selection: DistributionSelection | undefined
): readonly TextureRecord[] {
	return selection
		? report.records.filter((record) => matchesSelection(record, selection))
		: report.records;
}
