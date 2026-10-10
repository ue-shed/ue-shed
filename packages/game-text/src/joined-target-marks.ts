import { Effect } from "effect";
import {
	LocalizationIdentity,
	TextNamespace,
	TextKey,
	localizationReviewFingerprint
} from "@ue-shed/localization";
import type { JoinedColumns, JoinedTargetInput } from "./joined-target.js";
import { stateBit } from "./joined-target.js";
import { absent, occurrenceLocation, packagePath } from "./joined-target-input.js";
import type { SharedIndexReader, SharedIndexWriter } from "./shared-index.js";
import { manifestPlace, type LocalizationKeyChangePair } from "./localization-key-changes.js";
import { textFileKey } from "./text-origin.js";

const placeKey = (path: string) =>
	path
		.trim()
		.replaceAll("\\", "/")
		.toLowerCase()
		.replace(/\((\d+)\)/gu, "[$1]");
const place = (location: ReturnType<typeof occurrenceLocation>) =>
	location.kind === "string_table_entry"
		? undefined
		: location.kind === "data_table_cell"
			? placeKey(`${location.objectPath}.${location.row}.${location.propertyPath}`)
			: location.propertyPath === ""
				? undefined
				: placeKey(`${location.objectPath}.${location.propertyPath}`);
export function translationId(columns: JoinedColumns, row: number, culture: number) {
	const marks = columns.culture[culture]!,
		fromPO = Boolean(marks.facts![row]! & stateBit("not_synced"));
	const index = (fromPO ? marks.po![row]! : marks.archive![row]!) - 1;
	if (index < 0) return null;
	const input = (fromPO ? columns.pos : columns.archives)[culture]!.columns;
	return input.options![index]! & 128 ? input.source![index]! : input.translation![index]!;
}
export const finishJoinedTarget = Effect.fn("JoinedTarget.marks")(function* (
	input: JoinedTargetInput,
	columns: JoinedColumns,
	_reader: SharedIndexReader,
	writer: SharedIndexWriter
) {
	const { line, count, culture, manifest, manifestOrder, packages, order, strings, empty } =
		columns;
	const m = manifest.columns;
	const isSaved = (row: number) => line.occ_end![row]! > line.occ_start![row]!;
	const isResolved = (row: number) => !(line.reasons![row]! & ((1 << 9) | (1 << 10)));
	const manifestRow = (row: number) =>
		line.manifest_start![row] === line.manifest_end![row]
			? absent
			: manifestOrder[line.manifest_start![row]!]!;
	const manifestSource = (row: number) => {
		const first = manifestRow(row);
		return first === absent ? line.source![row]! : m.source![first]!;
	};
	const manifestPath = (row: number) =>
		(m.options![row]! & 1024 ? manifest.pathPrefix : "") + strings.string(m.path![row]!);
	const matches = (row: number, state: string) =>
		culture.some(
			(marks) =>
				marks.state![row] ===
				[
					"translated",
					"not_translated",
					"needs_update",
					"not_synced",
					"not_gathered",
					"changed_since_gather",
					"not_found",
					"gathered_only",
					"outside_target",
					"unknown"
				].indexOf(state)
		);
	const oldRows: number[] = [];
	for (let row = 0; row < count; row++)
		if (!isSaved(row) && isResolved(row) && matches(row, "not_found")) oldRows.push(row);
	const pairs: LocalizationKeyChangePair[] = [];
	let ambiguous = 0;
	const paired = new Uint8Array(count);
	// Only earlier candidates own decoded place keys. Fresh lines are visited one at a time.
	// Reverse counts and the matching new->old pointers are typed columns, not candidate objects.
	if (oldRows.length) {
		const wantedSources = new Map(
			oldRows.map((row) => [manifestSource(row), { gathered: 0, saved: 0 }])
		);
		for (let row = 0; row < count; row++) {
			if (manifestRow(row) !== absent) {
				const counts = wantedSources.get(manifestSource(row));
				if (counts) counts.gathered++;
			}
			if (isSaved(row)) {
				const counts = wantedSources.get(line.source![row]!);
				if (counts) counts.saved++;
			}
		}
		const keys = (row: number, tier: number, loose = false): readonly string[] => {
			const source = isSaved(row) ? line.source![row]! : manifestSource(row);
			if (tier === 2) {
				const counts = wantedSources.get(source);
				return source === empty ||
					(!loose && (isSaved(row) ? counts?.saved : counts?.gathered) !== 1)
					? []
					: [String(source)];
			}
			const values = new Set<string>();
			if (isSaved(row))
				for (let i = line.occ_start![row]!; i < line.occ_end![row]!; i++) {
					const occurrence = order[i]!;
					const value =
						tier === 0
							? place(occurrenceLocation(packages, occurrence))
							: source === empty
								? undefined
								: `${textFileKey(packagePath(packages, packages.packageRow[occurrence]!))}\0${source}`;
					if (value !== undefined) values.add(value);
				}
			else
				for (let i = line.manifest_start![row]!; i < line.manifest_end![row]!; i++) {
					const path = manifestPath(manifestOrder[i]!);
					const value =
						tier === 0
							? manifestPlace(path)
							: source === empty
								? undefined
								: `${textFileKey(path)}\0${source}`;
					if (value !== undefined) values.add(value);
				}
			return [...values];
		};
		const buildIndex = (tier: number, loose = false) => {
			const index = new Map<string, Set<number>>();
			for (const row of oldRows)
				if (!paired[row])
					for (const key of keys(row, tier, loose)) {
						const rows = index.get(key) ?? new Set<number>();
						rows.add(row);
						index.set(key, rows);
					}
			return index;
		};
		const reachable = (
			row: number,
			tier: number,
			index: ReadonlyMap<string, ReadonlySet<number>>,
			loose = false
		) => {
			const result = new Set<number>();
			for (const key of keys(row, tier, loose))
				for (const old of index.get(key) ?? []) result.add(old);
			return result;
		};
		for (let tier = 0; tier < 3; tier++) {
			const index = buildIndex(tier),
				forward = new Uint32Array(count),
				reverse = new Uint32Array(count);
			for (let row = 0; row < count; row++)
				if (
					!paired[row] &&
					isSaved(row) &&
					isResolved(row) &&
					matches(row, "not_gathered")
				) {
					const older = reachable(row, tier, index);
					for (const old of older) reverse[old]!++;
					if (older.size === 1) forward[row] = [...older][0]! + 1;
				}
			for (let row = 0; row < count; row++) {
				const old = forward[row]! - 1;
				if (old < 0 || reverse[old] !== 1 || paired[old]) continue;
				const sourceIds = [
					line.namespace![old]!,
					line.key![old]!,
					line.namespace![row]!,
					line.key![row]!,
					manifestSource(old)
				];
				const decoded = yield* writer.strings(sourceIds);
				const translations: LocalizationKeyChangePair["translations"][number][] = [];
				for (let ci = 0; ci < culture.length; ci++) {
					if (input.target.cultures[ci] === input.target.nativeCulture) continue;
					const id = translationId(columns, old, ci);
					if (id !== null && id !== empty)
						translations.push({
							culture: input.target.cultures[ci]!,
							translation: (yield* writer.strings([id]))[0]!
						});
				}
				pairs.push({
					from: LocalizationIdentity.make({
						namespace: TextNamespace.make(decoded[0]!),
						key: TextKey.make(decoded[1]!)
					}),
					to: LocalizationIdentity.make({
						namespace: TextNamespace.make(decoded[2]!),
						key: TextKey.make(decoded[3]!)
					}),
					match: (["same_place", "same_text_in_package", "same_text"] as const)[tier]!,
					sourceChanged: manifestSource(old) !== line.source![row],
					previousSource: decoded[4]!,
					translations
				});
				line.key_change![row] = pairs.length * 2;
				line.key_change![old] = pairs.length * 2 + 1;
				paired[row] = 1;
				paired[old] = 1;
			}
		}
		const indexes = [0, 1, 2].map((tier) => buildIndex(tier, true));
		for (let row = 0; row < count; row++)
			if (
				!paired[row] &&
				isSaved(row) &&
				isResolved(row) &&
				matches(row, "not_gathered") &&
				indexes.some((index, tier) => reachable(row, tier, index, true).size > 0)
			)
				ambiguous++;
	}
	const review = input.review?.target === input.target.name ? input.review : undefined;
	if (review) {
		const records = new Map<string, number>();
		for (let start = 0; start < review.records.length; start += 4096) {
			const batch = review.records.slice(start, start + 4096);
			const ids = yield* writer.intern(
				"identity",
				batch.flatMap((record) => [record.namespace, record.key])
			);
			for (let row = 0; row < batch.length; row++)
				records.set(
					`${batch[row]!.culture}:${ids[row * 2]}:${ids[row * 2 + 1]}`,
					start + row
				);
		}
		for (let row = 0; row < count; row++)
			if (isResolved(row))
				for (let ci = 0; ci < culture.length; ci++) {
					const marks = culture[ci]!,
						recordIndex = records.get(
							`${input.target.cultures[ci]}:${line.namespace![row]}:${line.key![row]}`
						);
					marks.review![row] = 1;
					if (recordIndex === undefined) continue;
					const id = translationId(columns, row, ci),
						source = manifestSource(row);
					const decoded = yield* writer.strings(id === null ? [source] : [source, id]);
					marks.review![row] =
						review.records[recordIndex]!.fingerprint ===
						localizationReviewFingerprint(decoded[0]!, id === null ? null : decoded[1]!)
							? 2
							: 3;
					marks.review_record![row] = recordIndex + 1;
				}
	}
	for (let row = 0; row < count; row++) {
		let problems = line.problems![row]!;
		if (line.key_change![row] && !(line.key_change![row]! & 1)) problems |= 1;
		if (line.reasons![row]! & (1 << 11)) problems |= 2;
		if (matches(row, "not_gathered")) problems |= 4;
		if (matches(row, "changed_since_gather")) problems |= 8;
		if (
			culture.some(
				(marks) =>
					marks.state![row] === 1 ||
					marks.state![row] === 2 ||
					marks.facts![row]! & stateBit("not_synced")
			)
		)
			problems |= 16;
		line.problems![row] = problems || 64;
	}
	return { pairs, ambiguous, oldCandidates: oldRows.length };
});
