import { relative } from "node:path";

import type { LocalizationJoin, TextCorpus } from "../packages/game-text/dist/index.js";
import { localizationStates, LocalizationUnknownReason } from "../packages/game-text/dist/index.js";
import {
	snapshotStringTableBuilder,
	type SnapshotColumn
} from "../packages/game-text/src/snapshot-format.ts";

/** Phase 2 layout probe, not the Phase 5 join implementation or a public hydration contract. */
export function joinedTargetSnapshot(root: string, corpus: TextCorpus, join: LocalizationJoin) {
	const table = snapshotStringTableBuilder("identity");
	const source = snapshotStringTableBuilder("source");
	source.intern("");
	const paths = snapshotStringTableBuilder("paths");
	const comments = snapshotStringTableBuilder("comments");
	const cultures = join.cultures.map((_, i) => snapshotStringTableBuilder(`c${i}`));
	for (const domain of [paths, comments, ...cultures]) domain.intern("");
	table.intern(""); // ID zero is the optional-value sentinel; presence remains in state/sparse columns.
	const columns: SnapshotColumn[] = [];
	const ids = (name: string, values: Uint32Array) =>
		columns.push({ name, kind: "stringIds", values });
	const numbers = (name: string, values: Uint32Array) =>
		columns.push({ name, kind: "u32", values });
	const bytes = (name: string, values: Uint8Array) => columns.push({ name, kind: "u8", values });
	const count = join.lines.length;
	const width = join.cultures.length;
	const lineIds = new Uint32Array(count);
	const namespaces = new Uint32Array(count);
	const keys = new Uint32Array(count);
	const sources = new Uint32Array(count);
	const places = new Uint32Array(count);
	const origins = new Uint8Array(count);
	const states = new Uint8Array(count * width);
	const facts = new Uint32Array(count * width);
	const reasons = new Uint32Array(count * width);
	const reduced = new Uint8Array(count * width);
	const translations = cultures.map(() => new Uint32Array(count));
	const poByCulture = cultures.map(() => {
		const rows: number[] = [];
		const ids: number[] = [];
		return { rows, ids };
	});
	const reviewRows: number[] = [],
		reviewIds: number[] = [],
		changeRows: number[] = [],
		changeIds: number[] = [];
	const unitLines = new Map<string, number>();
	const masks = (values: readonly string[], dictionary: readonly string[]) =>
		values.reduce((bits, value) => bits | (1 << dictionary.indexOf(value)), 0);
	for (let index = 0; index < count; index++) {
		const line = join.lines[index]!;
		lineIds[index] = table.intern(line.id);
		namespaces[index] = table.intern(line.identity?.namespace ?? "");
		keys[index] = table.intern(line.identity?.key ?? "");
		sources[index] = source.intern(line.source);
		places[index] = paths.intern(line.manifest[0]?.path ?? "");
		origins[index] = line.origin.kind === "corpus" ? 0 : 1;
		if (line.origin.kind === "corpus")
			for (const id of line.origin.unitIds) unitLines.set(id, index);
		for (let culture = 0; culture < width; culture++) {
			const mark = line.cultures[culture]!;
			if (mark.culture !== join.cultures[culture]) throw new Error("Culture order differs");
			const row = index * width + culture;
			states[row] = localizationStates.indexOf(mark.state);
			facts[row] = masks(mark.facts, localizationStates);
			reasons[row] = masks(mark.unknownReasons, LocalizationUnknownReason.literals);
			reduced[row] = Number(mark.reducedSourceChecking);
			translations[culture]![index] = cultures[culture]!.intern(
				mark.archive?.translation.Text ?? ""
			);
			if (
				mark.poTranslation !== null &&
				mark.poTranslation !== mark.archive?.translation.Text
			) {
				poByCulture[culture]!.rows.push(index);
				poByCulture[culture]!.ids.push(cultures[culture]!.intern(mark.poTranslation));
			}
			if (mark.review !== undefined && mark.review.status !== "not_reviewed") {
				reviewRows.push(row);
				reviewIds.push(comments.intern(JSON.stringify(mark.review)));
			}
		}
		if (line.keyChange !== undefined) {
			changeRows.push(index);
			changeIds.push(comments.intern(JSON.stringify(line.keyChange)));
		}
	}
	const occurrenceCount = corpus.coverage.textOccurrences;
	const occurrenceLines = new Uint32Array(occurrenceCount);
	const packages = new Uint32Array(occurrenceCount);
	const objects = new Uint32Array(occurrenceCount);
	const properties = new Uint32Array(occurrenceCount);
	const rows = new Uint32Array(occurrenceCount);
	const occurrenceIds = new Uint32Array(occurrenceCount);
	const kinds = new Uint8Array(occurrenceCount);
	let cursor = 0;
	for (const unit of corpus.units) {
		const line = unitLines.get(unit.id);
		if (line === undefined) throw new Error("Occurrence has no joined line");
		for (const occurrence of unit.occurrences) {
			occurrenceLines[cursor] = line;
			packages[cursor] = paths.intern(
				relative(root, occurrence.packageFile).replaceAll("\\", "/")
			);
			objects[cursor] = paths.intern(occurrence.location.objectPath);
			properties[cursor] = paths.intern(
				occurrence.location.kind === "string_table_entry"
					? occurrence.location.entryKey
					: occurrence.location.propertyPath
			);
			rows[cursor] = paths.intern(
				occurrence.location.kind === "data_table_cell" ? occurrence.location.row : ""
			);
			occurrenceIds[cursor] = table.intern(occurrence.id);
			kinds[cursor] = ["asset_property", "data_table_cell", "string_table_entry"].indexOf(
				occurrence.location.kind
			);
			cursor++;
		}
	}
	if (cursor !== occurrenceCount) throw new Error("Occurrence count differs");
	ids(
		"culture.names",
		Uint32Array.from(join.cultures, (culture) => table.intern(culture))
	);
	ids("line.id", lineIds);
	ids("line.namespace", namespaces);
	ids("line.key", keys);
	ids("line.source", sources);
	ids("line.place", places);
	bytes("line.origin", origins);
	for (let culture = 0; culture < width; culture++) {
		const domain = cultures[culture]!;
		columns.push({
			name: `c${culture}.translation`,
			kind: "stringIds",
			values: translations[culture]!,
			domain: `c${culture}`,
			stringCount: domain.count
		});
		numbers(`c${culture}.po.rows`, Uint32Array.from(poByCulture[culture]!.rows));
		columns.push({
			name: `c${culture}.po.ids`,
			kind: "stringIds",
			values: Uint32Array.from(poByCulture[culture]!.ids),
			domain: `c${culture}`,
			stringCount: domain.count
		});
	}
	// Per-culture hot columns remain independent as well.
	for (const [name, values, kind] of [
		["state", states, "u8"],
		["facts", facts, "u32"],
		["reasons", reasons, "u32"],
		["reduced", reduced, "u8"]
	] as const) {
		for (let culture = 0; culture < width; culture++) {
			const column = kind === "u8" ? new Uint8Array(count) : new Uint32Array(count);
			for (let row = 0; row < count; row++) column[row] = values[row * width + culture]!;
			columns.push({ name: `c${culture}.${name}`, kind, values: column });
		}
	}
	numbers("review.rows", Uint32Array.from(reviewRows));
	ids("review.values", Uint32Array.from(reviewIds));
	numbers("change.rows", Uint32Array.from(changeRows));
	ids("change.values", Uint32Array.from(changeIds));
	numbers("occurrence.line", occurrenceLines);
	ids("occurrence.package", packages);
	ids("occurrence.object", objects);
	ids("occurrence.property", properties);
	ids("occurrence.row", rows);
	ids("occurrence.id", occurrenceIds);
	bytes("occurrence.kind", kinds);
	const tables = {
		identity: table,
		source,
		paths,
		comments,
		...Object.fromEntries(cultures.map((value, i) => [`c${i}`, value]))
	};
	const assigned = columns.map((column): SnapshotColumn => {
		if (column.kind !== "stringIds" || column.domain !== undefined) return column;
		const domain =
			column.name === "line.place" ||
			[
				"occurrence.package",
				"occurrence.object",
				"occurrence.property",
				"occurrence.row"
			].includes(column.name)
				? "paths"
				: ["review.values", "change.values"].includes(column.name)
					? "comments"
					: column.name === "line.source"
						? "source"
						: "identity";
		return { ...column, domain, stringCount: tables[domain]!.count };
	});
	return {
		columns: [...assigned, ...Object.values(tables).flatMap((value) => [...value.finish()])],
		dimensions: {
			lines: count,
			occurrences: cursor,
			cultures: width,
			strings: Object.values(tables).reduce((sum, value) => sum + value.count, 0)
		}
	};
}
