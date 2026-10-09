import { LocalizationIdentity, stripPackageNamespace } from "@ue-shed/localization/browser";
import { Schema } from "effect";
import type { LocalizationLine } from "./localization-schema.js";
import type { TextCorpus, TextOccurrence, TextUnit } from "./schema.js";

// Built once: joins and queries decode identities for tens of thousands of saved occurrences.
const decodeLocalizationIdentity = Schema.decodeUnknownSync(LocalizationIdentity);

export function gatheredTextOccurrenceIdentity(
	occurrence: TextOccurrence
): typeof LocalizationIdentity.Type | null {
	if (occurrence.identity.status !== "resolved") return null;
	return decodeLocalizationIdentity({
		...occurrence.identity,
		namespace:
			occurrence.location.kind === "string_table_entry"
				? occurrence.identity.namespace
				: stripPackageNamespace(occurrence.identity.namespace)
	});
}

export function gatheredIdentityKey(identity: typeof LocalizationIdentity.Type): string {
	return JSON.stringify([identity.namespace, identity.key]);
}

function sliceTextUnit(unit: TextUnit, occurrences: readonly TextOccurrence[]): TextUnit {
	if (occurrences.length === unit.occurrences.length) return unit;
	const sources = [...new Set(occurrences.map((occurrence) => occurrence.source))].sort();
	return {
		...unit,
		occurrences,
		source:
			sources.length === 1
				? { status: "consistent", value: sources[0] ?? "" }
				: { status: "conflicting", values: sources }
	};
}

/** Internal occurrence slices retain the corpus unit ID and its full saved identity. */
export function gatheredTextGroups(corpus: TextCorpus) {
	const tables = new Map<string, typeof LocalizationIdentity.Type>();
	for (const unit of corpus.units) {
		for (const occurrence of unit.occurrences) {
			if (occurrence.location.kind !== "string_table_entry") continue;
			const identity = gatheredTextOccurrenceIdentity(occurrence);
			if (identity)
				tables.set(
					JSON.stringify([occurrence.location.objectPath, occurrence.location.entryKey]),
					identity
				);
		}
	}
	const rows = new Map<
		string,
		{ identity: typeof LocalizationIdentity.Type | null; units: TextUnit[] }
	>();
	for (const unit of corpus.units) {
		const slices = new Map<
			string,
			{ identity: typeof LocalizationIdentity.Type | null; occurrences: TextOccurrence[] }
		>();
		for (const occurrence of unit.occurrences) {
			const identity =
				occurrence.identity.status === "string_table"
					? (tables.get(
							JSON.stringify([occurrence.identity.tableId, occurrence.identity.key])
						) ?? null)
					: gatheredTextOccurrenceIdentity(occurrence);
			const key = identity ? gatheredIdentityKey(identity) : `unresolved:${unit.id}`;
			const slice = slices.get(key) ?? { identity, occurrences: [] };
			slice.occurrences.push(occurrence);
			slices.set(key, slice);
		}
		for (const [key, slice] of slices) {
			const row = rows.get(key) ?? { identity: slice.identity, units: [] };
			row.units.push(sliceTextUnit(unit, slice.occurrences));
			rows.set(key, row);
		}
	}
	return rows;
}

/** Resolve a line's contexts without treating every occurrence of its unit as gathered there. */
export function localizationLineUnits(
	line: LocalizationLine,
	units: ReadonlyMap<TextUnit["id"], TextUnit>
): TextUnit[] {
	if (line.origin.kind !== "corpus") return [];
	return line.origin.unitIds.flatMap((id) => {
		const unit = units.get(id);
		if (!unit) return [];
		const occurrences = unit.occurrences.filter((occurrence) => {
			const identity = gatheredTextOccurrenceIdentity(occurrence);
			return (
				identity === null ||
				(line.identity !== null &&
					gatheredIdentityKey(identity) === gatheredIdentityKey(line.identity))
			);
		});
		return occurrences.length ? [sliceTextUnit(unit, occurrences)] : [];
	});
}
