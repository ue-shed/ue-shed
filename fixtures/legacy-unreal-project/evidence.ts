import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonSchema, Schema, SchemaRepresentation } from "effect";

export const legacyVersions = ["4.27", "5.3"] as const;
export const legacyAssetNames = ["DA_LegacyText", "DT_LegacyText", "ST_LegacyText"] as const;

const TextEvidence = Schema.Struct({
	property_path: Schema.NonEmptyString,
	row: Schema.NullOr(Schema.String),
	source: Schema.String,
	history: Schema.Literals(["none", "base", "string_table_entry"]),
	culture_invariant: Schema.Boolean,
	namespace: Schema.NullOr(Schema.String),
	key: Schema.NullOr(Schema.String),
	table_id: Schema.NullOr(Schema.String)
});

const packageFields = {
	object_path: Schema.NonEmptyString,
	serialized_package_name: Schema.String,
	class_path: Schema.NonEmptyString,
	versions: Schema.Struct({
		ue4: Schema.Int,
		ue5: Schema.NullOr(Schema.Int),
		licensee: Schema.Int
	})
};

export const LegacyEvidence = Schema.Struct({
	schema_version: Schema.Literal(1),
	engine_version: Schema.Literals(legacyVersions),
	packages: Schema.Array(
		Schema.Union([
			Schema.Struct({
				...packageFields,
				asset_name: Schema.Literal("DA_LegacyText"),
				texts: Schema.Array(TextEvidence)
			}),
			Schema.Struct({
				...packageFields,
				asset_name: Schema.Literal("DT_LegacyText"),
				rows: Schema.Array(
					Schema.Struct({
						name: Schema.NonEmptyString,
						texts: Schema.Array(TextEvidence),
						vectors: Schema.Array(
							Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])
						)
					})
				)
			}),
			Schema.Struct({
				...packageFields,
				asset_name: Schema.Literal("ST_LegacyText"),
				namespace: Schema.String,
				entries: Schema.Array(
					Schema.Struct({
						key: Schema.NonEmptyString,
						source: Schema.String,
						metadata: Schema.Record(Schema.String, Schema.String)
					})
				)
			})
		])
	)
});

export type LegacyEvidence = typeof LegacyEvidence.Type;
export type LegacyTextEvidence = typeof TextEvidence.Type;

// UE 4.27 usually saves `None` as the summary package name; the parser then resolves top-level
// exports to their bare object name, because the mounted path needs caller context.
export function legacySerializedObjectPath(asset: LegacyEvidence["packages"][number]) {
	return asset.serialized_package_name === "None"
		? asset.asset_name
		: `${asset.serialized_package_name}.${asset.asset_name}`;
}

// SAFETY: this repository-owned schema is the language-neutral commandlet evidence contract.
const neutralSchema: JsonSchema.JsonSchema = JSON.parse(
	readFileSync(fileURLToPath(new URL("./evidence.schema.json", import.meta.url)), "utf8")
);
const decodeNeutralEvidence = Schema.decodeUnknownSync(
	SchemaRepresentation.toSchema<Schema.Codec<unknown>>(
		SchemaRepresentation.fromJsonSchemaDocument(
			JsonSchema.fromSchemaDraft2020_12(neutralSchema)
		)
	),
	{ onExcessProperty: "error" }
);

export function expectedLegacyOccurrences(evidence: LegacyEvidence): Schema.Json[] {
	return evidence.packages.flatMap((asset): Schema.Json[] => {
		const objectPath = legacySerializedObjectPath(asset);
		if (asset.asset_name === "ST_LegacyText") {
			return asset.entries.map((entry) => ({
				source: entry.source,
				dev_notes: "",
				identity: { status: "resolved", namespace: asset.namespace, key: entry.key },
				location: {
					kind: "string_table_entry",
					object_path: objectPath,
					entry_key: entry.key
				},
				edit_capability: "source_editable"
			}));
		}
		const texts =
			asset.asset_name === "DT_LegacyText"
				? asset.rows.flatMap((row) => row.texts)
				: asset.texts;
		return texts.map((text) => ({
			source: text.history === "string_table_entry" ? "" : text.source,
			dev_notes: "",
			identity:
				text.history === "base"
					? { status: "resolved", namespace: text.namespace, key: text.key }
					: text.history === "string_table_entry"
						? { status: "string_table", table_id: text.table_id, key: text.key }
						: { status: "unresolved", reason: "culture_invariant" },
			location:
				text.row === null
					? {
							kind: "asset_property",
							object_path: objectPath,
							class_path: asset.class_path,
							property_path: text.property_path
						}
					: {
							kind: "data_table_cell",
							object_path: objectPath,
							row: text.row,
							property_path: text.property_path
						},
			// Without a source model for the fixture class, the data asset decodes as a generic
			// UObject, whose text the projection cannot prove source-editable.
			edit_capability: text.row === null ? "read_only" : "source_editable"
		}));
	});
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Commandlet evidence decoding boundary.
export function decodeLegacyEvidence(input: unknown): LegacyEvidence {
	const evidence = Schema.decodeUnknownSync(LegacyEvidence, { onExcessProperty: "error" })(
		decodeNeutralEvidence(input)
	);
	if (
		evidence.packages.length !== legacyAssetNames.length ||
		legacyAssetNames.some(
			(name) => evidence.packages.filter((asset) => asset.asset_name === name).length !== 1
		)
	) {
		throw new Error("Legacy evidence must contain exactly one of each fixture asset.");
	}
	const ue5 = evidence.engine_version === "4.27" ? null : 1009;
	for (const asset of evidence.packages) {
		if (
			asset.versions.ue4 !== 522 ||
			asset.versions.ue5 !== ue5 ||
			asset.versions.licensee !== 0
		) {
			throw new Error(`${asset.asset_name}: unexpected ${evidence.engine_version} versions.`);
		}
	}
	return evidence;
}

export function readLegacyEvidence(directory: string): LegacyEvidence {
	return decodeLegacyEvidence(JSON.parse(readFileSync(join(directory, "evidence.json"), "utf8")));
}
