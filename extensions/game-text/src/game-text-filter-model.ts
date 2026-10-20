import { Option, Schema } from "effect";
import { TEXT_AUDIENCE_LABELS } from "@ue-shed/game-text/schema";
import { TEXT_ORIGIN_LABELS, TEXT_PROBLEM_LABELS } from "@ue-shed/game-text/labels";
import {
	TextAudience,
	TextEditing,
	TextFinding,
	TextNotes,
	TextOriginKind,
	TextProblem,
	TextTranslationKey,
	TextTranslationState,
	type LocalizationState,
	type TextCapabilityFilter,
	type TextFilter,
	type TextFilterClause,
	type TextFilterField,
	type TextReviewLens,
	type TextWhere
} from "@ue-shed/game-text/schema";

export const FINDING_LABELS = {
	shared: "Used in several places",
	duplicate_source: "Same text, different keys",
	long: "Long text",
	unresolved: "Not localizable"
} satisfies Record<TextFinding, string>;

export const TRANSLATION_LABELS = {
	missing: "Not translated",
	to_update: "Needs update",
	not_synced: "Not synced"
} satisfies Record<TextTranslationState, string>;

export const EDITING_LABELS = {
	editable: "Editable",
	read_only: "Read only"
} satisfies Record<TextEditing, string>;

export const NOTES_LABELS = {
	missing: "No translator notes",
	present: "Has translator notes"
} satisfies Record<TextNotes, string>;

export const FIELD_LABELS = {
	problem: "Problem",
	translation: "Translation",
	finding: "Finding",
	origin: "Origin",
	folder: "Folder",
	asset: "Asset",
	namespace: "Namespace",
	editing: "Editing",
	notes: "Translator notes",
	audience: "Audience",
	translation_key: "Translation key"
} satisfies Record<TextFilterField, string>;

/** Fields whose values are a fixed list, with how each value reads. */
export const CHOICE_FIELDS = {
	problem: { values: TextProblem.literals, labels: TEXT_PROBLEM_LABELS },
	translation: { values: TextTranslationState.literals, labels: TRANSLATION_LABELS },
	finding: { values: TextFinding.literals, labels: FINDING_LABELS },
	origin: { values: TextOriginKind.literals, labels: TEXT_ORIGIN_LABELS },
	editing: { values: TextEditing.literals, labels: EDITING_LABELS },
	notes: { values: TextNotes.literals, labels: NOTES_LABELS },
	audience: { values: TextAudience.literals, labels: TEXT_AUDIENCE_LABELS }
} as const;
export type ChoiceField = keyof typeof CHOICE_FIELDS;

export function isChoiceField(field: TextFilterField): field is ChoiceField {
	return Object.hasOwn(CHOICE_FIELDS, field);
}

/**
 * How one value reads in a pill or a menu. Folders, assets and namespaces read as written; a
 * translation key reads `Namespace, Key`, or the key alone in the empty namespace.
 */
export function valueLabel(field: TextFilterField, value: string): string {
	if (field === "translation_key") return translationKeyLabel(value);
	if (!isChoiceField(field)) return value;
	const labels: Readonly<Record<string, string>> = CHOICE_FIELDS[field].labels;
	return labels[value] ?? value;
}

/** Whether a value is a translation key, `JSON.stringify([namespace, key])`. */
export const isTranslationKey = Schema.is(TextTranslationKey);

const translationKeyParts = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]))
);

function translationKeyLabel(value: string): string {
	return Option.match(translationKeyParts(value), {
		onNone: () => value,
		onSome: ([namespace, key]) => (namespace === "" ? key : `${namespace}, ${key}`)
	});
}

/** "Problem is any of Key changed, Not gathered yet" as its three parts. */
export function clauseParts(clause: TextFilterClause) {
	const values: readonly string[] = clause.values;
	return {
		field: FIELD_LABELS[clause.field],
		op:
			clause.op === "is_not"
				? values.length > 1
					? "is none of"
					: "is not"
				: values.length > 1
					? "is any of"
					: "is",
		values: values.map((value) => valueLabel(clause.field, value)).join(", ")
	};
}

/** Whether the filter has a clause selecting this value with this operator. */
export function hasValue(
	filter: TextFilter,
	field: TextFilterField,
	value: string,
	op: TextFilterClause["op"] = "is"
): boolean {
	return filter.some(
		(clause) =>
			clause.field === field &&
			clause.op === op &&
			clause.values.some((item: string) => item === value)
	);
}

/** The operator a field's pill uses, if the field has one. */
export function fieldOp(
	filter: TextFilter,
	field: TextFilterField
): TextFilterClause["op"] | undefined {
	return filter.find((clause) => clause.field === field)?.op;
}

/**
 * Adds or removes one value. A field reads as one pill, "Problem is any of Key changed, Not
 * gathered yet": a value already in a pill leaves it, and a new value joins the field's pill with
 * that pill's operator. Only a field without a pill takes the given clause's operator.
 */
export function toggleValue(filter: TextFilter, clause: TextFilterClause): TextFilter {
	const value = clause.values[0];
	if (value === undefined) return filter;
	const holding = filter.findIndex(
		(item) =>
			item.field === clause.field && item.values.some((entry: string) => entry === value)
	);
	const index = holding >= 0 ? holding : filter.findIndex((item) => item.field === clause.field);
	const existing = filter[index];
	if (existing === undefined) return [...filter, clause];
	const values: readonly string[] = existing.values;
	const next = holding >= 0 ? values.filter((item) => item !== value) : [...values, value];
	const replaced = next.length === 0 ? undefined : withValues(existing, next);
	return replaced === undefined
		? filter.filter((_, position) => position !== index)
		: filter.map((item, position) => (position === index ? replaced : item));
}

/**
 * Switches one pill between "is" and "is not". Filters saved with both operators for a field
 * merge into one pill when the switch would leave two with the same operator.
 */
export function flipClause(filter: TextFilter, index: number): TextFilter {
	const clause = filter[index];
	if (clause === undefined) return filter;
	const op = clause.op === "is" ? ("is_not" as const) : ("is" as const);
	const twin = filter.findIndex(
		(item, position) => position !== index && item.field === clause.field && item.op === op
	);
	if (twin < 0)
		return filter.map((item, position) => (position === index ? { ...clause, op } : item));
	const twinClause = filter[twin];
	const twinValues: readonly string[] = twinClause?.values ?? [];
	const values: readonly string[] = clause.values;
	const merged =
		twinClause &&
		withValues(twinClause, [...twinValues, ...values.filter((v) => !twinValues.includes(v))]);
	return filter.flatMap((item, position) =>
		position === index ? [] : position === twin && merged ? [merged] : [item]
	);
}

/** The same clause with other values, keeping only values its field accepts. */
function withValues(
	clause: TextFilterClause,
	values: readonly string[]
): TextFilterClause | undefined {
	switch (clause.field) {
		case "problem": {
			const kept = values.filter(isProblem);
			return kept.length === 0 ? undefined : { ...clause, values: kept };
		}
		case "translation": {
			const kept = values.filter(isTranslation);
			return kept.length === 0 ? undefined : { ...clause, values: kept };
		}
		case "finding": {
			const kept = values.filter(isFinding);
			return kept.length === 0 ? undefined : { ...clause, values: kept };
		}
		case "origin": {
			const kept = values.filter(isOrigin);
			return kept.length === 0 ? undefined : { ...clause, values: kept };
		}
		case "editing": {
			const kept = values.filter(isEditing);
			return kept.length === 0 ? undefined : { ...clause, values: kept };
		}
		case "notes": {
			const kept = values.filter(isNotes);
			return kept.length === 0 ? undefined : { ...clause, values: kept };
		}
		case "audience": {
			const kept = values.filter(isAudience);
			return kept.length === 0 ? undefined : { ...clause, values: kept };
		}
		case "folder":
		case "asset":
		case "namespace":
			return values.length === 0 ? undefined : { ...clause, values };
		case "translation_key": {
			const kept = values.filter(isTranslationKey);
			return kept.length === 0 ? undefined : { ...clause, values: kept };
		}
	}
}

const isProblem = (value: string): value is TextProblem =>
	TextProblem.literals.some((item) => item === value);
const isTranslation = (value: string): value is TextTranslationState =>
	TextTranslationState.literals.some((item) => item === value);
const isFinding = (value: string): value is TextFinding =>
	TextFinding.literals.some((item) => item === value);
const isOrigin = (value: string): value is TextOriginKind =>
	TextOriginKind.literals.some((item) => item === value);
const isEditing = (value: string): value is TextEditing =>
	TextEditing.literals.some((item) => item === value);
const isNotes = (value: string): value is TextNotes =>
	TextNotes.literals.some((item) => item === value);
const isAudience = (value: string): value is TextAudience =>
	TextAudience.literals.some((item) => item === value);

/** The saved filters of an earlier Game Text, before pills. */
export interface LegacyFilters {
	readonly capability?: TextCapabilityFilter | undefined;
	readonly lens?: TextReviewLens | undefined;
	readonly withoutNotes?: boolean | undefined;
	readonly where?: TextWhere | undefined;
	readonly localizationState?: LocalizationState | undefined;
	readonly localizationKeyChanged?: boolean | undefined;
}

/**
 * Pills for the toggles, lenses and state chips an earlier Game Text saved. What has no pill stays
 * where it was: changed files on `where.files`, and the gathered-only, not found, outside, unknown
 * and translated states on the selection.
 */
export function legacyFilter(saved: LegacyFilters) {
	const filter: TextFilterClause[] = [];
	if (saved.localizationKeyChanged)
		filter.push({ field: "problem", op: "is", values: ["key_changed"] });
	let remainingState: LocalizationState | undefined;
	switch (saved.localizationState) {
		case "not_gathered":
		case "changed_since_gather":
			filter.push({ field: "problem", op: "is", values: [saved.localizationState] });
			break;
		case "not_translated":
			filter.push({ field: "translation", op: "is", values: ["missing"] });
			break;
		case "needs_update":
			filter.push({ field: "translation", op: "is", values: ["to_update"] });
			break;
		case "not_synced":
			filter.push({ field: "translation", op: "is", values: ["not_synced"] });
			break;
		default:
			remainingState = saved.localizationState;
	}
	switch (saved.lens) {
		case "shared":
		case "duplicate_source":
		case "long":
		case "unresolved":
			filter.push({ field: "finding", op: "is", values: [saved.lens] });
			break;
		case "conflicting":
			filter.push({ field: "problem", op: "is", values: ["conflicting_source"] });
			break;
		default:
			break;
	}
	if (saved.capability === "source_editable")
		filter.push({ field: "editing", op: "is", values: ["editable"] });
	if (saved.capability === "read_only")
		filter.push({ field: "editing", op: "is", values: ["read_only"] });
	if (saved.withoutNotes) filter.push({ field: "notes", op: "is", values: ["missing"] });
	if (saved.where?.kinds !== undefined)
		filter.push({ field: "origin", op: "is", values: saved.where.kinds });
	if (saved.where?.pathPrefix !== undefined)
		filter.push({ field: "folder", op: "is", values: [saved.where.pathPrefix] });
	return { filter, remainingState };
}
