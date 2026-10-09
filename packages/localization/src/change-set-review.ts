import { Schema } from "effect";
import { LocalizationChange, type LocalizationChangeSet } from "./change-sets.js";
import {
	CultureCode,
	LocalizationIdentity,
	LocalizationTargetName,
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

export const LocalizationChangeReview = Schema.Struct({
	change: LocalizationChange,
	outcome: LocalizationChangeOutcome,
	/** What the next sync would ship before this change: a pending PO edit, else the archive. */
	currentTranslation: Schema.NullOr(Schema.String)
});
export type LocalizationChangeReview = typeof LocalizationChangeReview.Type;

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

/** The translation the next sync ships: a non-empty PO msgstr wins over the archive (import rule). */
export function currentLocalizationTranslation(
	archiveTranslation: string | null,
	po: POEntry | undefined
): string | null {
	const pending = po?.msgstr["0"];
	return pending !== undefined && pending !== "" ? pending : archiveTranslation;
}

/** Revalidates every change against fresh evidence. Pure: it neither reads nor writes files. */
export function reviewLocalizationChangeSet(
	evidence: LocalizationTargetEvidence,
	changeSet: LocalizationChangeSet
): LocalizationChangeSetReview {
	const target = evidence.target.name;
	const manifest = evidence.manifest.status === "read" ? evidence.manifest.value : undefined;
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
		const source = manifest?.entries.find((entry) => same(entry, identity))?.source.Text;
		if (source === undefined) return review("not_in_manifest");
		if (source !== change.source) return review("stale_source");
		const document = culture.po.value;
		const po = document.entries.find(
			(entry) => entry.identity !== null && same(entry.identity, identity)
		);
		const archive =
			culture.archive.status === "read"
				? (culture.archive.value.entries.find((entry) => same(entry, identity))?.translation
						.Text ?? null)
				: null;
		const current = currentLocalizationTranslation(archive, po);
		if (po === undefined) return review("not_in_po", current);
		// A PO exported before the source changed would import the edit against the old source.
		if (document.hasSourceText && po.msgid !== source) return review("po_out_of_date", current);
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
