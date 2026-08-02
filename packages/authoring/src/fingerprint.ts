import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AuthoringTableSnapshot, AuthoringValue } from "@ue-shed/protocol";

export const FINGERPRINT_VERSION = "sha256-v1" as const;

function normalizeValue(value: AuthoringValue): unknown {
	switch (value.kind) {
		case "float":
			return {
				kind: value.kind,
				value: typeof value.value === "number" ? Math.fround(value.value) : value.value
			};
		case "array":
			return { kind: value.kind, values: value.values.map(normalizeValue) };
		case "set":
			return {
				kind: value.kind,
				values: value.values.map(normalizeValue).toSorted(compareCanonical)
			};
		case "map":
			return {
				kind: value.kind,
				entries: value.entries
					.map((entry) => ({
						key: normalizeValue(entry.key),
						value: normalizeValue(entry.value)
					}))
					.toSorted(compareCanonical)
			};
		case "struct":
			return {
				kind: value.kind,
				fields: value.fields.map((field) => ({
					name: field.name,
					typeName: field.typeName,
					value: normalizeValue(field.value)
				}))
			};
		default:
			return value;
	}
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const entries = Object.keys(record)
		.toSorted()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
	return `{${entries.join(",")}}`;
}

function compareCanonical(left: unknown, right: unknown): number {
	return canonicalJson(left).localeCompare(canonicalJson(right));
}

export function semanticTableJson(snapshot: AuthoringTableSnapshot): string {
	return canonicalJson({
		kind: snapshot.table.kind,
		objectPath: snapshot.table.objectPath,
		parentTables: snapshot.table.parentTables,
		rowStruct: snapshot.table.rowStruct,
		rows: snapshot.table.rows.map((row) => ({
			fields: row.fields.map((field) => ({
				name: field.name,
				typeName: field.typeName,
				value: normalizeValue(field.value)
			})),
			name: row.name
		}))
	});
}

export function fingerprintTable(snapshot: AuthoringTableSnapshot): string {
	const digest = sha256(new TextEncoder().encode(semanticTableJson(snapshot)));
	return `${FINGERPRINT_VERSION}:${bytesToHex(digest)}`;
}
