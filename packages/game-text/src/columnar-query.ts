import { Cache, Duration, Effect, Exit, Schema } from "effect";
import { runJoinedQuery } from "./joined-query-node.js";
import { QueryPlaces } from "./query-places.js";
import { encodeWtf8, decodeWtf8 } from "./wtf8.js";
import type { TextCorpusQuery } from "./query.js";
import { JoinedQueryData, querySignals, type JoinedQueryProjection } from "./joined-query-data.js";
import type { JoinedTargetReader } from "./joined-target-reader.js";
import {
	MAX_TEXT_GROUPS,
	TextProblem,
	type TextGroupBy,
	type TextGroupList,
	TextCorpusSearchRequest,
	type TextCorpusSearchCounts,
	type TextCorpusQuerySummary,
	type TextFilterField,
	type TextCultureFacet,
	TextUnitId
} from "./schema.js";
import { TEXT_PROBLEM_LABELS } from "./text-problems.js";
import { TEXT_AUDIENCE_LABELS, TextAudience } from "./text-audience-schema.js";
import { textAudienceOfMask } from "./text-audience.js";
import {
	TEXT_ORIGIN_KINDS,
	TEXT_ORIGIN_LABELS,
	emptyTextOriginCounts,
	normalizeTextPath,
	textFileKey,
	textFileScope,
	matchesTextKinds
} from "./text-origin.js";
import { validateLocalizationSelection } from "./localization-query.js";
import {
	LocalizationReviewLens,
	LocalizationUnknownReason,
	localizationStates,
	GameTextLocalizationError,
	type LocalizationSelection,
	LocalizationQueryPage,
	LocalizationLineId
} from "./localization-schema.js";

type Request = Omit<TextCorpusSearchRequest, "cursor" | "pageSize">;
const emptyCounts = () =>
	({
		all: 0,
		shared: 0,
		duplicate_source: 0,
		long: 0,
		unresolved: 0,
		conflicting: 0,
		editable: 0,
		readOnly: 0,
		withoutNotes: 0,
		origins: emptyTextOriginCounts()
	}) satisfies TextCorpusSearchCounts;
const terms = (value: string) => value.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
const countedSignals = ["shared", "duplicate_source", "long", "unresolved", "conflicting"] as const;
const origins = (mask: number) => TEXT_ORIGIN_KINDS.filter((_, bit) => mask & (1 << bit));
/** A row's audience (its index in TextAudience) from its audience mask. */
const audienceIndex = (mask: number) => TextAudience.literals.indexOf(textAudienceOfMask(mask & 7));
// Ties sort by label, as the in-memory query's tallies do.
const audienceLabels = TextAudience.literals.map((audience) => TEXT_AUDIENCE_LABELS[audience]);
const audienceRank = audienceLabels.map((label) => [...audienceLabels].sort().indexOf(label));

/** The query over an index, with the line rows behind `localizationLines` for index scans. */
export interface ColumnarTextCorpusQuery extends TextCorpusQuery {
	/**
	 * The joined rows `localizationLines` hydrates for this request, in its order, without
	 * hydrating them. The array is shared with the query's cache; read it, never modify it.
	 */
	readonly localizationRows: (
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">
	) => Uint32Array;
}

/** The published numeric columns supply predicates; only selected rows hydrate public objects. */
export function columnarTextCorpusQuery(
	joined: JoinedTargetReader,
	scannedAt?: string,
	projection?: JoinedQueryProjection,
	checkInterrupted?: () => void
): ColumnarTextCorpusQuery {
	let visited = 0;
	const checkpoint = () => {
		if (checkInterrupted && (++visited & 255) === 0) checkInterrupted();
	};
	const data = new JoinedQueryData(joined, projection),
		target = joined.meta.input.target;
	const c = (name: string) => data.column(name);
	const rawOrder = c("query.raw.order"),
		lineOrder = c("query.line.order");
	const lineStarts = c("query.line.starts");
	const places = new QueryPlaces(data);
	const cultureColumns = target.cultures.map((_, index) =>
		Object.fromEntries(
			["state", "facts", "reasons", "review", "review_record"].map((field) => [
				field,
				c(`c${index}.${field}`)
			])
		)
	);
	const joinHeader = {
		schemaVersion: 1 as const,
		target: target.name,
		nativeCulture: target.nativeCulture,
		cultures: target.cultures,
		lines: []
	};
	const raw = Object.fromEntries(
		[
			"visible",
			"signals",
			"origins",
			"editing",
			"notes",
			"audience",
			"member_start",
			"member_end",
			"source_start",
			"source_end",
			"sources",
			"file_start",
			"file_end",
			"files"
		].map((field) => [field, c(`query.raw.${field}`)])
	);
	const slice = Object.fromEntries(
		[
			"visible",
			"signals",
			"origins",
			"editing",
			"notes",
			"audience",
			"member_start",
			"member_end",
			"source_start",
			"source_end",
			"sources",
			"file_start",
			"file_end",
			"files"
		].map((field) => [field, c(`query.slice.${field}`)])
	);
	const lineFileProjection = () => {
		let starts = data.projection.columns.get("place:line_file_starts"),
			files = data.projection.columns.get("place:line_files");
		if (!starts || !files) {
			starts = new Uint32Array(joined.meta.count + 1);
			const facetFiles = c("facet.files"),
				fileStarts = c("line.file_start"),
				fileEnds = c("line.file_end");
			let count = 0;
			for (let row = 0; row < joined.meta.count; row++) {
				starts[row] = count;
				if (lineStarts[row] === lineStarts[row + 1])
					count += fileEnds[row]! - fileStarts[row]!;
				else
					for (let sr = lineStarts[row]!; sr < lineStarts[row + 1]!; sr++)
						if (slice.visible![sr])
							count += slice.file_end![sr]! - slice.file_start![sr]!;
			}
			starts[joined.meta.count] = count;
			files = new Uint32Array(count);
			let offset = 0;
			for (let row = 0; row < joined.meta.count; row++) {
				if (lineStarts[row] === lineStarts[row + 1]) {
					const values = facetFiles.subarray(fileStarts[row], fileEnds[row]);
					files.set(values, offset);
					offset += values.length;
				} else
					for (let sr = lineStarts[row]!; sr < lineStarts[row + 1]!; sr++)
						if (slice.visible![sr]) {
							const values = slice.files!.subarray(
								slice.file_start![sr],
								slice.file_end![sr]
							);
							files.set(values, offset);
							offset += values.length;
						}
			}
			data.projection.columns.set("place:line_file_starts", starts);
			data.projection.columns.set("place:line_files", files);
		}
		return { starts, files };
	};
	const lineFiles = lineFileProjection();
	const lineFlagColumns = new Uint8Array(joined.meta.count);
	const lineSavedVisible = new Uint8Array(joined.meta.count);
	for (let row = 0; row < lineFlagColumns.length; row++)
		for (let sr = lineStarts[row]!; sr < lineStarts[row + 1]!; sr++)
			if (slice.visible![sr]) {
				lineFlagColumns[row] = lineFlagColumns[row]! | slice.signals![sr]!;
				lineSavedVisible[row] = 1;
			}
	const lineFlags = (row: number) => lineFlagColumns[row]!;
	const cultureScopes = runJoinedQuery(
		Cache.make({
			capacity: 16,
			lookup: (key: string) =>
				Effect.sync(() => {
					const [selected, cultures]: [string | null, readonly string[] | null] =
						JSON.parse(key);
					return target.cultures.flatMap((culture, index) =>
						selected !== null
							? culture === selected
								? [index]
								: []
							: cultures === null || cultures.includes(culture)
								? [index]
								: []
					);
				})
		})
	);
	const cultureScope = (selection: LocalizationSelection | undefined) =>
		runJoinedQuery(
			Cache.get(
				cultureScopes,
				JSON.stringify([selection?.culture ?? null, selection?.cultures ?? null])
			)
		);
	const reviewMask = (row: number, ci: number) => {
		const columns = cultureColumns[ci]!,
			code = columns.review![row]!,
			state = columns.state![row]!;
		const current =
			code === 2
				? joined.meta.input.review!.records[columns.review_record![row]! - 1]!.flags
				: [];
		const reviewable = state === 0 || state === 2 || state === 3;
		return (
			(current.includes("reviewed") ? 1 : reviewable ? 2 : 0) |
			(reviewable && !current.includes("proofread") ? 4 : 0) |
			(code === 3 ? 8 : 0) |
			(current.includes("machine_translated") ? 16 : 0)
		);
	};
	const problemColumns = new WeakMap<readonly number[], Uint8Array>();
	const problemsFor = (scope: readonly number[]) => {
		let masks = problemColumns.get(scope);
		if (!masks) {
			masks = new Uint8Array(joined.meta.count);
			const keys = c("line.key_change");
			for (let row = 0; row < masks.length; row++) {
				const flags = lineFlagColumns[row]!,
					key = keys[row]!;
				masks[row] =
					(key > 0 && !(key & 1) ? 1 : 0) | (flags & 16 ? 2 : 0) | (flags & 15 ? 32 : 0);
			}
			for (const ci of scope) {
				const columns = cultureColumns[ci]!;
				for (let row = 0; row < masks.length; row++) {
					const state = columns.state![row]!;
					masks[row] =
						masks[row]! |
						(columns.reasons![row]! & (1 << 11) ? 2 : 0) |
						(state === 4 ? 4 : 0) |
						(state === 5 ? 8 : 0) |
						(state === 1 || state === 2 || columns.facts![row]! & 8 ? 16 : 0);
				}
			}
			for (let row = 0; row < masks.length; row++) if (!masks[row]) masks[row] = 64;
			problemColumns.set(scope, masks);
		}
		return masks;
	};
	const problemMask = (row: number, scope: readonly number[]) => problemsFor(scope)[row]!;
	let sourceQuery = "",
		sourceCache: Uint8Array = new Uint8Array();
	let asciiTerms: Buffer[] | undefined;
	const prepareTextSearch = (wanted: readonly string[]) => {
		const key = JSON.stringify(wanted);
		if (sourceQuery !== key) {
			asciiTerms = wanted.every((term) => /^[\x00-\x7f]*$/u.test(term))
				? wanted.map((term) => Buffer.from(term))
				: undefined;
			const last = joined.reader.manifest.segments.at(-1);
			sourceCache =
				(asciiTerms?.length
					? data.searchSourceBytes(asciiTerms, checkInterrupted)
					: wanted.length
						? data.rejectAsciiSources(checkInterrupted)
						: undefined) ?? new Uint8Array(last ? last.start + last.count : 0);
			sourceQuery = key;
		}
	};
	const textMatches = (id: number, wanted: readonly string[]) => {
		checkpoint();
		if (!sourceCache[id]) {
			const bytes = data.sourceBytes(id);
			if (bytes && asciiTerms) {
				const value = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
				if (asciiTerms!.every((term) => value.indexOf(term) >= 0)) {
					sourceCache[id] = 1;
					return true;
				}
				if (!value.some((byte) => byte >= 128 || (byte >= 65 && byte <= 90))) {
					sourceCache[id] = 2;
					return false;
				}
			}
			// Sources are already expanded into a compact arena. Reopening the shared string
			// dictionary here can repeatedly inflate evicted blocks for every new search term.
			const value = (bytes ? decodeWtf8(bytes) : data.strings([id])[0]!).toLocaleLowerCase();
			sourceCache[id] = wanted.every((term) => value.includes(term)) ? 1 : 2;
		}
		return sourceCache[id] === 1;
	};
	const sourceMatches = (fields: typeof raw, row: number, wanted: readonly string[]) => {
		const start = fields.source_start![row]!,
			end = fields.source_end![row]!;
		if (end - start === 1) return textMatches(fields.sources![start]!, wanted);
		const value = data
			.strings(Array.from(fields.sources!.subarray(start, end)))
			.join(" ")
			.toLocaleLowerCase();
		return wanted.every((term) => value.includes(term));
	};
	const filterMatches = (
		kind: "raw" | "slice" | "line",
		row: number,
		request: Request,
		scope: readonly number[],
		prepared = predicatesOf(request),
		lineProblems?: Uint8Array
	) => {
		const fields = kind === "raw" ? raw : slice;
		const flags = kind === "line" ? lineFlags(row) : fields.signals![row]!;
		for (const clause of prepared.clauses) {
			let has: boolean;
			switch (clause.field) {
				case "problem": {
					const mask =
						kind === "line"
							? (lineProblems ?? problemsFor(scope))[row]!
							: (flags & 16 ? 2 : 0) | (flags & 15 ? 32 : 0) || 64;
					has = Boolean(mask & clause.mask);
					break;
				}
				case "finding":
					has = Boolean(flags & clause.mask);
					break;
				case "origin": {
					const mask = kind === "line" ? c("line.origins")[row]! : fields.origins![row]!;
					has = Boolean(mask & clause.mask);
					break;
				}
				case "editing": {
					const mask = kind === "line" ? c("line.editing")[row]! : fields.editing![row]!;
					has = Boolean(mask & clause.mask);
					break;
				}
				case "notes":
					has = Boolean(
						clause.mask &
						((kind === "line" ? c("line.notes")[row] : fields.notes![row]) ? 2 : 1)
					);
					break;
				case "audience":
					has = Boolean(
						clause.mask &
						(1 <<
							audienceIndex(
								kind === "line" ? c("line.audience")[row]! : fields.audience![row]!
							))
					);
					break;
				case "translation":
					has = false;
					if (kind === "line")
						for (const ci of scope) {
							const columns = cultureColumns[ci]!,
								mask = (1 << columns.state![row]!) | (columns.facts![row]! & 8);
							if (mask & clause.mask) {
								has = true;
								break;
							}
						}
					break;
				case "folder":
					has = clause.prefixes.some((prefix) => pathMatches(kind, row, prefix));
					break;
				case "asset": {
					has = hasFile(kind, row, clause.labels);
					break;
				}
				case "namespace":
					has = clause.labels.has(namespaceOf(kind, row));
					break;
			}
			if (clause.is ? !has : has) return false;
		}
		return true;
	};
	const eligible = (
		kind: "raw" | "slice",
		row: number,
		request: Request,
		search: boolean,
		wanted: readonly string[] = []
	) => {
		const fields = kind === "raw" ? raw : slice;
		if (!fields.visible![row]) return false;
		if (search && wanted.length && !sourceMatches(fields, row, wanted)) return false;
		const flags = fields.signals![row]!,
			editing = fields.editing![row]!;
		if (
			(request.capability === "source_editable" && !(editing & 1)) ||
			(request.capability === "read_only" && !(editing & 2))
		)
			return false;
		if (request.withoutNotes && fields.notes![row]) return false;
		if (
			request.lens !== undefined &&
			request.lens !== "all" &&
			!(flags & (1 << querySignals.indexOf(request.lens)))
		)
			return false;
		if (
			request.where?.kinds !== undefined &&
			!matchesTextKinds(origins(fields.origins![row]!), request.where.kinds)
		)
			return false;
		if (
			request.filter === undefined &&
			request.where?.pathPrefix === undefined &&
			request.where?.files === undefined
		)
			return true;
		if (!filterMatches(kind, row, request, [])) return false;
		if (request.where?.pathPrefix === undefined && request.where?.files === undefined)
			return true;
		if (
			request.where?.pathPrefix !== undefined &&
			!pathMatches(kind, row, predicatesOf(request).path!)
		)
			return false;
		if (request.where?.files !== undefined && !hasFile(kind, row, predicatesOf(request).files!))
			return false;
		return true;
	};
	const requireTarget = (request: Request) => {
		if (
			!request.localization &&
			request.filter?.some((clause) => clause.field === "translation")
		)
			throw new GameTextLocalizationError({
				retrySafe: false,
				nextStep: "fix_input",
				code: "invalid_selection",
				message: "Translation filters need a localization target.",
				recovery: "Select a localization target, or remove the translation filter."
			});
		if (request.localization) validateLocalizationSelection(joinHeader, request.localization);
	};
	const matchRows = (request: Request): Uint32Array => {
		requireTarget(request);
		const selection = request.localization;
		const order = selection ? lineOrder : rawOrder;
		const result = new Uint32Array(order.length);
		let count = 0;
		const wanted = terms(request.query),
			picked =
				request.lines === undefined
					? undefined
					: new Set(
							request.lines.flatMap((id) => {
								const row = data.findId("line", id);
								return row === undefined ? [] : [row];
							})
						);
		const scope = cultureScope(selection);
		const sourceVisible = c("line.source_visible"),
			sourceIds = c("line.source"),
			lineNotes = c("line.notes"),
			lineOrigins = c("line.origins"),
			keyChanges = c("line.key_change");
		prepareTextSearch(wanted);
		const { filter: _filter, ...unfiltered } = request;
		const unrestrictedSaved =
			request.capability === "all" &&
			!request.withoutNotes &&
			(!request.lens || request.lens === "all") &&
			!request.where;
		// The usual list/filter/source-search request needs no per-slice eligibility
		// or review/state checks. Compile its numeric filter once for the whole scan.
		if (
			selection &&
			unrestrictedSaved &&
			picked === undefined &&
			selection.review === undefined &&
			!selection.keyChanged &&
			selection.state === undefined &&
			(!selection.searchTranslations ||
				(selection.culture === undefined && selection.cultures === undefined))
		) {
			const prepared = predicatesOf(request),
				lineProblems = request.filter?.some((clause) => clause.field === "problem")
					? problemsFor(scope)
					: undefined;
			for (const row of order) {
				checkpoint();
				if (
					!sourceVisible[row] ||
					(lineStarts[row] !== lineStarts[row + 1] && !lineSavedVisible[row])
				)
					continue;
				if (
					request.filter !== undefined &&
					!filterMatches("line", row, request, scope, prepared, lineProblems)
				)
					continue;
				if (wanted.length && !textMatches(sourceIds[row]!, wanted)) continue;
				result[count++] = row;
			}
			return result.subarray(0, count);
		}
		for (const row of order) {
			checkpoint();
			if (!selection) {
				if (eligible("raw", row, request, true, wanted)) result[count++] = row;
				continue;
			}
			if (!sourceVisible[row]) continue;
			if (picked && !picked.has(row)) continue;
			if (request.filter !== undefined && !filterMatches("line", row, request, scope))
				continue;
			if (lineStarts[row] !== lineStarts[row + 1]) {
				let qualifies = unrestrictedSaved && Boolean(lineSavedVisible[row]);
				for (
					let sr = lineStarts[row]!;
					!unrestrictedSaved && sr < lineStarts[row + 1]!;
					sr++
				)
					if (eligible("slice", sr, unfiltered, false)) {
						qualifies = true;
						break;
					}
				if (!qualifies) continue;
			} else {
				if (
					request.capability === "source_editable" ||
					(request.lens !== undefined && request.lens !== "all") ||
					(request.withoutNotes && lineNotes[row])
				)
					continue;
				if (
					request.where?.kinds !== undefined &&
					!matchesTextKinds(origins(lineOrigins[row]!), request.where.kinds)
				)
					continue;
				if (
					request.where?.pathPrefix !== undefined &&
					!pathMatches("line", row, predicatesOf(request).path!)
				)
					continue;
				if (
					request.where?.files !== undefined &&
					!hasFile("line", row, predicatesOf(request).files!)
				)
					continue;
			}
			if (
				selection.review !== undefined &&
				!scope.some(
					(ci) =>
						reviewMask(row, ci) &
						(1 << LocalizationReviewLens.literals.indexOf(selection.review!))
				)
			)
				continue;
			if (selection.keyChanged && !(keyChanges[row]! > 0 && !(keyChanges[row]! & 1)))
				continue;
			if (
				selection.state !== undefined &&
				!scope.some((ci) =>
					selection.state === "not_synced"
						? Boolean(cultureColumns[ci]!.facts![row]! & 8)
						: localizationStates[cultureColumns[ci]!.state![row]!] === selection.state
				)
			)
				continue;
			if (wanted.length) {
				if (
					!selection.searchTranslations ||
					(selection.culture === undefined && selection.cultures === undefined)
				) {
					if (!textMatches(sourceIds[row]!, wanted)) continue;
					result[count++] = row;
					continue;
				}
				const searchable = data.searchableTranslations(row, scope);
				if (!wanted.every((term) => searchable.includes(term))) continue;
			}
			result[count++] = row;
		}
		return result.subarray(0, count);
	};
	const matchingKey = (request: Request) =>
		JSON.stringify({
			query: request.query,
			capability: request.capability,
			lens: request.lens ?? "all",
			withoutNotes: request.withoutNotes ?? false,
			where: request.where,
			filter: request.filter,
			localization: request.localization,
			lines: request.lines
		});
	const matchedRows = runJoinedQuery(
		Cache.makeWith(
			(key: string) =>
				Effect.sync(() =>
					matchRows(
						Schema.decodeUnknownSync(TextCorpusSearchRequest)({
							...JSON.parse(key),
							pageSize: 1
						})
					)
				),
			{
				capacity: 16,
				timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
			}
		)
	);
	const matching = (request: Request): Uint32Array =>
		runJoinedQuery(Cache.get(matchedRows, matchingKey(request)));
	const rawCounts = (request: Request) => {
		const counts = emptyCounts();
		const {
			capability: _capability,
			lens: _lens,
			withoutNotes: _notes,
			where,
			...rest
		} = request;
		const { kinds: _kinds, ...withoutKinds } = where ?? {};
		const baseRequest: Request = { ...rest, capability: "all", where: withoutKinds };
		const wanted = terms(request.query);
		prepareTextSearch(wanted);
		for (const row of rawOrder) {
			checkpoint();
			if (!eligible("raw", row, baseRequest, true, wanted)) continue;
			const flags = raw.signals![row]!,
				editing = raw.editing![row]!,
				noNotes = !raw.notes![row];
			const hasLens =
				request.lens === undefined ||
				request.lens === "all" ||
				Boolean(flags & (1 << querySignals.indexOf(request.lens)));
			const inKinds =
				request.where?.kinds === undefined ||
				matchesTextKinds(origins(raw.origins![row]!), request.where.kinds);
			const capability =
				request.capability === "all" ||
				Boolean(editing & (request.capability === "source_editable" ? 1 : 2));
			const notes = !request.withoutNotes || noNotes;
			if (hasLens && notes && inKinds && editing & 1) counts.editable++;
			if (hasLens && notes && inKinds && editing & 2) counts.readOnly++;
			if (hasLens && capability && inKinds && noNotes) counts.withoutNotes++;
			if (hasLens && capability && notes)
				for (let bit = 0; bit < TEXT_ORIGIN_KINDS.length; bit++)
					if (raw.origins![row]! & (1 << bit)) counts.origins[TEXT_ORIGIN_KINDS[bit]!]++;
			if (!hasLens || !capability || !notes || !inKinds) continue;
			counts.all++;
			for (let bit = 0; bit < 5; bit++)
				if (flags & (1 << bit)) counts[countedSignals[bit]!]++;
		}
		return counts;
	};
	const metadata = data.metadata(),
		baseline = rawCounts({ query: "", capability: "all" });
	const summary = {
		schemaVersion: 1,
		...metadata,
		counts: baseline,
		...(scannedAt === undefined ? undefined : { scannedAt }),
		searchable: {
			textUnits: baseline.all,
			textOccurrences: rawOrder.reduce(
				(sum, row) =>
					sum + (raw.visible![row] ? raw.member_end![row]! - raw.member_start![row]! : 0),
				0
			)
		},
		review: {
			all: baseline.all,
			shared: baseline.shared,
			duplicateSource: baseline.duplicate_source,
			long: baseline.long,
			unresolved: baseline.unresolved,
			conflicting: baseline.conflicting
		},
		sources: { assetProperty: 0, dataTable: 0, stringTable: 0, mixed: 0 }
	} satisfies TextCorpusQuerySummary;
	for (const row of rawOrder)
		if (raw.visible![row]) {
			const mask = raw.origins![row]!;
			if (mask & 4) summary.sources.assetProperty++;
			if (mask & 2) summary.sources.dataTable++;
			if (mask & 1) summary.sources.stringTable++;
			if ((mask & (mask - 1)) !== 0) summary.sources.mixed++;
		}
	const withoutField = (request: Request, field: TextFilterField): Request => {
		const { filter, ...rest } = request;
		const kept = filter?.filter((clause) => clause.field !== field);
		return kept?.length ? { ...rest, filter: kept } : rest;
	};
	const visitFiles = (
		kind: "raw" | "slice" | "line",
		row: number,
		visit: (id: number) => boolean
	): boolean => {
		if (kind === "line") {
			for (let index = lineFiles.starts[row]!; index < lineFiles.starts[row + 1]!; index++)
				if (visit(lineFiles.files[index]!)) return true;
			return false;
		}
		const fields = kind === "raw" ? raw : slice;
		for (let index = fields.file_start![row]!; index < fields.file_end![row]!; index++)
			if (visit(fields.files![index]!)) return true;
		return false;
	};
	const labelSelections = runJoinedQuery(
		Cache.make({
			capacity: 16,
			lookup: (key: string) =>
				Effect.sync(
					() =>
						// SAFETY: preparedLabels creates this private cache key from a string array.
						// Verified by: scripts/columnar-join-fuzz.test.ts
						// ("persisted differential seed %i": asset and namespace filters)
						new Set(
							(JSON.parse(key) as string[])
								.map((value) => places.findLabel(value))
								.filter((id) => id >= 0)
						)
				)
		})
	);
	const preparedLabels = (values: readonly string[]) =>
		runJoinedQuery(Cache.get(labelSelections, JSON.stringify(values)));
	type PathPredicate = ReturnType<QueryPlaces["prefix"]>;
	type Predicates = {
		clauses: readonly {
			field: TextFilterField;
			is: boolean;
			mask: number;
			labels: ReadonlySet<number>;
			prefixes: readonly PathPredicate[];
		}[];
		path?: PathPredicate;
		files?: ReadonlySet<number>;
	};
	const preparedPredicates = new WeakMap<Request, Predicates>();
	const predicatesOf = (request: Request) => {
		let predicates = preparedPredicates.get(request);
		if (!predicates) {
			const bits = (values: readonly string[], labels: readonly string[]) =>
				values.reduce((mask, value) => mask | (1 << labels.indexOf(value)), 0);
			predicates = {
				clauses: (request.filter ?? []).map((clause) => ({
					field: clause.field,
					is: clause.op === "is",
					mask:
						clause.field === "problem"
							? bits(clause.values, TextProblem.literals)
							: clause.field === "finding"
								? bits(clause.values, querySignals)
								: clause.field === "origin"
									? bits(clause.values, TEXT_ORIGIN_KINDS)
									: clause.field === "editing"
										? bits(clause.values, ["editable", "read_only"])
										: clause.field === "notes"
											? bits(clause.values, ["missing", "present"])
											: clause.field === "audience"
												? bits(clause.values, TextAudience.literals)
												: clause.field === "translation"
													? bits(clause.values, [
															"",
															"missing",
															"to_update",
															"not_synced"
														])
													: 0,
					labels:
						clause.field === "asset"
							? preparedLabels(clause.values.map(textFileKey))
							: clause.field === "namespace"
								? preparedLabels(clause.values)
								: new Set<number>(),
					prefixes:
						clause.field === "folder"
							? clause.values.map((value) => places.prefix(value))
							: []
				})),
				...(request.where?.pathPrefix === undefined
					? undefined
					: { path: places.prefix(request.where.pathPrefix) }),
				...(request.where?.files === undefined
					? undefined
					: { files: preparedLabels([...textFileScope(request.where.files)!.keys]) })
			};
			preparedPredicates.set(request, predicates);
		}
		return predicates;
	};
	const hasFile = (kind: "raw" | "slice" | "line", row: number, keys: ReadonlySet<number>) => {
		const fields = kind === "raw" ? raw : slice;
		const files = kind === "line" ? lineFiles.files : fields.files!;
		const start = kind === "line" ? lineFiles.starts[row]! : fields.file_start![row]!;
		const end = kind === "line" ? lineFiles.starts[row + 1]! : fields.file_end![row]!;
		for (let index = start; index < end; index++)
			if (keys.has(places.asset[places.file[files[index]!]! - 1]!)) return true;
		return false;
	};
	const objects = c("query.place.occurrence_object"),
		packages = c("query.place.occurrence_package");
	const pathMatches = (
		kind: "raw" | "slice" | "line",
		row: number,
		matches: PathPredicate
	): boolean => {
		if (kind === "line") {
			for (let sr = lineStarts[row]!; sr < lineStarts[row + 1]!; sr++)
				if (slice.visible![sr] && pathMatches("slice", sr, matches)) return true;
			const starts = c("line.manifest_start"),
				ends = c("line.manifest_end"),
				rows = c("manifest.rows");
			for (let index = starts[row]!; index < ends[row]!; index++)
				if (matches.manifest![rows[index]!]) return true;
			return false;
		}
		for (const member of data.members(kind, row))
			if (
				matches.path![places.path[objects[member]!]! - 1] ||
				matches.path![places.path[packages[member]!]! - 1]
			)
				return true;
		return false;
	};
	const namespaceOf = (kind: "raw" | "slice" | "line", row: number) => {
		const defined =
			kind === "line"
				? !(lineStarts[row] !== lineStarts[row + 1] && c("line.key")[row] === 0)
				: c(`query.${kind}.identity`)[row]! < 2;
		return defined
			? places.namespaceValues[
					places.namespace[
						c(kind === "line" ? "line.namespace" : `query.${kind}.namespace`)[row]!
					]! - 1
				]!
			: -1;
	};
	const aggregation = (by: TextGroupBy, facet = false, under = "") => {
		const size = places.rank.length + 7;
		const counts = new Uint32Array(size),
			work = new Uint32Array(size),
			worsts = new Uint8Array(size).fill(255);
		const labels = new Uint32Array(size),
			first = new Uint32Array(size),
			last = new Uint32Array(size);
		const used: number[] = [];
		const parent = normalizeTextPath(under).replace(/\/+$/u, ""),
			depth = parent === "" ? 1 : parent.split("/").length + 1;
		const prefix = parent === "" ? undefined : Buffer.from(encodeWtf8(parent + "/"));
		const fileCount = places.fileLabels.length,
			keys = by === "asset" ? places.asset : new Uint32Array(fileCount),
			fileLabels = by === "asset" ? places.fileLabels : new Uint32Array(fileCount);
		if (by === "folder")
			for (let row = 0; row < fileCount; row++) {
				const id = c("query.place.file_ids")[row]!;
				const value = places.coordinate(
					id,
					by === "folder",
					facet && by === "folder" ? depth : undefined,
					facet && by === "folder" ? prefix : undefined
				);
				keys[row] = value.key;
				fileLabels[row] = value.label;
			}
		const visit = (key: number, label: number, stamp: number, mask: number, worst: number) => {
			if (!counts[key]) {
				used.push(key);
				first[key] = stamp;
			}
			if (first[key] === stamp) labels[key] = label;
			if (last[key] === stamp) return;
			last[key] = stamp;
			counts[key] = counts[key]! + 1;
			if (mask & 31) work[key] = work[key]! + 1;
			if (worst < worsts[key]!) worsts[key] = worst;
		};
		const finish = (): TextGroupList => {
			const labelRank = (key: number) =>
				by === "problem"
					? 0
					: by === "origin"
						? [0, 5, 3, 1, 2, 4][key]!
						: by === "audience"
							? audienceRank[key]!
							: places.rank[labels[key]!]!;
			used.sort(
				(a, b) =>
					worsts[a]! - worsts[b]! ||
					work[b]! - work[a]! ||
					counts[b]! - counts[a]! ||
					labelRank(a) - labelRank(b)
			);
			const display = (id: number) =>
				by === "problem"
					? {
							key: TextProblem.literals[id]!,
							label: TEXT_PROBLEM_LABELS[TextProblem.literals[id]!]
						}
					: by === "origin"
						? id === 0
							? { key: "", label: "" }
							: {
									key: TEXT_ORIGIN_KINDS[id - 1]!,
									label: TEXT_ORIGIN_LABELS[TEXT_ORIGIN_KINDS[id - 1]!]
								}
						: by === "audience"
							? {
									key: TextAudience.literals[id]!,
									label: TEXT_AUDIENCE_LABELS[TextAudience.literals[id]!]
								}
							: { key: places.label(id), label: places.label(labels[id]!) };
			return {
				entries: used.slice(0, MAX_TEXT_GROUPS).map((id) => ({
					...display(id),
					count: counts[id]!,
					needWork: work[id]!,
					worst: TextProblem.literals[worsts[id]!]!
				})),
				more: Math.max(0, used.length - MAX_TEXT_GROUPS)
			};
		};
		return { visit, keys, fileLabels, finish };
	};
	const aggregate = (
		rows: Uint32Array,
		request: Request,
		by: TextGroupBy,
		facet = false,
		under = ""
	): TextGroupList => {
		const { visit, keys, fileLabels, finish } = aggregation(by, facet, under);
		const masks = request.localization
			? problemsFor(cultureScope(request.localization))
			: undefined;
		const originColumns = request.localization ? c("line.origins") : raw.origins!;
		const audienceColumn = request.localization ? c("line.audience") : raw.audience!;
		let stamp = 0;
		const files = request.localization ? lineFiles.files : raw.files!;
		const fileStarts = request.localization ? lineFiles.starts : raw.file_start!;
		const fileEnds = request.localization ? lineFiles.starts.subarray(1) : raw.file_end!;
		for (const row of rows) {
			checkpoint();
			stamp++;
			const flags = raw.signals![row]!;
			const mask = request.localization
				? masks![row]!
				: (flags & 16 ? 2 : 0) | (flags & 15 ? 32 : 0) || 64;
			const worst = 31 - Math.clz32(mask & -mask);
			if (by === "problem") visit(worst, worst, stamp, mask, worst);
			else if (by === "origin") {
				const origins = originColumns[row]!;
				for (let bit = 0; bit < TEXT_ORIGIN_KINDS.length; bit++)
					if (origins & (1 << bit)) {
						visit(bit + 1, bit + 1, stamp, mask, worst);
						if (!facet) break;
					}
				if (!origins && !facet) visit(0, 0, stamp, mask, worst);
			} else if (by === "namespace") {
				const id = Math.max(0, namespaceOf(request.localization ? "line" : "raw", row));
				visit(id, id, stamp, mask, worst);
			} else if (by === "audience") {
				const id = audienceIndex(audienceColumn[row]!);
				visit(id, id, stamp, mask, worst);
			} else {
				let found = false;
				for (let position = fileStarts[row]!; position < fileEnds[row]!; position++) {
					const index = places.file[files[position]!]! - 1,
						label = fileLabels[index]!;
					if (facet && !label) continue;
					visit(keys[index]!, label, stamp, mask, worst);
					found = true;
					if (!facet) break;
				}
				if (!facet && !found) visit(0, 0, stamp, mask, worst);
			}
		}
		return finish();
	};
	const combinedFacets = (rows: Uint32Array, request: Request, under: string) => {
		const folder = aggregation("folder", true, under),
			asset = aggregation("asset", true),
			origin = aggregation("origin", true);
		const masks = request.localization
			? problemsFor(cultureScope(request.localization))
			: undefined;
		const originColumns = request.localization ? c("line.origins") : raw.origins!;
		const files = request.localization ? lineFiles.files : raw.files!;
		const starts = request.localization ? lineFiles.starts : raw.file_start!;
		const ends = request.localization ? lineFiles.starts.subarray(1) : raw.file_end!;
		let stamp = 0;
		for (const row of rows) {
			checkpoint();
			stamp++;
			const flags = raw.signals![row]!,
				mask = request.localization
					? masks![row]!
					: (flags & 16 ? 2 : 0) | (flags & 15 ? 32 : 0) || 64;
			const worst = 31 - Math.clz32(mask & -mask);
			for (let position = starts[row]!; position < ends[row]!; position++) {
				const index = places.file[files[position]!]! - 1;
				if (folder.fileLabels[index])
					folder.visit(
						folder.keys[index]!,
						folder.fileLabels[index]!,
						stamp,
						mask,
						worst
					);
				if (asset.fileLabels[index])
					asset.visit(asset.keys[index]!, asset.fileLabels[index]!, stamp, mask, worst);
			}
			const origins = originColumns[row]!;
			for (let bit = 0; bit < TEXT_ORIGIN_KINDS.length; bit++)
				if (origins & (1 << bit)) origin.visit(bit + 1, bit + 1, stamp, mask, worst);
		}
		return {
			folders: { under, ...folder.finish() },
			assets: asset.finish(),
			origins: origin.finish()
		};
	};
	const countedCultureFacets = new WeakMap<LocalizationQueryPage, readonly TextCultureFacet[]>();
	const search = (
		request: TextCorpusSearchRequest,
		cached?: ReturnType<TextCorpusQuery["search"]>
	) => {
		const matched = matching(request),
			selection = request.localization;
		const base = (field: TextFilterField) =>
			request.filter?.some((clause) => clause.field === field)
				? matching(withoutField(request, field))
				: matched;
		const group = request.group;
		const opened =
			group === "problem"
				? TextProblem.literals.findIndex((value) => value === request.openGroup)
				: group === "origin"
					? request.openGroup === ""
						? 0
						: TEXT_ORIGIN_KINDS.findIndex((value) => value === request.openGroup) + 1
					: group === "audience"
						? TextAudience.literals.findIndex((value) => value === request.openGroup)
						: places.findLabel(request.openGroup ?? "");
		const groupKey = (row: number) => {
			const kind = selection ? "line" : "raw";
			if (group === "namespace") return Math.max(0, namespaceOf(kind, row));
			if (group === "problem") {
				const flags = raw.signals![row]!,
					mask = selection
						? problemMask(row, cultureScope(selection))
						: (flags & 16 ? 2 : 0) | (flags & 15 ? 32 : 0) || 64;
				return 31 - Math.clz32(mask & -mask);
			}
			if (group === "origin") {
				const mask = selection ? c("line.origins")[row]! : raw.origins![row]!;
				return mask ? 32 - Math.clz32(mask & -mask) : 0;
			}
			if (group === "audience")
				return audienceIndex(selection ? c("line.audience")[row]! : raw.audience![row]!);
			let key = 0;
			visitFiles(kind, row, (id) => {
				key = places.coordinate(id, group === "folder").key;
				return true;
			});
			return key;
		};
		const listed =
			group === undefined || request.openGroup === undefined
				? matched
				: matched.filter((row) => groupKey(row) === opened);
		const cursor = selection ? request.localizationCursor : request.cursor;
		const id = (row: number) => (selection ? data.lineId(row) : data.id(row));
		const after = cursor
			? listed.indexOf(data.findId(selection ? "line" : "raw", cursor) ?? -1) + 1
			: 0;
		const page = listed.subarray(after, after + request.pageSize);
		const final = page.length ? id(page[page.length - 1]!) : undefined;
		const counts = cached
			? { ...cached.counts, origins: { ...cached.counts.origins } }
			: selection
				? emptyCounts()
				: rawCounts(request);
		if (selection && !cached) {
			counts.all = matched.length;
			const editingColumn = c("line.editing"),
				notesColumn = c("line.notes");
			for (const row of matched) {
				checkpoint();
				const flags = lineFlags(row),
					editing = editingColumn[row]!;
				if (editing & 1) counts.editable++;
				if (editing & 2) counts.readOnly++;
				if (!notesColumn[row]) counts.withoutNotes++;
				for (let bit = 0; bit < 5; bit++)
					if (flags & (1 << bit)) counts[countedSignals[bit]!]++;
			}
			const { kinds: _kinds, ...where } = request.where ?? {};
			const originBase =
				request.where?.kinds === undefined ? matched : matching({ ...request, where });
			const originColumn = c("line.origins");
			for (const row of originBase)
				for (let bit = 0; bit < TEXT_ORIGIN_KINDS.length; bit++)
					if (originColumn[row]! & (1 << bit)) counts.origins[TEXT_ORIGIN_KINDS[bit]!]++;
		}
		let localization: LocalizationQueryPage | undefined;
		if (selection && cached?.localization) {
			localization = {
				...cached.localization,
				...(selection.keyChanged && cached.localization.keyChanged === undefined
					? { keyChanged: 0 }
					: undefined),
				lines: Array.from(page, (row) => data.preview(row)),
				...(final !== undefined && after + page.length < listed.length
					? { nextCursor: LocalizationLineId.make(final) }
					: undefined)
			};
			const facets = countedCultureFacets.get(cached.localization);
			if (facets) countedCultureFacets.set(localization, facets);
		} else if (selection) {
			const countedCultures = selection.cultures ?? target.cultures;
			const scope = cultureScope(selection),
				indices = countedCultures.map((culture) => target.cultures.indexOf(culture));
			const stateSize = localizationStates.length,
				reasonSize = LocalizationUnknownReason.literals.length;
			const tallyLines = new Uint32Array(countedCultures.length * stateSize),
				tallyNotSynced = new Uint32Array(countedCultures.length),
				tallyWords = new Float64Array(tallyLines.length),
				tallyReasons = new Uint32Array(countedCultures.length * reasonSize);
			const stateTotals = new Uint32Array(stateSize),
				reviewTotals = new Uint32Array(LocalizationReviewLens.literals.length);
			const words = c("line.source_words"),
				keys = c("line.key_change");
			let notSynced = 0,
				keyChanged = 0,
				reviewed = false;
			const tracksReview = joined.meta.input.review?.target === target.name;
			for (const row of matched) {
				checkpoint();
				for (let ti = 0; ti < indices.length; ti++) {
					const columns = cultureColumns[indices[ti]!]!,
						position = ti * stateSize + columns.state![row]!;
					if (columns.state![row] === 3 || columns.facts![row]! & 8)
						tallyNotSynced[ti] = tallyNotSynced[ti]! + 1;
					tallyLines[position] = tallyLines[position]! + 1;
					tallyWords[position] = tallyWords[position]! + words[row]!;
					let reasons = columns.reasons![row]!;
					while (reasons) {
						const bit = 31 - Math.clz32(reasons & -reasons),
							place = ti * reasonSize + bit;
						tallyReasons[place] = tallyReasons[place]! + 1;
						reasons &= reasons - 1;
					}
				}
				let states = 0,
					reviews = 0;
				for (const ci of scope) {
					const columns = cultureColumns[ci]!,
						state = columns.state![row]!;
					if (state !== 3) states |= 1 << state;
					if (columns.facts![row]! & 8) {
						states |= 8;
						notSynced++;
					}
					if (tracksReview) reviews |= reviewMask(row, ci);
				}
				for (let bit = 0; bit < stateSize; bit++)
					if (states & (1 << bit)) stateTotals[bit] = stateTotals[bit]! + 1;
				if (keys[row]! > 0 && !(keys[row]! & 1)) keyChanged++;
				if (tracksReview) {
					if (!reviewed)
						reviewed = cultureColumns.some((columns) => Boolean(columns.review![row]));
					for (let bit = 0; bit < reviewTotals.length; bit++)
						if (reviews & (1 << bit)) reviewTotals[bit] = reviewTotals[bit]! + 1;
				}
			}
			const tallies = countedCultures.map((culture, ti) => ({
				culture,
				states: Object.fromEntries(
					localizationStates.map((state, bit) => [
						state,
						{
							lines: tallyLines[ti * stateSize + bit]!,
							sourceWords: tallyWords[ti * stateSize + bit]!
						}
					])
				),
				unknownReasons: Object.fromEntries(
					LocalizationUnknownReason.literals.map((reason, bit) => [
						reason,
						tallyReasons[ti * reasonSize + bit]!
					])
				),
				reducedSourceChecking: joined.meta.reducedSourceChecking[indices[ti]!]
					? matched.length
					: 0
			}));
			const stateCounts = Object.fromEntries(
					localizationStates.map((state, bit) => [state, stateTotals[bit]!])
				),
				reviewCounts = Object.fromEntries(
					LocalizationReviewLens.literals.map((lens, bit) => [lens, reviewTotals[bit]!])
				);
			localization = Schema.decodeUnknownSync(LocalizationQueryPage)({
				target: target.name,
				counts: tallies,
				stateCounts,
				notSynced,
				lines: Array.from(page, (row) => data.preview(row)),
				...(reviewed ? { reviewCounts } : undefined),
				...(keyChanged || selection.keyChanged ? { keyChanged } : undefined),
				...(final !== undefined && after + page.length < listed.length
					? { nextCursor: LocalizationLineId.make(final) }
					: undefined)
			});
			countedCultureFacets.set(
				localization,
				countedCultures
					.map((culture, index) => ({
						culture,
						lines: matched.length,
						shipped: tallyLines[index * stateSize]!,
						missing: tallyLines[index * stateSize + 1]!,
						toUpdate: tallyLines[index * stateSize + 2]!,
						notSynced: tallyNotSynced[index]!
					}))
					.sort(
						(a, b) =>
							b.missing + b.toUpdate - a.missing - a.toUpdate ||
							(a.culture < b.culture ? -1 : a.culture > b.culture ? 1 : 0)
					)
			);
		}
		const facets = cached?.facets === undefined ? request.facets : undefined;
		const combined =
			facets?.folder !== undefined &&
			facets.assets &&
			facets.origins &&
			!request.filter?.some(
				(clause) =>
					clause.field === "folder" ||
					clause.field === "asset" ||
					clause.field === "origin"
			)
				? combinedFacets(matched, request, facets.folder)
				: undefined;
		const cultureBase = () => {
			if (!selection || selection.cultures === undefined) return matched;
			const { cultures: _cultures, ...unscoped } = selection;
			return matching({ ...request, localization: unscoped });
		};
		const fileScope = cached ? undefined : textFileScope(request.where?.files);
		const fileScopeSummary = () => {
			const wanted = preparedLabels([...fileScope!.keys]),
				seen = new Set<number>();
			for (const row of matched)
				visitFiles(selection ? "line" : "raw", row, (id) => {
					const key = places.asset[places.file[id]! - 1]!;
					if (wanted.has(key)) seen.add(key);
					return false;
				});
			const scanned = new Set(c("query.place.scanned_keys"));
			return {
				files: fileScope!.keys.size + fileScope!.outside,
				textFiles: seen.size,
				outside: fileScope!.outside,
				notScanned: [...fileScope!.keys].filter(
					(key) => !/\.[^/]+$/u.test(key) && !scanned.has(places.findLabel(key))
				).length
			};
		};
		// SAFETY: Every TextProblem literal is initialized exactly once to a numeric count.
		// Verified by: scripts/columnar-join-fuzz.test.ts ("persisted differential seed %i")
		const problems = Object.fromEntries(
			TextProblem.literals.map((problem) => [problem, 0])
		) as Record<TextProblem, number>;
		const problemScope = cultureScope(selection);
		if (cached) Object.assign(problems, cached.problems);
		else {
			const masks = selection ? problemsFor(problemScope) : undefined;
			const totals = new Uint32Array(1 << TextProblem.literals.length);
			for (const row of base("problem")) {
				const flags = selection ? 0 : raw.signals![row]!;
				const mask = selection
					? masks![row]!
					: (flags & 16 ? 2 : 0) | (flags & 15 ? 32 : 0) || 64;
				totals[mask] = totals[mask]! + 1;
			}
			for (let mask = 1; mask < totals.length; mask++)
				if (totals[mask])
					for (let bit = 0; bit < TextProblem.literals.length; bit++)
						if (mask & (1 << bit))
							problems[TextProblem.literals[bit]!] += totals[mask]!;
		}
		return {
			counts,
			...(cached?.facets === undefined ? undefined : { facets: cached.facets }),
			...(cached?.fileScope === undefined ? undefined : { fileScope: cached.fileScope }),
			total: matched.length,
			problems,
			...(group === undefined
				? undefined
				: {
						groups: {
							by: group,
							...(cached?.groups ?? aggregate(matched, request, group))
						}
					}),
			...(facets === undefined
				? undefined
				: {
						facets: {
							...combined,
							...(combined || facets.folder === undefined
								? undefined
								: {
										folders: {
											under: facets.folder,
											...aggregate(
												base("folder"),
												request,
												"folder",
												true,
												facets.folder
											)
										}
									}),
							...(facets.assets && !combined
								? { assets: aggregate(base("asset"), request, "asset", true) }
								: undefined),
							...(facets.origins && !combined
								? { origins: aggregate(base("origin"), request, "origin", true) }
								: undefined),
							...(facets.audiences
								? {
										audiences: aggregate(
											base("audience"),
											request,
											"audience",
											true
										)
									}
								: undefined),
							...(facets.cultures && selection
								? {
										cultures: (() => {
											const counted =
												localization && selection.cultures === undefined
													? countedCultureFacets.get(localization)
													: undefined;
											if (counted) return counted;
											const rows = cultureBase();
											return target.cultures
												.map((culture, ci) => {
													const columns = cultureColumns[ci]!;
													let shipped = 0,
														missing = 0,
														toUpdate = 0,
														notSynced = 0;
													for (const row of rows) {
														const state = columns.state![row]!;
														if (state === 0) shipped++;
														if (state === 1) missing++;
														if (state === 2) toUpdate++;
														if (state === 3 || columns.facts![row]! & 8)
															notSynced++;
													}
													return {
														culture,
														lines: rows.length,
														shipped,
														missing,
														toUpdate,
														notSynced
													};
												})
												.sort(
													(left, right) =>
														right.missing +
															right.toUpdate -
															left.missing -
															left.toUpdate ||
														(left.culture < right.culture
															? -1
															: left.culture > right.culture
																? 1
																: 0)
												);
										})()
									}
								: undefined)
						}
					}),
			...(fileScope === undefined
				? undefined
				: {
						fileScope: fileScopeSummary()
					}),
			...(localization === undefined ? undefined : { localization }),
			units: selection
				? Array.from(page).flatMap((row) => {
						for (let sr = lineStarts[row]!; sr < lineStarts[row + 1]!; sr++)
							if (slice.visible![sr])
								return [
									{
										...data.presentation("slice", sr),
										localization:
											localization!.lines[Array.from(page).indexOf(row)]!
												.cultures
									}
								];
						return [];
					})
				: Array.from(page, (row) => data.presentation("raw", row)),
			...(!selection && final !== undefined && after + page.length < listed.length
				? { nextCursor: TextUnitId.make(final) }
				: undefined)
		};
	};
	type CommonCounts = { rows: Uint32Array; page: ReturnType<TextCorpusQuery["search"]> };
	const commonCounts = runJoinedQuery(
		Cache.make({
			capacity: 16,
			lookup: (_scope: string) => Effect.succeed<CommonCounts | undefined>(undefined)
		})
	);
	const prepareCounts = (request: TextCorpusSearchRequest) => {
		const rows = matching(request),
			scope = JSON.stringify([
				request.localization?.target,
				request.localization?.culture,
				request.localization?.cultures
			]);
		const reusable =
			request.localization &&
			request.where?.files === undefined &&
			request.where?.kinds === undefined;
		const common = runJoinedQuery(Cache.get(commonCounts, scope));
		if (
			reusable &&
			common &&
			rows.length === common.rows.length &&
			Buffer.compare(
				Buffer.from(rows.buffer, rows.byteOffset, rows.byteLength),
				Buffer.from(common.rows.buffer, common.rows.byteOffset, common.rows.byteLength)
			) === 0
		)
			return search(request, common.page);
		const page = search(request);
		if (
			reusable &&
			!request.group &&
			!request.facets &&
			!request.filter &&
			!request.where &&
			!request.lines &&
			(!request.lens || request.lens === "all") &&
			!request.withoutNotes &&
			request.query === "" &&
			request.capability === "all" &&
			!request.localization?.state &&
			!request.localization?.review &&
			!request.localization?.keyChanged
		)
			runJoinedQuery(Cache.set(commonCounts, scope, { rows, page }));
		return page;
	};
	const pageCounts = runJoinedQuery(
		Cache.makeWith(
			(key: string) =>
				Effect.sync(() =>
					prepareCounts({
						...Schema.decodeUnknownSync(TextCorpusSearchRequest)({
							...JSON.parse(key),
							pageSize: 1
						}),
						pageSize: 0
					})
				),
			{
				capacity: 16,
				timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
			}
		)
	);
	const cachedSearch: TextCorpusQuery["search"] = (request) => {
		const {
			cursor: _cursor,
			localizationCursor: _localizationCursor,
			pageSize: _pageSize,
			...countsRequest
		} = request;
		checkInterrupted?.();
		return search(
			request,
			runJoinedQuery(Cache.get(pageCounts, JSON.stringify(countsRequest)))
		);
	};
	data.prepareSources();
	// Warm bounded presentation pages instead of inflating every physical column. Other
	// cultures, rule fields and package details stay lazy under this generation's pinned handles.
	if (target.cultures.length) {
		cachedSearch({
			query: "",
			capability: "all",
			pageSize: 50,
			localization: { target: target.name }
		});
		cachedSearch({
			query: "",
			capability: "all",
			pageSize: 50,
			localization: { target: target.name, culture: target.cultures[0]! }
		});
	} else {
		cachedSearch({ query: "", capability: "all", pageSize: 50 });
	}
	const localizationRows = (request: Request) => {
		if (!request.localization)
			throw new GameTextLocalizationError({
				retrySafe: false,
				nextStep: "fix_input",
				code: "invalid_selection",
				message: "Localization evidence has not been supplied to this query.",
				recovery:
					"Load and join the selected target before querying its localization state."
			});
		return matching(request);
	};
	const findRaw = (id: string) => data.findId("raw", id);
	const findLine = (id: string) => data.findId("line", id);
	const rawLineRows = () => {
		let rows = data.projection.columns.get("focus:raw-line");
		if (!rows) {
			rows = new Uint32Array(rawOrder.length).fill(0xffffffff);
			const raws = c("query.slice.raw");
			for (const candidate of lineOrder) {
				checkpoint();
				for (let sr = lineStarts[candidate]!; sr < lineStarts[candidate + 1]!; sr++)
					rows[raws[sr]!] = candidate;
			}
			data.projection.columns.set("focus:raw-line", rows);
		}
		return rows;
	};
	return {
		summary: () => summary,
		search: cachedSearch,
		localizationFocus: (id) => {
			const row = findLine(id);
			return row === undefined ? undefined : data.line(row);
		},
		localizationRows,
		localizationLines: (request) => data.lines(localizationRows(request)),
		export: (request) => {
			const rows = matching(request),
				chosen = new Set<number>();
			if (request.localization)
				for (const row of rows)
					for (let sr = lineStarts[row]!; sr < lineStarts[row + 1]!; sr++)
						chosen.add(c("query.slice.raw")[sr]!);
			else for (const row of rows) chosen.add(row);
			return {
				...data.exportMetadata(),
				schemaVersion: 1,
				status: metadata.status,
				coverage: metadata.coverage,
				units: Array.from(rawOrder)
					.filter((row) => chosen.has(row))
					.map((row) => data.unit("raw", row))
			};
		},
		focus: (request) => {
			if (request.localization && request.localization.target !== target.name)
				return undefined;
			let kind: "raw" | "slice" = "raw",
				row = findRaw(request.id),
				lineRow: number | undefined;
			if (request.localization) {
				lineRow = findLine(request.localization.id);
				if (lineRow === undefined) return undefined;
				kind = "slice";
				row = undefined;
				for (let sr = lineStarts[lineRow]!; sr < lineStarts[lineRow + 1]!; sr++)
					if (data.id(c("query.slice.raw")[sr]!) === request.id && slice.visible![sr]) {
						row = sr;
						break;
					}
			} else if (row !== undefined) {
				if (!raw.visible![row]) return undefined;
				const candidate = rawLineRows()[row]!;
				if (candidate !== 0xffffffff) lineRow = candidate;
			}
			if (row === undefined) return undefined;
			const members = data.members(kind, row);
			const after = request.occurrenceCursor
				? members.findIndex(
						(member) => data.occurrence(member).id === request.occurrenceCursor
					) + 1
				: 0;
			const occurrences = Array.from(
				members.subarray(after, after + request.pageSize),
				(member) => data.occurrence(member)
			);
			return {
				diagnostics: data.diagnostics(members).slice(0, request.pageSize),
				occurrences,
				totalOccurrences: members.length,
				unit: data.presentation(kind, row),
				...(lineRow === undefined ? undefined : { localization: data.line(lineRow) }),
				...(occurrences.length && after + occurrences.length < members.length
					? { nextOccurrenceCursor: occurrences[occurrences.length - 1]!.id }
					: undefined)
			};
		}
	};
}
