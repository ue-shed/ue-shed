import { CultureCode, LocalizationTargetName } from "@ue-shed/localization/browser";
import { Schema } from "effect";
import {
	MAX_LOCALIZATION_CULTURES,
	LocalizationCultureMark,
	LocalizationLineId,
	LocalizationLine,
	type LocalizationCultureState,
	type LocalizationJoin
} from "./localization-schema.js";
import { localizationManifestNotes } from "./localization.js";
import { TextUnitId } from "./identifiers.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Page = Schema.Array(Schema.String).check(Schema.isMaxLength(50));
export const LocalizationTargetPreview = Schema.Struct({
	name: LocalizationTargetName,
	nativeCulture: Schema.NullOr(CultureCode),
	cultures: Schema.Array(CultureCode).check(Schema.isMaxLength(MAX_LOCALIZATION_CULTURES))
});
export type LocalizationTargetPreview = typeof LocalizationTargetPreview.Type;
const Failure = Schema.Struct({
	status: Schema.Literal("failed"),
	code: Schema.String,
	message: Schema.String,
	recovery: Schema.String
});
const NotReady = Schema.Struct({ status: Schema.Literal("not_ready") });
export const LocalizationTargetsResult = Schema.Union([
	NotReady,
	Failure,
	Schema.Struct({
		status: Schema.Literal("ready"),
		targets: Schema.Array(LocalizationTargetPreview).check(Schema.isMaxLength(50))
	})
]);
export type LocalizationTargetsResult = typeof LocalizationTargetsResult.Type;
export const LocalizationTargetResult = Schema.Union([
	NotReady,
	Failure,
	Schema.Struct({
		status: Schema.Literal("ready"),
		target: LocalizationTargetPreview,
		lines: Count,
		notSynced: Count
	})
]);
export type LocalizationTargetResult = typeof LocalizationTargetResult.Type;
export const LocalizationFocusRequest = Schema.Struct({
	target: LocalizationTargetName,
	selection: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("line"), id: LocalizationLineId }),
		Schema.Struct({ kind: Schema.Literal("unit"), id: TextUnitId })
	]),
	cultureOffset: Schema.optionalKey(Count),
	locationOffset: Schema.optionalKey(Count),
	poContextOffset: Schema.optionalKey(Count)
});
export type LocalizationFocusRequest = typeof LocalizationFocusRequest.Type;
const CultureTranslationState = Schema.Literals([
	"unknown",
	"not_synced",
	"needs_update",
	"not_translated",
	"translated"
]);
export const LocalizationTranslation = LocalizationCultureMark.pipe(
	Schema.fieldsAssign({
		gameTranslation: Schema.NullOr(Schema.String),
		gameTextKind: Schema.Literals([
			"translation",
			"source_outdated",
			"source_untranslated",
			"unavailable"
		]),
		archiveTranslation: Schema.NullOr(Schema.String),
		cultureState: Schema.NullOr(CultureTranslationState),
		translationSource: Schema.NullOr(Schema.String),
		poTranslation: Schema.NullOr(Schema.NonEmptyString),
		translatorComments: Page,
		flags: Page,
		remainingComments: Count,
		remainingFlags: Count,
		nextContextOffset: Schema.optionalKey(Count)
	})
);
export type LocalizationTranslation = typeof LocalizationTranslation.Type;
const LocalizationScopeSummary = Schema.Struct({
	state: Schema.Literals([
		"outside_target",
		"not_gathered",
		"changed_since_gather",
		"not_found",
		"gathered_only"
	]),
	message: Schema.String
});
export const LocalizationFocus = Schema.Struct({
	id: LocalizationLineId,
	origin: LocalizationLine.fields.origin,
	identity: LocalizationLine.fields.identity,
	source: Schema.String,
	locations: Page,
	translatorNotes: Page,
	totalLocations: Count,
	translations: Schema.Array(LocalizationTranslation).check(Schema.isMaxLength(50)),
	totalCultures: Count,
	scopeSummary: Schema.optionalKey(LocalizationScopeSummary),
	nextCultureOffset: Schema.optionalKey(Count),
	nextLocationOffset: Schema.optionalKey(Count)
});
export type LocalizationFocus = typeof LocalizationFocus.Type;
export const LocalizationFocusResult = Schema.Union([
	NotReady,
	Schema.Struct({ status: Schema.Literal("not_found") }),
	Schema.Struct({ status: Schema.Literal("found"), focus: LocalizationFocus })
]);
export type LocalizationFocusResult = typeof LocalizationFocusResult.Type;

function scopeSummary(
	line: LocalizationLine,
	target: LocalizationJoin["target"]
): typeof LocalizationScopeSummary.Type | undefined {
	const state = line.cultures[0]?.state;
	if (!state || !line.cultures.every((mark) => mark.state === state)) return undefined;
	switch (state) {
		case "outside_target":
			return {
				state,
				message:
					"Not part of " +
					target +
					": its asset is excluded by the target's gather settings."
			};
		case "not_gathered":
			return {
				state,
				message:
					"Not gathered yet: this line is inside " +
					target +
					", but is missing from its gathered text."
			};
		case "changed_since_gather":
			return {
				state,
				message:
					"Changed since gather: the project's source text differs from the text gathered for " +
					target +
					"."
			};
		case "not_found":
			return {
				state,
				message:
					"Not found in the project: its saved asset was fully read, but this key was not found."
			};
		case "gathered_only":
			return {
				state,
				message:
					"Gathered only: this line comes from source code or another file the asset scan does not read."
			};
		default:
			return undefined;
	}
}

/** Unreal's normal .locres source check falls back to source text for stale archive translations. */
function runtimeText(
	line: LocalizationLine,
	mark: LocalizationCultureState
): Pick<LocalizationTranslation, "gameTranslation" | "gameTextKind"> {
	const source = line.manifest[0]?.source.Text ?? line.source;
	if (
		mark.state === "needs_update" ||
		(mark.state === "not_synced" && mark.facts.includes("needs_update"))
	)
		return { gameTranslation: source, gameTextKind: "source_outdated" };
	if (
		mark.state === "not_translated" ||
		(mark.state === "not_synced" && !mark.archive?.translation.Text)
	)
		return { gameTranslation: source, gameTextKind: "source_untranslated" };
	if (mark.state === "translated" || mark.state === "not_synced")
		return {
			gameTranslation: mark.archive?.translation.Text ?? null,
			gameTextKind: "translation"
		};
	return { gameTranslation: null, gameTextKind: "unavailable" };
}

/** A single line's bounded presentation, without file provenance, metadata or PO document blocks. */
export function localizationFocusPage(
	join: LocalizationJoin,
	line: LocalizationLine,
	request: LocalizationFocusRequest
): LocalizationFocus {
	const cultureOffset = request.cultureOffset ?? 0;
	const locationOffset = request.locationOffset ?? 0;
	const contextOffset = request.poContextOffset ?? 0;
	const cultures = [...line.cultures].sort(
		(a, b) =>
			Number(b.culture === join.nativeCulture) - Number(a.culture === join.nativeCulture)
	);
	const summary = scopeSummary(line, join.target);
	return {
		id: line.id,
		origin: line.origin,
		identity: line.identity,
		source: line.source,
		locations: line.manifest
			.slice(locationOffset, locationOffset + 50)
			.map((entry) => entry.path),
		translatorNotes: line.manifest
			.slice(locationOffset, locationOffset + 50)
			.flatMap(localizationManifestNotes)
			.slice(0, 50),
		totalLocations: line.manifest.length,
		translations: cultures.slice(cultureOffset, cultureOffset + 50).map((mark) => ({
			culture: mark.culture,
			state: mark.state,
			facts: mark.facts,
			unknownReasons: mark.unknownReasons,
			reducedSourceChecking: mark.reducedSourceChecking,
			...(mark.review === undefined ? undefined : { review: mark.review }),
			...runtimeText(line, mark),
			archiveTranslation: mark.archive?.translation.Text ?? null,
			cultureState:
				CultureTranslationState.literals.find((state) => mark.facts.includes(state)) ??
				null,
			translationSource: mark.archive?.source.Text ?? null,
			poTranslation:
				mark.facts.includes("not_synced") &&
				mark.poTranslation !== "" &&
				mark.poTranslation !== (mark.archive?.translation.Text ?? "")
					? mark.poTranslation
					: null,
			translatorComments:
				mark.po?.translatorComments.slice(contextOffset, contextOffset + 50) ?? [],
			flags: mark.po?.flags.slice(contextOffset, contextOffset + 50) ?? [],
			remainingComments: Math.max(
				0,
				(mark.po?.translatorComments.length ?? 0) - contextOffset - 50
			),
			remainingFlags: Math.max(0, (mark.po?.flags.length ?? 0) - contextOffset - 50),
			...(Math.max(mark.po?.flags.length ?? 0, mark.po?.translatorComments.length ?? 0) >
			contextOffset + 50
				? { nextContextOffset: contextOffset + 50 }
				: undefined)
		})),
		totalCultures: cultures.length,
		...(summary ? { scopeSummary: summary } : undefined),
		...(cultureOffset + 50 < cultures.length
			? { nextCultureOffset: cultureOffset + 50 }
			: undefined),
		...(locationOffset + 50 < line.manifest.length
			? { nextLocationOffset: locationOffset + 50 }
			: undefined)
	};
}
