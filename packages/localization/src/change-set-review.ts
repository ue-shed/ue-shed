import { Schema } from "effect";
import { LocalizationChange, type LocalizationChangeSet } from "./change-sets.js";
import {
	CultureCode,
	LocalizationIdentity,
	LocalizationTargetName,
	type ArchiveEntry,
	type LocalizationTargetEvidence,
	type POEntry
} from "./schema.js";

/**
 * Why a proposed change can or cannot be written now. Only `ready` changes are written; every
 * other outcome explains what changed since the proposal or what evidence is missing.
 */
export const LocalizationChangeOutcome = Schema.Literals([
	"ready",
	"unchanged",
	"wrong_target",
	"culture_unavailable",
	"not_in_manifest",
	"stale_source",
	"not_in_po",
	"po_out_of_date",
	"stale_translation"
]);
export type LocalizationChangeOutcome = typeof LocalizationChangeOutcome.Type;

/**
 * One proposal classified against current evidence, including the effective translation
 * before writing. Only a ready outcome is eligible for replacement.
 */
export const LocalizationChangeReview = Schema.Struct({
	change: LocalizationChange,
	outcome: LocalizationChangeOutcome,
	/** What the next sync would ship before this change: a pending PO edit, else the archive. */
	currentTranslation: Schema.NullOr(Schema.String)
});
export type LocalizationChangeReview = typeof LocalizationChangeReview.Type;

/**
 * Currentness review and PO files a proposed write would replace. Hosts can check these files
 * out before applying; review itself neither writes nor reserves them against later changes.
 */
export const LocalizationChangeSetReview = Schema.Struct({
	target: LocalizationTargetName,
	changes: Schema.Array(LocalizationChangeReview),
	/** PO files a write would replace. Hosts check these out before writing. */
	files: Schema.Array(
		Schema.Struct({
			culture: CultureCode,
			relativePath: Schema.String,
			contentHash: Schema.String,
			changes: Schema.Int
		})
	)
});
export type LocalizationChangeSetReview = typeof LocalizationChangeSetReview.Type;

const same = (left: LocalizationIdentity, right: LocalizationIdentity) =>
	left.namespace === right.namespace && left.key === right.key;

/**
 * The translation the next sync ships: a non-empty PO msgstr wins over the archive (import rule).
 * Given one entry of each, this is the rule; `shippedEvidenceTranslation` applies it to a line's
 * entries as the Game Text join does.
 */
export function currentLocalizationTranslation(
	archiveTranslation: string | null,
	po: POEntry | undefined
): string | null {
	const pending = po?.msgstr["0"];
	return pending !== undefined && pending !== "" ? pending : archiveTranslation;
}

/**
 * The translation the next sync ships from all of a line's archive and PO entries, decided as the
 * Game Text join decides it, so a review fingerprint from parsed files equals the engine's. The
 * PO's pending edit counts only when the PO has exactly one entry for the line, the archive at
 * most one, and the archive was read or is missing; `archive` is undefined for one that exists
 * but could not be read, whose translations are unknown. Otherwise the first archive entry ships.
 *
 * One difference remains: a PO collapsed by `IdenticalNamespaceAndSource` names its entries by
 * namespace and source, which the join matches to the line and parsed evidence does not, so here
 * such a pending edit does not count.
 */
export function shippedEvidenceTranslation(
	archive: readonly ArchiveEntry[] | undefined,
	po: readonly POEntry[]
): string | null {
	const archived = archive?.[0]?.translation.Text ?? null;
	const pending =
		archive !== undefined && archive.length <= 1 && po.length === 1 ? po[0] : undefined;
	return currentLocalizationTranslation(archived, pending);
}

/** A culture's archive entries for a line: undefined when the archive exists but is unreadable. */
export function evidenceArchiveEntries(
	archive: LocalizationTargetEvidence["cultures"][number]["archive"],
	identity: LocalizationIdentity
): readonly ArchiveEntry[] | undefined {
	if (archive.status === "read")
		return archive.value.entries.filter((entry) => same(entry, identity));
	return archive.error.code === "file_missing" ? [] : undefined;
}

/**
 * What review reads of one change's line, when a host has already read it, such as from a Game
 * Text index: with it, review decodes no whole localization file.
 */
export interface LocalizationChangeLine {
	/** The manifest's source; undefined when the manifest has no entry with the identity. */
	readonly source: string | undefined;
	/** What the next sync ships before the change. */
	readonly currentTranslation: string | null;
	/** The PO entry with the identity; undefined when the PO has none. */
	readonly po: { readonly msgid: string } | undefined;
	/** Whether the PO carries source text, so an entry exported before the source changed shows. */
	readonly poHasSourceText: boolean;
}

/** One change's line read from the parsed evidence files. */
function evidenceLine(
	evidence: LocalizationTargetEvidence,
	culture: LocalizationTargetEvidence["cultures"][number],
	identity: LocalizationIdentity
): LocalizationChangeLine | undefined {
	if (culture.po.status !== "read") return undefined;
	const manifest = evidence.manifest.status === "read" ? evidence.manifest.value : undefined;
	const document = culture.po.value;
	const entries = document.entries.filter(
		(entry) => entry.identity !== null && same(entry.identity, identity)
	);
	return {
		source: manifest?.entries.find((entry) => same(entry, identity))?.source.Text,
		currentTranslation: shippedEvidenceTranslation(
			evidenceArchiveEntries(culture.archive, identity),
			entries
		),
		po: entries[0],
		poHasSourceText: document.hasSourceText
	};
}

/**
 * Revalidates every change against fresh evidence. Pure: it neither reads nor writes files. With
 * `lines`, each change's line comes from the host instead of the evidence's parsed files; the
 * evidence then gives only the target, its cultures and their files' statuses and provenance.
 */
export function reviewLocalizationChangeSet(
	evidence: LocalizationTargetEvidence,
	changeSet: LocalizationChangeSet,
	lines?: (change: LocalizationChange) => LocalizationChangeLine
): LocalizationChangeSetReview {
	const target = evidence.target.name;
	const changes = changeSet.changes.map((change): LocalizationChangeReview => {
		const review = (
			outcome: LocalizationChangeOutcome,
			currentTranslation: string | null = null
		) => LocalizationChangeReview.make({ change, outcome, currentTranslation });
		if (change.target !== target) return review("wrong_target");
		const culture = evidence.cultures.find((item) => item.culture === change.culture);
		if (culture === undefined || culture.po.status !== "read")
			return review("culture_unavailable");
		const identity = { namespace: change.namespace, key: change.key };
		const line = lines?.(change) ?? evidenceLine(evidence, culture, identity);
		if (line === undefined) return review("culture_unavailable");
		const { source, po, currentTranslation: current } = line;
		if (source === undefined) return review("not_in_manifest");
		if (source !== change.source) return review("stale_source");
		if (po === undefined) return review("not_in_po", current);
		// A PO exported before the source changed would import the edit against the old source.
		if (line.poHasSourceText && po.msgid !== source) return review("po_out_of_date", current);
		// Absent and empty both mean nothing ships. A gather gives a new key an empty translation,
		// so an edit staged before the gather, against no translation at all, is still current.
		if ((change.previousTranslation ?? "") !== (current ?? ""))
			return review("stale_translation", current);
		if (change.translation === current) return review("unchanged", current);
		return review("ready", current);
	});
	const files = evidence.cultures.flatMap((culture) => {
		const ready = changes.filter(
			(item) => item.outcome === "ready" && item.change.culture === culture.culture
		).length;
		return ready > 0 && culture.po.status === "read"
			? [
					{
						culture: culture.culture,
						relativePath: culture.po.provenance.relativePath,
						contentHash: culture.po.provenance.contentHash,
						changes: ready
					}
				]
			: [];
	});
	return LocalizationChangeSetReview.make({ target, changes, files });
}

/** True when nothing blocks writing: every change is ready or already in place. */
export function localizationChangeSetIsCurrent(review: LocalizationChangeSetReview): boolean {
	return review.changes.every((item) => item.outcome === "ready" || item.outcome === "unchanged");
}
