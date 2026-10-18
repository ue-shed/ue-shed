import { Effect } from "effect";
import { textOccurrenceId } from "./corpus.js";
import { IndexedPolicyData } from "./indexed-policy-data.js";
import type { JoinedTargetReader } from "./joined-target-reader.js";
import {
	matchesTextRole,
	prepareTextQualityRules,
	textQualityUnitFindings,
	type TextQualityOccurrence
} from "./quality.js";
import {
	textQualityFindingHash,
	textQualityFindingIdHash,
	textQualityFindingIdOf,
	textQualityQueryOf,
	type TextQualityQuery
} from "./quality-query.js";
import type { GameTextRuleDocument } from "./game-text-rules.js";
import type { TextQualityAffectedOccurrence, TextQualityFinding } from "./quality-schema.js";
import type { TextCorpus, TextLocation } from "./schema.js";
import { snapshotCheck } from "./snapshot-format.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";

/**
 * Text units checked per scan page; the scan yields after each. A page also ends once its units
 * hold this many occurrences, so a page of widely shared text stays short.
 */
const SCAN_PAGE_UNITS = 256;
const SCAN_PAGE_OCCURRENCES = 1024;

/** Growable u32 column; the scan appends, then reads by position. */
function u32Builder() {
	let values = new Uint32Array(1024),
		length = 0;
	return {
		get length() {
			return length;
		},
		push(value: number) {
			if (length === values.length) {
				const next = new Uint32Array(values.length * 2);
				next.set(values);
				values = next;
			}
			values[length++] = value;
		},
		finish: () => values.slice(0, length)
	};
}

/** An occurrence as the rules read it, with where its other evidence is stored. */
interface StoredOccurrence extends TextQualityOccurrence {
	readonly shard: number;
	readonly row: number;
}

/** Reads occurrence locations and sources from the package columns, a batch of rows at once. */
function occurrenceReader(data: IndexedPolicyData) {
	// A shard's columns, looked up once: every occurrence reads several.
	const read = (shard: number) => ({
		location: data.packageColumn(shard, "occurrence.location"),
		object: data.packageColumn(shard, "occurrence.object"),
		property: data.packageColumn(shard, "occurrence.property"),
		class: data.packageColumn(shard, "occurrence.class"),
		row: data.packageColumn(shard, "occurrence.row"),
		source: data.packageColumn(shard, "occurrence.source")
	});
	const shardColumns: ReturnType<typeof read>[] = [];
	const column = (shard: number, field: keyof ReturnType<typeof read>) =>
		(shardColumns[shard] ??= read(shard))[field];
	/** Locations of these global occurrence rows, with their shard rows. */
	const locations = (globals: ArrayLike<number>) => {
		const shards = new Uint32Array(globals.length),
			rows = new Uint32Array(globals.length),
			kinds = new Uint8Array(globals.length);
		const ids: number[] = [];
		for (let index = 0; index < globals.length; index++) {
			const { shard, row } = data.occurrenceShard(globals[index]!);
			shards[index] = shard;
			rows[index] = row;
			const kind = column(shard, "location")[row]!;
			kinds[index] = kind;
			ids.push(column(shard, "object")[row]!);
			// The same fields `IndexedPolicyData.occurrence` reads for each location kind.
			if (kind === 0) ids.push(column(shard, "class")[row]!, column(shard, "property")[row]!);
			else if (kind === 1)
				ids.push(column(shard, "row")[row]!, column(shard, "property")[row]!);
			else ids.push(column(shard, "row")[row]!);
		}
		const values = data.strings(ids);
		let next = 0;
		const located: TextLocation[] = [];
		for (let index = 0; index < globals.length; index++) {
			const kind = kinds[index]!,
				objectPath = values[next++]!;
			if (kind === 0)
				located.push({
					kind: "asset_property",
					objectPath,
					classPath: values[next++]!,
					propertyPath: values[next++]!
				});
			else if (kind === 1)
				located.push({
					kind: "data_table_cell",
					objectPath,
					row: values[next++]!,
					propertyPath: values[next++]!
				});
			else
				located.push({ kind: "string_table_entry", objectPath, entryKey: values[next++]! });
		}
		return { locations: located, shards, rows };
	};
	/** Sources of these shard rows. */
	const sources = (shards: ArrayLike<number>, rows: ArrayLike<number>) =>
		data.strings(Array.from(rows, (row, index) => column(shards[index]!, "source")[row]!));
	/** Evidence of occurrences that produce a finding; package files are read only for them. */
	const evidence = (occurrences: readonly StoredOccurrence[]) =>
		occurrences.map((occurrence): TextQualityAffectedOccurrence => {
			const packageFile = data.occurrencePackageFile(occurrence.shard, occurrence.row);
			return {
				id: textOccurrenceId(packageFile, occurrence.location),
				location: occurrence.location,
				packageFile
			};
		});
	return { locations, sources, evidence };
}

/**
 * Source quality rules over a joined index, with the result `evaluateGameTextSourceQuality`
 * gives over the index's corpus and the query `textQualityQuery` builds over that report.
 *
 * Text units are read in pages of index columns, in report order, and dropped: roles match each
 * occurrence's stored location, and only occurrences a rule's role selects have their source
 * read. A finding keeps its rule, unit and place among the unit's findings and its ID's hash.
 * Search pages, focus and export rebuild only the findings they return from their units, and
 * check each against its recorded hash. The scan yields between pages, so a host keeps serving
 * other requests and can interrupt it.
 */
export const indexedSourceQuality = Effect.fn("GameText.sourceQuality")(function* (
	joined: JoinedTargetReader,
	corpus: Pick<TextCorpus, "status" | "coverage">,
	document: GameTextRuleDocument
) {
	// Progress goes to the reporter: a `source_quality` event before the scan with no units
	// checked, then after each page of units, the last with every unit and the finding count.
	const reportProgress = yield* GameTextIndexProgressReporter;
	const data = new IndexedPolicyData(joined);
	const order = data.column("query.raw.order"),
		visible = data.column("query.raw.visible"),
		rawIds = data.column("query.raw.raw"),
		memberStart = data.column("query.raw.member_start"),
		memberEnd = data.column("query.raw.member_end"),
		members = data.column("query.raw.members");
	// Units in report order, `query.raw.order` being ID order; rules check units with source.
	let totalTextUnits = 0;
	for (const row of order) if (visible[row]) totalTextUnits++;
	reportProgress({ phase: "source_quality", completed: 0, total: totalTextUnits, findings: 0 });

	const roles = [...document.roles].sort((left, right) => left.id.localeCompare(right.id));
	const rules = [...document.rules].sort((left, right) => left.id.localeCompare(right.id));
	const prepared = prepareTextQualityRules(document);
	snapshotCheck(prepared.length < 0x10000, "quality.source", "Too many rules");
	/** For each rule, its role's position in `roles`. */
	const ruleRole = prepared.map(({ role }) => roles.indexOf(role));
	const ruleRoles = new Set(ruleRole);
	const reader = occurrenceReader(data);

	const matchedOccurrences = new Float64Array(roles.length),
		matchedTextUnits = new Float64Array(roles.length);
	const storedRule = u32Builder(),
		storedRank = u32Builder(),
		storedOrdinal = u32Builder(),
		storedHigh = u32Builder(),
		storedLow = u32Builder();
	const unitId = (rank: number) => data.id(rawIds[order[rank]!]!);

	/** A unit's occurrences as the rules read them, every source decoded. */
	const unitOccurrences = (rank: number): StoredOccurrence[] => {
		const row = order[rank]!;
		const globals = members.subarray(memberStart[row], memberEnd[row]);
		const { locations, shards, rows } = reader.locations(globals);
		const sources = reader.sources(shards, rows);
		return locations.map((location, index) => ({
			location,
			source: sources[index]!,
			shard: shards[index]!,
			row: rows[index]!
		}));
	};

	let checkedTextUnits = 0;
	/** Checks one page of units, given by rank, and records their findings. */
	const checkPage = (ranks: readonly number[]) => {
		const globals: number[] = [],
			firsts: number[] = [];
		for (const rank of ranks) {
			const row = order[rank]!;
			firsts.push(globals.length);
			for (let member = memberStart[row]!; member < memberEnd[row]!; member++)
				globals.push(members[member]!);
		}
		firsts.push(globals.length);
		const { locations, shards, rows } = reader.locations(globals);
		/** Each role's matches, one byte per occurrence of the page. */
		const matches = roles.map((role) =>
			Uint8Array.from(locations, (location) => Number(matchesTextRole({ location }, role)))
		);
		// Sources only of occurrences a rule reads.
		const wanted: number[] = [];
		for (let index = 0; index < globals.length; index++)
			for (const role of ruleRoles)
				if (matches[role]![index]) {
					wanted.push(index);
					break;
				}
		const wantedSources = reader.sources(
			wanted.map((index) => shards[index]!),
			wanted.map((index) => rows[index]!)
		);
		const sources: (string | undefined)[] = [];
		wanted.forEach((index, position) => (sources[index] = wantedSources[position]));

		for (let unit = 0; unit < ranks.length; unit++) {
			const first = firsts[unit]!,
				end = firsts[unit + 1]!;
			for (let role = 0; role < roles.length; role++) {
				let matched = 0;
				for (let index = first; index < end; index++) matched += matches[role]![index]!;
				matchedOccurrences[role]! += matched;
				if (matched) matchedTextUnits[role]!++;
			}
			let id: ReturnType<typeof unitId> | undefined;
			for (let rule = 0; rule < prepared.length; rule++) {
				const role = matches[ruleRole[rule]!]!;
				const occurrences: StoredOccurrence[] = [];
				for (let index = first; index < end; index++)
					if (role[index])
						occurrences.push({
							location: locations[index]!,
							source: sources[index]!,
							shard: shards[index]!,
							row: rows[index]!
						});
				if (!occurrences.length) continue;
				const findings = textQualityUnitFindings(
					prepared[rule]!,
					(id ??= unitId(ranks[unit]!)),
					occurrences,
					reader.evidence
				);
				findings.forEach((finding, ordinal) => {
					const [high, low] = textQualityFindingHash(finding);
					storedRule.push(rule);
					storedRank.push(ranks[unit]!);
					storedOrdinal.push(ordinal);
					storedHigh.push(high);
					storedLow.push(low);
				});
			}
		}
		checkedTextUnits += ranks.length;
		reportProgress({
			phase: "source_quality",
			completed: checkedTextUnits,
			total: totalTextUnits,
			findings: storedRule.length
		});
	};

	let page: number[] = [],
		pageOccurrences = 0;
	for (let rank = 0; rank < order.length; rank++) {
		const row = order[rank]!;
		if (!visible[row]) continue;
		page.push(rank);
		pageOccurrences += memberEnd[row]! - memberStart[row]!;
		if (page.length < SCAN_PAGE_UNITS && pageOccurrences < SCAN_PAGE_OCCURRENCES) continue;
		checkPage(page);
		page = [];
		pageOccurrences = 0;
		yield* Effect.yieldNow;
	}
	if (page.length || checkedTextUnits === 0) checkPage(page);
	page = [];
	yield* Effect.yieldNow;

	// The scan stores findings unit by unit; the report lists them rule by rule, each rule's in
	// unit order: a stable counting sort by rule.
	const total = storedRule.length;
	const scannedRule = storedRule.finish(),
		scannedRank = storedRank.finish(),
		scannedOrdinal = storedOrdinal.finish(),
		scannedHigh = storedHigh.finish(),
		scannedLow = storedLow.finish();
	const ruleStarts = new Uint32Array(prepared.length + 1);
	for (const rule of scannedRule) ruleStarts[rule + 1]!++;
	for (let rule = 0; rule < prepared.length; rule++) ruleStarts[rule + 1]! += ruleStarts[rule]!;
	const findingRule = new Uint16Array(total),
		findingRank = new Uint32Array(total),
		findingOrdinal = new Uint32Array(total),
		findingHigh = new Uint32Array(total),
		findingLow = new Uint32Array(total);
	const placed = ruleStarts.slice(0, prepared.length);
	for (let stored = 0; stored < total; stored++) {
		const rule = scannedRule[stored]!,
			position = placed[rule]!++;
		findingRule[position] = rule;
		findingRank[position] = scannedRank[stored]!;
		findingOrdinal[position] = scannedOrdinal[stored]!;
		findingHigh[position] = scannedHigh[stored]!;
		findingLow[position] = scannedLow[stored]!;
	}

	/** Rebuilds the findings at these positions from their units, each checked against its hash. */
	const items = (positions: readonly number[]): TextQualityFinding[] => {
		const units = new Map<number, StoredOccurrence[]>();
		const ruleFindings = new Map<string, TextQualityFinding[]>();
		return positions.map((position) => {
			const rank = findingRank[position]!,
				rule = findingRule[position]!;
			let occurrences = units.get(rank);
			if (!occurrences) units.set(rank, (occurrences = unitOccurrences(rank)));
			const key = `${rank}:${rule}`;
			let findings = ruleFindings.get(key);
			if (!findings)
				ruleFindings.set(
					key,
					(findings = textQualityUnitFindings(
						prepared[rule]!,
						unitId(rank),
						occurrences,
						reader.evidence
					))
				);
			const finding = findings[findingOrdinal[position]!];
			const hash = finding && textQualityFindingHash(finding);
			snapshotCheck(
				hash !== undefined &&
					hash[0] === findingHigh[position] &&
					hash[1] === findingLow[position],
				"quality.source",
				"A text unit no longer yields the finding its index recorded"
			);
			return finding!;
		});
	};

	yield* Effect.yieldNow;
	// The bounded diagnostics the index's corpus summarizes; about 0.25 s on 166,518 packages.
	const diagnostics = data.metadataReport();
	yield* Effect.yieldNow;
	return textQualityQueryOf(
		{
			coverage: corpus.coverage,
			diagnostics: diagnostics.diagnostics,
			diagnosticCount: diagnostics.diagnosticCount,
			diagnosticCounts: diagnostics.diagnosticCounts,
			diagnosticsOmitted: diagnostics.diagnosticsOmitted,
			roles: roles.map((role, index) => ({
				matchedOccurrences: matchedOccurrences[index]!,
				matchedTextUnits: matchedTextUnits[index]!,
				role: role.id
			})),
			ruleDocumentVersion: document.schemaVersion,
			rules: rules.map((rule) => {
				const index = prepared.findIndex((item) => item.rule === rule);
				return {
					findingCount: index < 0 ? 0 : ruleStarts[index + 1]! - ruleStarts[index]!,
					ruleId: rule.id
				};
			}),
			schemaVersion: 1,
			status: corpus.status
		},
		{
			length: total,
			kind: (position) => prepared[findingRule[position]!]!.rule.kind,
			id: (position) => textQualityFindingIdOf(findingHigh[position]!, findingLow[position]!),
			find(id) {
				const hash = textQualityFindingIdHash(id);
				if (!hash) return undefined;
				for (let position = 0; position < total; position++)
					if (findingHigh[position] === hash[0] && findingLow[position] === hash[1])
						return position;
				return undefined;
			},
			items
		}
	) satisfies TextQualityQuery;
});
