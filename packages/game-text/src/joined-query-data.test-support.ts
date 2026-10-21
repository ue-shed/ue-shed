import { encodeWtf8 } from "./wtf8.js";

import { Schema } from "effect";

import { runJoinedQuery } from "./joined-query-node.js";
import { snapshotCheck } from "./snapshot-format.js";

import type { TextUnit, TextUnitSearchResult } from "./schema.js";

import {
	LocalizationLineId,
	LocalizationEvidenceLineId,
	LocalizationUnknownReason,
	localizationStates,
	type LocalizationLinePreview
} from "./localization-schema.js";
import { LocalizationIdentity } from "@ue-shed/localization/browser";
import { StringArena } from "./shared-string-codec.js";
import { TEXT_OUT_OF_SCOPE_REASONS, textAudienceOfMask } from "./text-audience.js";
import {
	readJoinedSourceCache,
	addSourceTrigrams,
	rejectSourceTrigrams
} from "./joined-source-cache.test-support.js";
import { IndexedPolicyData, querySignals } from "./indexed-policy-data.js";
export {
	querySignals,
	reuseJoinedQueryProjection,
	type JoinedQueryProjection
} from "./indexed-policy-data.js";

/** Columnar query oracle, excluded from production packages. */
export class JoinedQueryData extends IndexedPolicyData {
	readonly #assetClasses = new Map<number, string>();
	/** The main asset class of a global occurrence row's package, empty when it has none. */
	occurrenceAssetClass(global: number): string {
		const { shard, row } = this.occurrenceShard(global);
		const packageStarts = this.packageColumn(shard, "package.occurrence_start");
		let low = 0,
			high = packageStarts.length - 2;
		while (low < high) {
			const mid = (low + high + 1) >>> 1;
			if (packageStarts[mid]! <= row) low = mid;
			else high = mid - 1;
		}
		const memo = shard * 2 ** 32 + low;
		let type = this.#assetClasses.get(memo);
		if (type === undefined) {
			type = this.strings([this.packageColumn(shard, "package.asset_class")[low]!])[0]!;
			this.#assetClasses.set(memo, type);
		}
		return type;
	}
	/** Expand encoded source bytes once. Text search never repeatedly inflates A64 blocks. */
	prepareSources() {
		if (this.projection.sources || !this.joined.reader.bytesSync) return;
		const last = this.joined.reader.manifest.segments.at(-1);
		const selected = new Uint8Array(last ? last.start + last.count : 0);
		for (const id of this.column("line.source")) selected[id] = 1;
		for (const id of this.column("query.raw.sources")) selected[id] = 1;
		if (!this.projection.sourceSeed && this.joined.meta.sourceCache) {
			const bytes = runJoinedQuery(this.joined.layer.section("query.source.bytes"));
			snapshotCheck(bytes instanceof Uint8Array, "query.source.bytes", "Expected byte cache");
			const trigrams = this.joined.meta.sourceCache.trigramVersion
				? runJoinedQuery(this.joined.layer.section("query.source.trigrams"))
				: undefined;
			snapshotCheck(
				trigrams === undefined || trigrams instanceof Uint8Array,
				"query.source.trigrams",
				"Expected byte index"
			);
			const flags = this.joined.meta.sourceCache.flagsVersion
				? runJoinedQuery(this.joined.layer.section("query.source.simple"))
				: undefined;
			snapshotCheck(
				flags === undefined || flags instanceof Uint8Array,
				"query.source.simple",
				"Expected byte flags"
			);
			const cached = readJoinedSourceCache(
				this.joined.meta.sourceCache,
				this.column("query.source.ids"),
				this.column("query.source.starts"),
				bytes,
				selected.length,
				trigrams,
				flags
			);
			if (!this.joined.meta.base) {
				let count = 0;
				for (const present of selected) count += present;
				snapshotCheck(
					count === cached.ids.length,
					"query.source",
					"Source cache selection differs"
				);
				for (const id of cached.ids)
					snapshotCheck(selected[id] === 1, "query.source", "Source cache ID is unused");
				this.projection.sources = cached;
				return;
			}
			this.projection.sourceSeed = cached;
		}
		const seed = this.projection.sourceSeed;
		this.projection.sourceSeed = undefined;
		if (seed) {
			const added: number[] = [];
			let obsolete = 0,
				obsoleteBytes = 0;
			for (let row = 0; row < seed.ids.length; row++)
				if (!selected[seed.ids[row]!]) {
					obsolete++;
					obsoleteBytes += seed.packed.offsets[row + 1]! - seed.packed.offsets[row]!;
				}
			for (let id = 0; id < selected.length; id++)
				if (selected[id] && !seed.index[id]) added.push(id);
			// Keep stale source bytes bounded even across many edits of one identity.
			if (added.length <= 8192 && obsolete <= 8192 && obsoleteBytes <= 32 * 1024 ** 2) {
				const index = new Uint32Array(selected.length);
				index.set(seed.index.subarray(0, index.length));
				if (!added.length) {
					this.projection.sources = { ...seed, index };
					return;
				}
				const arena = new StringArena();
				for (const id of added) arena.add(this.joined.reader.bytesSync(id));
				const extra = arena.finish();
				const bytes = Buffer.concat([seed.packed.bytes, extra.bytes]);
				const offsets = new Float64Array(seed.ids.length + added.length + 1);
				offsets.set(seed.packed.offsets);
				for (let row = 0; row <= added.length; row++)
					offsets[seed.ids.length + row] = seed.packed.bytes.length + extra.offsets[row]!;
				const ids = new Uint32Array(seed.ids.length + added.length),
					simple = new Uint8Array(ids.length),
					trigrams = seed.trigrams?.slice();
				ids.set(seed.ids);
				simple.set(seed.simple);
				for (let row = 0; row < added.length; row++) {
					const id = added[row]!,
						position = seed.ids.length + row;
					ids[position] = id;
					index[id] = position + 1;
					const value = extra.bytes.subarray(extra.offsets[row], extra.offsets[row + 1]);
					simple[position] = Number(
						!value.some((byte) => byte >= 128 || (byte >= 65 && byte <= 90))
					);
					if (trigrams && simple[position]) addSourceTrigrams(trigrams, value);
				}
				this.projection.sources = {
					packed: { bytes, offsets },
					index,
					ids,
					simple,
					...(trigrams ? { trigrams } : undefined)
				};
				return;
			}
		}
		const index = new Uint32Array(selected.length),
			arena = new StringArena();
		let count = 0;
		for (let id = 0; id < selected.length; id++)
			if (selected[id]) {
				index[id] = ++count;
				arena.add(this.joined.reader.bytesSync(id));
			}
		const expanded = arena.finish(),
			packed = {
				...expanded,
				bytes:
					expanded.bytes.buffer.byteLength > expanded.bytes.length * 1.25
						? Buffer.from(expanded.bytes)
						: expanded.bytes
			},
			ids = new Uint32Array(count),
			simple = new Uint8Array(count);
		for (let id = 0; id < index.length; id++)
			if (index[id]) {
				const row = index[id]! - 1;
				ids[row] = id;
				const bytes = packed.bytes.subarray(packed.offsets[row], packed.offsets[row + 1]);
				simple[row] = Number(
					!bytes.some((byte) => byte >= 128 || (byte >= 65 && byte <= 90))
				);
			}
		this.projection.sources = { packed, index, ids, simple };
	}

	/** Lowercase ASCII sources cannot contain a non-ASCII search term, even after locale folding. */
	rejectAsciiSources(checkInterrupted?: () => void): Uint8Array | undefined {
		const source = this.projection.sources;
		if (!source) return undefined;
		const result = new Uint8Array(source.index.length);
		for (let row = 0; row < source.ids.length; row++) {
			if ((row & 255) === 0) checkInterrupted?.();
			if (source.simple[row]) result[source.ids[row]!] = 2;
		}
		return result;
	}

	/** Native byte scans find ASCII terms without allocating one string/view per source. */
	searchSourceBytes(
		terms: readonly Buffer[],
		checkInterrupted?: () => void
	): Uint8Array | undefined {
		const source = this.projection.sources;
		if (!source) return undefined;
		if (source.trigrams && rejectSourceTrigrams(source.trigrams, terms))
			return this.rejectAsciiSources(checkInterrupted);
		const counts = new Uint32Array(source.ids.length),
			offsets = source.packed.offsets,
			bytes = source.packed.bytes;
		for (const term of terms) {
			let row = 0,
				position = 0;
			for (;;) {
				if ((row & 255) === 0) checkInterrupted?.();
				const found = bytes.indexOf(term, position);
				if (found < 0) break;
				while (row < counts.length && offsets[row + 1]! <= found) row++;
				if (row >= counts.length) break;
				if (found + term.length <= offsets[row + 1]!) {
					counts[row]!++;
					position = offsets[row + 1]!;
				} else position = found + 1;
			}
		}
		const result = new Uint8Array(source.index.length);
		for (let row = 0; row < source.ids.length; row++)
			result[source.ids[row]!] =
				counts[row] === terms.length ? 1 : source.simple[row] ? 2 : 0;
		return result;
	}

	sourceBytes(id: number): Uint8Array | undefined {
		const source = this.projection.sources,
			row = source?.index[id];
		return row
			? source!.packed.bytes.subarray(
					source!.packed.offsets[row - 1],
					source!.packed.offsets[row]
				)
			: this.joined.reader.bytesSync?.(id);
	}

	/** Compare exact ID bytes; focus and cursors never decode all identities. */
	findId(kind: "raw" | "line", id: string): number | undefined {
		const starts = this.column(`query.${kind}.id_starts`),
			values = this.column(`query.${kind}.id_utf8`);
		const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
			wanted = encodeWtf8(id);
		for (let row = 0; row + 1 < starts.length; row++) {
			const start = starts[row]!;
			if (starts[row + 1]! - start !== wanted.length) continue;
			let index = 0;
			while (index < wanted.length && bytes[start + index] === wanted[index]) index++;
			if (index === wanted.length) return row;
		}
		return undefined;
	}

	presentation(kind: "raw" | "slice", row: number): TextUnitSearchResult {
		const prefix = `query.${kind}.`;
		const members = this.members(kind, row);
		const contexts = Array.from(members.subarray(0, 3), (member) => {
			const occurrence = this.occurrence(member);
			return { editCapability: occurrence.editCapability, location: occurrence.location };
		});
		const first = this.occurrence(this.column(prefix + "representative")[row]!);
		const values = this.strings(
			Array.from(
				this.column(prefix + "sources").subarray(
					this.column(prefix + "source_start")[row]!,
					this.column(prefix + "source_end")[row]!
				)
			)
		);
		const origins = this.column(prefix + "origins")[row]!;
		return {
			id: this.id(this.column(prefix + "raw")[row]!),
			identity: first.identity,
			source:
				values.length === 1
					? { status: "consistent", value: values[0]! }
					: { status: "conflicting", values },
			contexts,
			occurrenceCount: members.length,
			remainingContextCount: Math.max(0, members.length - contexts.length),
			characterCount: this.column(prefix + "characters")[row]!,
			wordCount: this.column(prefix + "words")[row]!,
			reviewSignals: querySignals.filter(
				(_, bit) => this.column(prefix + "signals")[row]! & (1 << bit)
			),
			locationKinds: [
				...(origins & 4 ? ["asset_property" as const] : []),
				...(origins & 2 ? ["data_table_cell" as const] : []),
				...(origins & 1 ? ["string_table_entry" as const] : [])
			],
			audience: textAudienceOfMask(this.column(prefix + "audience")[row]!)
		};
	}

	/** Text search decodes only selected source/translation values, never full evidence rows. */
	searchableTranslations(row: number, scope: readonly number[]) {
		const target = this.joined.meta.input.target,
			ids = [this.column("line.source")[row]!];
		for (const ci of scope) {
			const culture = target.cultures[ci]!,
				archive = this.column(`c${ci}.archive`)[row]!;
			if (archive)
				ids.push(this.translationId(target.outputPaths.archives[culture]!, archive - 1)!);
			if (this.column(`c${ci}.facts`)[row]! & 8) {
				const po = this.column(`c${ci}.po`)[row]!;
				const translation = po
					? this.translationId(target.outputPaths.portableObjects[culture]!, po - 1, true)
					: undefined;
				if (translation !== undefined) ids.push(translation);
			}
		}
		return this.strings(ids).join(" ").toLocaleLowerCase();
	}

	/** Pages need only coordinates, state marks and displayed translations, never full PO entries. */
	preview(row: number): LocalizationLinePreview {
		const target = this.joined.meta.input.target,
			c = (name: string) => this.column(name)[row]!;
		const id = LocalizationLineId.make(this.lineId(row));
		const source = this.strings([c("line.source")])[0]!;
		const starts = this.column("query.line.starts"),
			raws = this.column("query.slice.raw");
		const units = new Set<TextUnit["id"]>();
		for (let sr = starts[row]!; sr < starts[row + 1]!; sr++) units.add(this.id(raws[sr]!));
		const [namespace, key] = this.strings([c("line.namespace"), c("line.key")]);
		const identity =
			units.size && key === ""
				? null
				: Schema.decodeUnknownSync(LocalizationIdentity)({
						namespace: namespace!,
						key: key!
					});
		const begin = c("line.manifest_start"),
			end = c("line.manifest_end"),
			manifestRows = this.column("manifest.rows");
		const manifestLocations: string[] = [];
		for (let offset = begin; offset < Math.min(begin + 3, end); offset++) {
			const name = target.outputPaths.manifest!,
				entry = manifestRows[offset]!;
			const path = this.strings([this.fileColumn(name, "path")[entry]!])[0]!;
			if (this.fileColumn(name, "options")[entry]! & 1024) {
				const file = this.joined.reader.layerSync!(this.joined.meta.dependencies[name]!);
				const meta = Schema.decodeUnknownSync(
					Schema.fromJsonString(
						Schema.Struct({ pathPrefix: Schema.optionalKey(Schema.String) })
					)
				)(new TextDecoder().decode(file.section("file.meta")));
				manifestLocations.push((meta.pathPrefix ?? "") + path);
			} else manifestLocations.push(path);
		}
		const change = c("line.key_change"),
			pair = this.joined.meta.pairs[(change >>> 1) - 1];
		const audience = c("line.audience"),
			outOfScope = TEXT_OUT_OF_SCOPE_REASONS[(audience >>> 4) - 1];
		return {
			id,
			source,
			identity,
			audience: textAudienceOfMask(audience),
			...(outOfScope === undefined ? undefined : { outOfScope }),
			manifestLocations,
			remainingLocationCount: Math.max(0, end - begin - 3),
			origin: units.size
				? { kind: "corpus", unitIds: [...units].sort() }
				: { kind: "evidence", id: LocalizationEvidenceLineId.make(`evidence:${id}`) },
			...(pair
				? {
						keyChange: {
							direction: change & 1 ? "from" : "to",
							other: change & 1 ? pair.to : pair.from,
							match: pair.match,
							sourceChanged: pair.sourceChanged,
							previousSource: pair.previousSource,
							translations: pair.translations
						}
					}
				: undefined),
			cultures: target.cultures.map((culture, ci) => {
				const prefix = `c${ci}.`,
					facts = c(prefix + "facts"),
					review = c(prefix + "review"),
					record =
						this.joined.meta.input.review?.records[c(prefix + "review_record") - 1];
				const notSynced = Boolean(facts & 8),
					entry = c(prefix + (notSynced ? "po" : "archive"));
				const translation = entry
					? this.translationId(
							(notSynced
								? target.outputPaths.portableObjects
								: target.outputPaths.archives)[culture]!,
							entry - 1,
							notSynced
						)
					: undefined;
				return {
					culture,
					state: localizationStates[c(prefix + "state")]!,
					facts: localizationStates.filter((_, bit) => facts & (1 << bit)),
					unknownReasons: LocalizationUnknownReason.literals.filter(
						(_, bit) => c(prefix + "reasons") & (1 << bit)
					),
					reducedSourceChecking: this.joined.meta.reducedSourceChecking[ci]!,
					translation:
						translation === undefined
							? notSynced
								? ""
								: null
							: this.strings([translation])[0]!,
					...(review
						? {
								review:
									review < 2
										? { status: "not_reviewed" as const }
										: {
												status:
													review === 2
														? ("current" as const)
														: ("changed" as const),
												flags: record!.flags,
												by: record!.by,
												at: record!.at
											}
							}
						: undefined)
				};
			})
		};
	}
}
