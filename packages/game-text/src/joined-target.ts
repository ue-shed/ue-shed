import { createHash } from "node:crypto";
import { Effect, Schema, Option } from "effect";
import {
	stripPackageNamespace,
	type LocalizationTarget,
	type LocalizationReviewFile
} from "@ue-shed/localization";
import { SharedIndex } from "./shared-index.js";
import { snapshotCheck } from "./snapshot-format.js";
import type { SnapshotSourceColumn } from "./snapshot-file.js";
import { snapshotNodeChecksum } from "./snapshot-file.js";
import { localizationStates, LocalizationUnknownReason } from "./localization-schema.js";
import { localizationTextMatches, manifestPackageFile } from "./localization.js";
import { textFileLabel, textFolderLabel, manifestPathOrigin } from "./text-origin.js";
import {
	absent,
	JoinStrings,
	loadJoinFile,
	loadJoinPackages,
	packagePath,
	packageStatus,
	normalizedPackagePath,
	unitId,
	type JoinFile,
	type JoinPackages
} from "./joined-target-input.js";
import { finishJoinedTarget } from "./joined-target-marks.js";
import { incrementJoinedTarget } from "./joined-target-incremental.js";
import { comparePackageTextPathBytes } from "./package-text-order.js";

const noteMetadata = Schema.decodeUnknownOption(
	Schema.fromJsonString(
		Schema.Struct({
			Info: Schema.optionalKey(Schema.Struct({ Comment: Schema.optionalKey(Schema.String) }))
		})
	)
);

export interface JoinedTargetInput {
	readonly projectRoot: string;
	readonly target: LocalizationTarget;
	readonly review?: LocalizationReviewFile;
	/** Failed file paths and their typed localization error codes, supplied by the importer. */
	readonly fileErrors?: Readonly<Record<string, string>>;
	readonly force?: boolean;
}
export const stateBit = (state: (typeof localizationStates)[number]) =>
	1 << localizationStates.indexOf(state);
export const reasonBit = (reason: (typeof LocalizationUnknownReason.literals)[number]) =>
	1 << LocalizationUnknownReason.literals.indexOf(reason);
export const precedence = [8, 4, 6, 7, 5, 9, 3, 2, 1, 0];
export interface JoinedColumns {
	readonly line: Record<string, Uint32Array>;
	readonly culture: readonly Record<string, Uint32Array>[];
	readonly order: Uint32Array;
	readonly manifestOrder: Uint32Array;
	readonly packages: JoinPackages;
	readonly manifest: JoinFile;
	readonly archives: readonly JoinFile[];
	readonly pos: readonly JoinFile[];
	readonly strings: JoinStrings;
	readonly count: number;
	readonly empty: number;
}

function compareUnit(c: JoinPackages["occurrence"], a: number, b: number, empty: number) {
	const ak = c.key[a]! === empty ? 2 : Math.min(2, c.identity[a]!),
		bk = c.key[b]! === empty ? 2 : Math.min(2, c.identity[b]!);
	if (ak !== bk) return ak - bk;
	if (ak < 2) return c.namespace[a]! - c.namespace[b]! || c.key[a]! - c.key[b]!;
	return (
		c.object[a]! - c.object[b]! ||
		c.location[a]! - c.location[b]! ||
		c.row[a]! - c.row[b]! ||
		c.property[a]! - c.property[b]!
	);
}

/** Re-sort shared ID tuples after append/compaction; merge cursors never compare decoded keys. */
export const refreshJoinedTarget = Effect.fn("JoinedTarget.refresh")(function* (
	input: JoinedTargetInput
) {
	const store = yield* SharedIndex,
		writer = yield* store.writer(),
		root = writer.manifest();
	const paths = [
		input.target.outputPaths.manifest ?? "<manifest>",
		...input.target.cultures.flatMap((culture) => [
			input.target.outputPaths.archives[culture] ?? `<archive:${culture}>`,
			input.target.outputPaths.portableObjects[culture] ?? `<po:${culture}>`
		])
	];
	const dependencies = Object.fromEntries(
		Object.entries(root.active)
			.filter(([name]) => name.startsWith("package-text.") || paths.includes(name))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	);
	const key =
		"joined-v5:" +
		createHash("sha256")
			.update(
				JSON.stringify([
					root.generation,
					input.projectRoot,
					dependencies,
					input.target,
					input.review ?? null,
					input.fileErrors ?? {}
				])
			)
			.digest("hex");
	if (!input.force && root.active.joined === key) {
		yield* store.cached(key);
		return {
			rebuilt: false,
			key,
			bytes: root.layers[key]!.bytes,
			count: null,
			keyChanges: null
		};
	}
	const reader = yield* store.open();
	let incrementalFallback: string | undefined;
	if (!input.force && root.active.joined?.startsWith("joined-v5:")) {
		const incremental = yield* incrementJoinedTarget(
			input,
			key,
			dependencies,
			reader,
			writer,
			(reason) => {
				incrementalFallback = reason;
			}
		);
		if (incremental) return incremental;
	}
	const empty = (yield* writer.intern("identity", [""]))[0]!;
	const strings = new JoinStrings(reader, empty);
	const manifest = yield* loadJoinFile(reader, paths[0]!, input.fileErrors?.[paths[0]!]);
	const archives: JoinFile[] = [],
		pos: JoinFile[] = [];
	for (let culture = 0; culture < input.target.cultures.length; culture++) {
		archives.push(
			yield* loadJoinFile(
				reader,
				paths[culture * 2 + 1]!,
				input.fileErrors?.[paths[culture * 2 + 1]!]
			)
		);
		pos.push(
			yield* loadJoinFile(
				reader,
				paths[culture * 2 + 2]!,
				input.fileErrors?.[paths[culture * 2 + 2]!]
			)
		);
	}
	const packages = yield* loadJoinPackages(reader, strings, input.projectRoot, input.target);
	const c = packages.occurrence,
		occurrenceCount = c.source.length;
	// The native projection emits sorted package paths and preserves traversal order
	// within each package. Shared IDs and shard rows do not encode that order.
	const pathOrder = Uint32Array.from(packages.paths, (_, row) => row);
	pathOrder.sort((a, b) =>
		comparePackageTextPathBytes(
			strings.bytes(packages.paths[a]!),
			strings.bytes(packages.paths[b]!)
		)
	);
	const pathRank = new Uint32Array(pathOrder.length);
	for (let rank = 0; rank < pathOrder.length; rank++) pathRank[pathOrder[rank]!] = rank;
	const emissionOrder = (a: number, b: number) =>
		pathRank[packages.packageRow[a]!]! - pathRank[packages.packageRow[b]!]! || a - b;
	yield* strings.need([
		c.source,
		c.notes,
		c.object,
		c.property,
		c.row,
		...(manifest.columns.path
			? [manifest.columns.path, manifest.columns.notes!, manifest.columns.metadata!]
			: []),
		...[manifest, ...archives].flatMap((file) =>
			file.columns["source-extra"] ? [file.columns["source-extra"]!] : []
		)
	]);
	const last = reader.manifest.segments.at(-1),
		maximumId = last ? last.start + last.count : 0;
	const normalized = new Uint32Array(maximumId).fill(absent);
	const namespaces = c.namespace.slice().sort();
	for (let start = 0; start < namespaces.length; ) {
		const ids: number[] = [];
		while (start < namespaces.length && ids.length < 8192) {
			const id = namespaces[start++]!;
			ids.push(id);
			while (start < namespaces.length && namespaces[start] === id) start++;
		}
		const values = yield* reader.strings(ids);
		const gathered = yield* writer.intern("identity", values.map(stripPackageNamespace));
		for (let row = 0; row < ids.length; row++) normalized[ids[row]!] = gathered[row]!;
	}
	let tableCount = 0;
	for (let row = 0; row < occurrenceCount; row++)
		if (c.location[row] === 2 && c.identity[row] === 0 && c.key[row] !== empty) tableCount++;
	const tables = new Uint32Array(tableCount);
	let tableIndex = 0;
	for (let row = 0; row < occurrenceCount; row++)
		if (c.location[row] === 2 && c.identity[row] === 0 && c.key[row] !== empty)
			tables[tableIndex++] = row;
	tables.sort((a, b) => c.object[a]! - c.object[b]! || c.row[a]! - c.row[b]! || a - b);
	for (let start = 0; start < tables.length; ) {
		let end = start + 1;
		const first = tables[start]!;
		while (
			end < tables.length &&
			c.object[tables[end]!] === c.object[first] &&
			c.row[tables[end]!] === c.row[first]
		)
			end++;
		if (end - start > 1) {
			let selected = first,
				selectedUnit: string | undefined;
			for (let i = start + 1; i < end; i++) {
				const candidate = tables[i]!;
				if (
					c.namespace[candidate] === c.namespace[selected] &&
					c.key[candidate] === c.key[selected]
				) {
					selected = candidate;
					continue;
				}
				if (selectedUnit === undefined) {
					const values = yield* reader.strings([
						c.namespace[selected]!,
						c.key[selected]!
					]);
					selectedUnit = unitId(packages, selected, values[0]!, values[1]!);
				}
				const values = yield* reader.strings([c.namespace[candidate]!, c.key[candidate]!]);
				const candidateUnit = unitId(packages, candidate, values[0]!, values[1]!);
				if (candidateUnit.localeCompare(selectedUnit) >= 0) {
					selected = candidate;
					selectedUnit = candidateUnit;
				}
			}
			// gathered-text.ts visits saved units in locale order, and the last entry wins.
			for (let i = start; i < end; i++) tables[i] = selected;
		}
		start = end;
	}
	const namespacesByOccurrence = new Uint32Array(occurrenceCount).fill(absent),
		keys = new Uint32Array(occurrenceCount).fill(absent);
	for (let row = 0; row < occurrenceCount; row++) {
		if (c.key[row] === empty) continue;
		if (c.identity[row] === 0) {
			namespacesByOccurrence[row] =
				c.location[row] === 2 ? c.namespace[row]! : normalized[c.namespace[row]!]!;
			keys[row] = c.key[row]!;
		} else if (c.identity[row] === 1) {
			let low = 0,
				high = tables.length;
			while (low < high) {
				const mid = (low + high) >>> 1,
					entry = tables[mid]!;
				if (
					c.object[entry]! < c.namespace[row]! ||
					(c.object[entry] === c.namespace[row] && c.row[entry]! < c.key[row]!)
				)
					low = mid + 1;
				else high = mid;
			}
			const entry = tables[low];
			if (
				entry !== undefined &&
				c.object[entry] === c.namespace[row] &&
				c.row[entry] === c.key[row]
			) {
				namespacesByOccurrence[row] = c.namespace[entry]!;
				keys[row] = c.key[entry]!;
			}
		}
	}
	const compareOccurrence = (a: number, b: number) =>
		namespacesByOccurrence[a]! - namespacesByOccurrence[b]! ||
		keys[a]! - keys[b]! ||
		(namespacesByOccurrence[a] === absent
			? compareUnit(c, a, b, empty) ||
				(c.identity[a]! < 2 && c.key[a] !== empty
					? 0
					: packages.packageRow[a]! - packages.packageRow[b]!)
			: 0);
	const order = Uint32Array.from({ length: occurrenceCount }, (_, row) => row);
	order.sort((a, b) => compareOccurrence(a, b) || emissionOrder(a, b));
	// A saved unit can contribute to several gathered identities. This pass groups raw units;
	// the split-identity STOP regression records its remaining line-scoped findings mismatch.
	const rawOrder = Uint32Array.from(order);
	const rawCompare = (a: number, b: number) =>
		compareUnit(c, a, b, empty) ||
		(c.identity[a]! < 2 && c.key[a] !== empty
			? 0
			: packages.packageRow[a]! - packages.packageRow[b]!);
	rawOrder.sort((a, b) => rawCompare(a, b) || emissionOrder(a, b));
	const unit = new Uint32Array(occurrenceCount),
		next = new Uint32Array(occurrenceCount).fill(absent);
	const unitOrigins = new Uint8Array(occurrenceCount),
		unitEditing = new Uint8Array(occurrenceCount),
		unitNotes = new Uint8Array(occurrenceCount),
		unitProblems = new Uint8Array(occurrenceCount);
	for (let start = 0; start < rawOrder.length; ) {
		let end = start + 1;
		const first = rawOrder[start]!;
		while (end < rawOrder.length && rawCompare(first, rawOrder[end]!) === 0) end++;
		let length = 0;
		const sources = new Set<number>();
		for (let i = start; i < end; i++) {
			const occurrence = rawOrder[i]!;
			unit[occurrence] = first;
			if (i + 1 < end) next[occurrence] = rawOrder[i + 1]!;
			unitOrigins[first]! |=
				1 << (c.location[occurrence] === 2 ? 0 : c.location[occurrence] === 1 ? 1 : 2);
			unitEditing[first]! |= c.editable[occurrence] ? 1 : 2;
			if (c.notes[occurrence] !== empty && strings.string(c.notes[occurrence]!).trim() !== "")
				unitNotes[first] = 1;
			if (length < 40 && !sources.has(c.source[occurrence]!)) {
				const bytes = strings.bytes(c.source[occurrence]!);
				length +=
					(sources.size ? 1 : 0) +
					(bytes.length >= 120 ? 40 : bytes.toString("utf8").length);
				sources.add(c.source[occurrence]!);
			}
		}
		if (length >= 40 || c.identity[first]! >= 2 || c.key[first] === empty)
			unitProblems[first] = 32;
		start = end;
	}
	const m = manifest.columns,
		mo = manifest.order;
	// A two-pass merge sizes the output exactly, without a JS row staging array.
	function* groups() {
		let oi = 0,
			mi = 0;
		while (oi < order.length || mi < mo.length) {
			const orow = order[oi],
				mrow = mo[mi];
			const ons = orow === undefined ? absent : namespacesByOccurrence[orow]!,
				oks = orow === undefined ? absent : keys[orow]!;
			const mns = mrow === undefined ? absent : m.namespace![mrow]!,
				mks = mrow === undefined ? absent : m.key![mrow]!;
			const comparison =
				orow === undefined ? 1 : mrow === undefined ? -1 : ons - mns || oks - mks;
			const os = oi,
				ms = mi;
			if (comparison <= 0) {
				oi++;
				while (oi < order.length && compareOccurrence(orow!, order[oi]!) === 0) oi++;
			}
			if (comparison >= 0) {
				mi++;
				while (mi < mo.length && m.namespace![mo[mi]!] === mns && m.key![mo[mi]!] === mks)
					mi++;
			}
			yield {
				os,
				oe: oi,
				ms,
				me: mi,
				ns: comparison <= 0 ? ons : mns,
				key: comparison <= 0 ? oks : mks
			};
		}
	}
	let count = 0;
	for (const _group of groups()) count++;
	const line = Object.fromEntries(
		[
			"namespace",
			"key",
			"source",
			"occ_start",
			"occ_end",
			"manifest_start",
			"manifest_end",
			"reasons",
			"facts",
			"problems",
			"origins",
			"editing",
			"notes",
			"key_change",
			"folder_start",
			"folder_end",
			"file_start",
			"file_end",
			"split_unit"
		].map((name) => [name, new Uint32Array(count)])
	);
	const culture = input.target.cultures.map(() =>
		Object.fromEntries(
			["state", "facts", "reasons", "archive", "po", "review", "review_record"].map(
				(name) => [name, new Uint32Array(count)]
			)
		)
	);
	const cursors = culture.map(() => ({ archive: 0, po: 0 }));
	const columns: JoinedColumns = {
		line,
		culture,
		order,
		manifestOrder: mo,
		packages,
		manifest,
		archives,
		pos,
		strings,
		count,
		empty
	};
	const folders = new Map<string, number>(),
		folderValues: string[] = [];
	let folderRows = new Uint32Array(Math.max(4096, count)),
		folderCount = 0;
	const appendFolder = (id: number) => {
		if (folderCount === folderRows.length) {
			const next = new Uint32Array(folderRows.length * 2);
			next.set(folderRows);
			folderRows = next;
		}
		folderRows[folderCount++] = id;
	};
	const folder = (value: string) => {
		let id = folders.get(value);
		if (id === undefined) {
			id = folderValues.length;
			folders.set(value, id);
			folderValues.push(value);
		}
		return id;
	};
	const packageFolders = new Uint32Array(packages.paths.length);
	const packageFiles = new Uint32Array(packages.paths.length);
	let fileRows = new Uint32Array(Math.max(4096, count)),
		fileCount = 0;
	const appendFile = (id: number) => {
		if (fileCount === fileRows.length) {
			const values = new Uint32Array(fileRows.length * 2);
			values.set(fileRows);
			fileRows = values;
		}
		fileRows[fileCount++] = id;
	};
	const pendingFiles: { row: number; value: string }[] = [];
	const flushFiles = Effect.fn("JoinedTarget.files")(function* () {
		const ids = yield* writer.intern(
			"paths",
			pendingFiles.map((item) => item.value)
		);
		for (let index = 0; index < ids.length; index++)
			packageFiles[pendingFiles[index]!.row] = ids[index]!;
		pendingFiles.length = 0;
	});
	let previousFolderPackage = absent;
	for (const row of packages.packageRow)
		if (row !== previousFolderPackage) {
			previousFolderPackage = row;
			const label = textFileLabel(packagePath(packages, row));
			packageFolders[row] = folder(textFolderLabel(label));
			pendingFiles.push({ row, value: label });
			if (pendingFiles.length === 8192) yield* flushFiles();
		}
	if (pendingFiles.length) yield* flushFiles();
	const pendingSources: { row: number; value: string }[] = [];
	const flushSources = Effect.fn("JoinedTarget.sources")(function* () {
		if (!pendingSources.length) return;
		const ids = yield* writer.intern(
			"source",
			pendingSources.map((item) => item.value)
		);
		for (let index = 0; index < ids.length; index++)
			line.source![pendingSources[index]!.row] = ids[index]!;
		pendingSources.length = 0;
	});
	const path = (row: number) =>
		(m.options![row]! & 1024 ? manifest.pathPrefix : "") + strings.string(m.path![row]!);
	const manifestFiles = new Uint32Array(mo.length);
	const pendingEvidenceFiles: { row: number; value: string }[] = [];
	const flushEvidenceFiles = Effect.fn("JoinedTarget.evidenceFiles")(function* () {
		const ids = yield* writer.intern(
			"paths",
			pendingEvidenceFiles.map((item) => item.value)
		);
		for (let i = 0; i < ids.length; i++) manifestFiles[pendingEvidenceFiles[i]!.row] = ids[i]!;
		pendingEvidenceFiles.length = 0;
	});
	for (const group of groups())
		if (group.os === group.oe) {
			for (let i = group.ms; i < group.me; i++) {
				const row = mo[i]!;
				pendingEvidenceFiles.push({ row, value: textFileLabel(path(row)) });
				if (pendingEvidenceFiles.length === 8192) yield* flushEvidenceFiles();
			}
		}
	if (pendingEvidenceFiles.length) yield* flushEvidenceFiles();
	const statusReason = (status: number | undefined) =>
		reasonBit(
			status === 1
				? "package_partial"
				: status === 3
					? "package_failed"
					: "package_not_scanned"
		);
	const absenceStatus = (file: string) =>
		packageStatus(packages, normalizedPackagePath(file)) ??
		packageStatus(packages, normalizedPackagePath(file).replace(/\.uasset$/u, ".umap"));
	const sameExtra = (a: number, b: number) =>
		a === b ||
		localizationTextMatches(
			{ Text: "", ...JSON.parse(strings.string(a) || "{}") },
			{ Text: "", ...JSON.parse(strings.string(b) || "{}") }
		);
	function lookup(file: JoinFile, ns: number, keyId: number, cursor: number) {
		const f = file.columns,
			rows = file.order;
		while (cursor < rows.length) {
			const row = rows[cursor]!;
			if (
				f.options![row]! & 16 ||
				f.namespace![row]! < ns ||
				(f.namespace![row] === ns && f.key![row]! < keyId)
			)
				cursor++;
			else break;
		}
		const start = cursor;
		while (
			cursor < rows.length &&
			f.namespace![rows[cursor]!] === ns &&
			f.key![rows[cursor]!] === keyId
		)
			cursor++;
		return { cursor, row: cursor === start ? absent : rows[start]!, count: cursor - start };
	}
	let row = 0;
	for (const group of groups()) {
		const { os, oe, ms, me, ns, key: keyId } = group;
		line.namespace![row] = ns === absent ? empty : ns;
		line.key![row] = ns === absent ? empty : keyId;
		line.occ_start![row] = os;
		line.occ_end![row] = oe;
		line.manifest_start![row] = ms;
		line.manifest_end![row] = me;
		const first = ms === me ? absent : mo[ms]!;
		let reasons = 0,
			structural = 0;
		let authored = false,
			hasReference = false;
		for (let i = os; i < oe; i++) {
			const occurrence = order[i]!;
			if (c.identity[occurrence] === 1 && c.key[occurrence] !== empty) hasReference = true;
			else authored = true;
		}
		const sources = new Set<number>(),
			insidePackages = new Set<number>(),
			rowFolders = new Set<number>(),
			rowUnits = new Set<number>(),
			rowFiles = new Set<number>();
		let inside = false,
			outside = true,
			coverageReasons = 0,
			origins = 0,
			editing = 0,
			notes = 0;
		for (let i = os; i < oe; i++) {
			const occurrence = order[i]!,
				pkg = packages.packageRow[occurrence]!;
			const representative = unit[occurrence]!;
			origins |= unitOrigins[representative]!;
			editing |= unitEditing[representative]!;
			notes |= unitNotes[representative]!;
			if (!rowUnits.has(representative)) {
				rowUnits.add(representative);
				for (let member = representative; member !== absent; member = next[member]!) {
					rowFolders.add(packageFolders[packages.packageRow[member]!]!);
					rowFiles.add(packageFiles[packages.packageRow[member]!]!);
				}
			}
			if (authored && c.identity[occurrence] === 1 && c.key[occurrence] !== empty) continue;
			sources.add(c.source[occurrence]!);
			insidePackages.add(pkg);
			const coverage = packages.coverage[occurrence]!;
			inside ||= coverage === 1;
			outside &&= coverage === 0;
			if (coverage >= 2)
				coverageReasons |= reasonBit(
					(
						[
							"gather_settings_unavailable",
							"class_hierarchy_unavailable",
							"asset_class_unavailable",
							"path_not_project_relative"
						] as const
					)[coverage - 2]!
				);
		}
		if (ns === absent)
			reasons |= reasonBit(
				hasReference ? "string_table_namespace_unavailable" : "unresolved_identity"
			);
		if (!manifest.reader) reasons |= reasonBit("missing_manifest");
		if (me - ms > 1) reasons |= reasonBit("duplicate_manifest_identity");
		if (sources.size > 1) reasons |= reasonBit("conflicting_source");
		line.source![row] =
			sources.values().next().value ?? (first === absent ? empty : m.source![first]!);
		if (sources.size > 1) {
			const occurrenceRows = order.slice(os, oe);
			const unitStrings = new Map<number, string>();
			const selectedIds = new Set<number>();
			for (const i of occurrenceRows) {
				selectedIds.add(c.namespace[i]!);
				selectedIds.add(c.key[i]!);
			}
			const rawIds = [...selectedIds];
			const decoded = yield* reader.strings(rawIds);
			const rawStrings = new Map(rawIds.map((id, i) => [id, decoded[i]!]));
			for (const i of occurrenceRows)
				unitStrings.set(
					i,
					unitId(
						packages,
						i,
						rawStrings.get(c.namespace[i]!)!,
						rawStrings.get(c.key[i]!)!
					)
				);
			occurrenceRows.sort(
				(a, b) =>
					unitStrings.get(a)!.localeCompare(unitStrings.get(b)!) || emissionOrder(a, b)
			);
			const orderedSources = new Set<number>();
			for (const i of occurrenceRows)
				if (!authored || c.identity[i] !== 1) orderedSources.add(c.source[i]!);
			const value = [...orderedSources].map((id) => strings.string(id)).join(" ");
			snapshotCheck(
				Buffer.byteLength(value) <= 1024 ** 2,
				"join.source",
				"Joined source exceeds bound"
			);
			pendingSources.push({ row, value });
			if (pendingSources.length === 8192) yield* flushSources();
		}
		if (oe > os) {
			if (outside) structural |= stateBit("outside_target");
			else if (!inside) reasons |= coverageReasons;
			else if (first === absent && manifest.reader && ns !== absent)
				structural |= stateBit("not_gathered");
			if (first !== absent && sources.size === 1 && line.source![row] !== m.source![first])
				structural |= stateBit("changed_since_gather");
			for (let i = ms; i < me; i++) {
				const file = manifestPackageFile(path(mo[i]!));
				if (!file) continue;
				const wanted = normalizedPackagePath(file),
					alternative = wanted.replace(/\.uasset$/u, ".umap");
				let present = false;
				for (const pkg of insidePackages) {
					const saved = normalizedPackagePath(packagePath(packages, pkg));
					if (saved === wanted || saved === alternative) {
						present = true;
						break;
					}
				}
				if (present) continue;
				const status = absenceStatus(file);
				if (status === 0) structural |= stateBit("not_found");
				else reasons |= statusReason(status);
			}
		} else if (first !== absent) {
			let gatheredOnly = true;
			for (let i = ms; i < me; i++) {
				const manifestIndex = mo[i]!,
					value = path(manifestIndex);
				if (
					m.options![manifestIndex]! & 4 &&
					strings.string(m.notes![manifestIndex]!).trim() !== ""
				)
					notes = 1;
				if (m.options![manifestIndex]! & 8) {
					const info = noteMetadata(strings.string(m.metadata![manifestIndex]!) || "{}");
					if (Option.isSome(info) && (info.value.Info?.Comment ?? "").trim() !== "")
						notes = 1;
				}
				if (
					manifestPackageFile(value) ||
					value.replaceAll("\\", "/").replace(/^\.\//u, "").startsWith("/")
				)
					gatheredOnly = false;
				rowFolders.add(folder(textFolderLabel(textFileLabel(value))));
				rowFiles.add(manifestFiles[manifestIndex]!);
				origins |=
					1 <<
					(manifestPathOrigin(value) === "cpp"
						? 3
						: manifestPathOrigin(value) === "asset"
							? 2
							: 4);
			}
			if (gatheredOnly) structural |= stateBit("gathered_only");
			else {
				for (let i = ms; i < me; i++) {
					const file = manifestPackageFile(path(mo[i]!));
					const status = file ? absenceStatus(file) : undefined;
					if (status !== 0) reasons |= statusReason(status);
				}
				if (!reasons) structural |= stateBit("not_found");
			}
			editing = 2;
		}
		line.reasons![row] = reasons;
		line.facts![row] = structural;
		line.origins![row] = origins;
		line.editing![row] = editing;
		line.notes![row] = notes;
		line.folder_start![row] = folderCount;
		for (const id of rowFolders) appendFolder(id);
		line.folder_end![row] = folderCount;
		line.file_start![row] = fileCount;
		for (const id of rowFiles) appendFile(id);
		line.file_end![row] = fileCount;
		for (let ci = 0; ci < culture.length; ci++) {
			const archiveFile = archives[ci]!,
				poFile = pos[ci]!,
				cursor = cursors[ci]!;
			const a =
				ns === absent
					? { cursor: cursor.archive, row: absent, count: 0 }
					: lookup(archiveFile, ns, keyId, cursor.archive);
			const p =
				ns === absent
					? { cursor: cursor.po, row: absent, count: 0 }
					: lookup(poFile, ns, keyId, cursor.po);
			cursor.archive = a.cursor;
			cursor.po = p.cursor;
			const ac = archiveFile.columns,
				pc = poFile.columns,
				marks = culture[ci]!;
			let unknown = reasons,
				facts = structural;
			if (!archiveFile.reader) unknown |= reasonBit("missing_archive");
			if (!poFile.reader) unknown |= reasonBit("missing_po");
			if (a.count > 1) unknown |= reasonBit("duplicate_archive_identity");
			if (p.count > 1) unknown |= reasonBit("duplicate_po_identity");
			if (input.target.collapseMode === "IdenticalNamespaceAndSource")
				unknown |= reasonBit("ambiguous_po_identity");
			const at =
				a.row === absent
					? empty
					: ac.options![a.row]! & 128
						? ac.source![a.row]!
						: ac.translation![a.row]!;
			const pt =
				p.row === absent || !(pc.options![p.row]! & 64)
					? empty
					: pc.options![p.row]! & 128
						? pc.source![p.row]!
						: pc.translation![p.row]!;
			if (
				(archiveFile.reader || archiveFile.missing) &&
				a.count <= 1 &&
				p.count === 1 &&
				pt !== empty &&
				pt !== at
			)
				facts |= stateBit("not_synced");
			const matches =
				a.count === 1 &&
				me - ms === 1 &&
				ac.source![a.row] === m.source![first] &&
				sameExtra(ac["source-extra"]![a.row]!, m["source-extra"]![first]!);
			if (a.count === 1 && me - ms === 1 && !matches) facts |= stateBit("needs_update");
			if ((archiveFile.reader || archiveFile.missing) && a.count <= 1) {
				if (a.row === absent || at === empty) facts |= stateBit("not_translated");
				else if (matches) facts |= stateBit("translated");
			}
			let operative = unknown;
			if (!archiveFile.reader && archiveFile.missing)
				operative &= ~reasonBit("missing_archive");
			if (!poFile.reader && poFile.missing) operative &= ~reasonBit("missing_po");
			if (operative) facts |= stateBit("unknown");
			marks.state![row] = precedence.find((state) => facts & (1 << state)) ?? 9;
			marks.facts![row] = facts;
			marks.reasons![row] = unknown;
			marks.archive![row] = a.row === absent ? 0 : a.row + 1;
			marks.po![row] = p.row === absent ? 0 : p.row + 1;
		}
		row++;
	}
	yield* flushSources();
	const sourceFirst = new Uint32Array(maximumId).fill(absent);
	const unitFirstLine = new Uint32Array(occurrenceCount).fill(absent);
	for (let row = 0; row < count; row++)
		for (let i = line.occ_start![row]!; i < line.occ_end![row]!; i++) {
			const occurrence = order[i]!;
			const representative = unit[occurrence]!;
			if (unitFirstLine[representative] !== absent && unitFirstLine[representative] !== row) {
				line.split_unit![row] = 1;
				line.split_unit![unitFirstLine[representative]!] = 1;
			} else unitFirstLine[representative] = row;
			if (line.occ_end![row]! - line.occ_start![row]! > 1)
				unitProblems[representative]! |= 32;
			if (line.reasons![row]! & reasonBit("conflicting_source"))
				unitProblems[representative]! |= 2;
			if (c.identity[occurrence] === 1) continue;
			const source = c.source[occurrence]!,
				previous = sourceFirst[source]!;
			if (previous === absent) sourceFirst[source] = row;
			else if (previous !== row) {
				unitProblems[representative]! |= 32;
				for (let j = line.occ_start![previous]!; j < line.occ_end![previous]!; j++)
					if (c.source[order[j]!] === source) unitProblems[unit[order[j]!]!]! |= 32;
			}
		}
	for (let row = 0; row < count; row++)
		for (let i = line.occ_start![row]!; i < line.occ_end![row]!; i++)
			line.problems![row]! |= unitProblems[unit[order[i]!]!]!;
	const folderIds = new Uint32Array(folderValues.length);
	for (let start = 0; start < folderValues.length; start += 8192)
		folderIds.set(
			yield* writer.intern("paths", folderValues.slice(start, start + 8192)),
			start
		);
	const folderColumn = Uint32Array.from(
		folderRows.subarray(0, folderCount),
		(id) => folderIds[id]!
	);
	const marks = yield* finishJoinedTarget(input, columns, reader, writer);
	const sourceColumns: SnapshotSourceColumn[] = [];
	const aliases: Record<string, string> = {};
	const identical = new Map<string, { name: string; bytes: Buffer }[]>();
	function add(name: string, values: Uint32Array, domain?: string) {
		const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
		const signature = `${domain ?? "u32"}:${values.length}:${snapshotNodeChecksum(bytes)}`;
		const candidates = identical.get(signature) ?? [];
		const match = candidates.find((candidate) => Buffer.compare(bytes, candidate.bytes) === 0);
		if (match) {
			aliases[name] = match.name;
			return;
		}
		candidates.push({ name, bytes });
		identical.set(signature, candidates);
		sourceColumns.push({
			name,
			kind: domain ? "stringIds" : "u32",
			...(domain ? { domain } : undefined),
			load: async () => values
		});
	}
	for (const [name, values] of Object.entries(line))
		add(
			`line.${name}`,
			values,
			name === "namespace" || name === "key"
				? "identity"
				: name === "source"
					? "source"
					: undefined
		);
	for (let ci = 0; ci < culture.length; ci++)
		for (const [name, values] of Object.entries(culture[ci]!)) add(`c${ci}.${name}`, values);
	add("occurrence.rows", order);
	add("manifest.rows", mo);
	add("facet.folders", folderColumn, "paths");
	add("facet.files", fileRows.subarray(0, fileCount), "paths");
	add(
		"line.folder",
		Uint32Array.from(line.folder_start!, (start) => folderColumn[start]!),
		"paths"
	);
	const meta = new TextEncoder().encode(
		JSON.stringify({
			version: 3,
			count,
			input,
			aliases,
			generation: root.generation,
			dependencies,
			packageNames: packages.names,
			packageStarts: packages.starts,
			pairs: marks.pairs,
			ambiguous: marks.ambiguous,
			oldCandidates: marks.oldCandidates,
			reducedSourceChecking: pos.map((file) => Boolean(file.reader && !file.hasSourceText))
		})
	);
	snapshotCheck(meta.length <= 16 * 1024 ** 2, "join.meta", "Metadata exceeds bound");
	sourceColumns.push({ name: "join.meta", kind: "bytes", load: async () => meta });
	const published = yield* writer.publishIds(
		"joined",
		key,
		{ columns: sourceColumns },
		root.generation,
		{},
		["joined-base"]
	);
	yield* Effect.annotateCurrentSpan({
		"join.lines": count,
		"join.keyChanges": marks.pairs.length,
		"join.rebuilt": true
	});
	return {
		rebuilt: true,
		strategy: "full" as const,
		incrementalFallback,
		key,
		bytes: published.bytes,
		count,
		keyChanges: marks.pairs.length
	};
});
