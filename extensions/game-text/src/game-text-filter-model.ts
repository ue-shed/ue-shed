import {
	TEXT_ORIGIN_LABELS,
	TEXT_PROBLEM_LABELS,
	TextEditing,
	TextFinding,
	TextNotes,
	TextOriginKind,
	TextProblem,
	TextTranslationState,
	type LocalizationState,
	type TextCapabilityFilter,
	type TextFilter,
	type TextFilterClause,
	type TextFilterField,
	type TextReviewLens,
	type TextWhere
} from "@ue-shed/game-text/browser";

export const FINDING_LABELS = {
	shared: "Used in several places",
	duplicate_source: "Same text, different keys",
	long: "Long text",
	unresolved: "Not localizable"
} satisfies Record<TextFinding, string>;

export const TRANSLATION_LABELS = {
	missing: "Missing",
	to_update: "To update",
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
	notes: "Translator notes"
} satisfies Record<TextFilterField, string>;

/** Fields whose values are a fixed list, with how each value reads. */
export const CHOICE_FIELDS = {
	problem: { values: TextProblem.literals, labels: TEXT_PROBLEM_LABELS },
	translation: { values: TextTranslationState.literals, labels: TRANSLATION_LABELS },
	finding: { values: TextFinding.literals, labels: FINDING_LABELS },
	origin: { values: TextOriginKind.literals, labels: TEXT_ORIGIN_LABELS },
	editing: { values: TextEditing.literals, labels: EDITING_LABELS },
	notes: { values: TextNotes.literals, labels: NOTES_LABELS }
} as const;
export type ChoiceField = keyof typeof CHOICE_FIELDS;

export function isChoiceField(field: TextFilterField): field is ChoiceField {
	return Object.hasOwn(CHOICE_FIELDS, field);
}

/** How one value reads in a pill or a menu. Folders, assets and namespaces read as written. */
export function valueLabel(field: TextFilterField, value: string): string {
	if (!isChoiceField(field)) return value;
	const labels: Readonly<Record<string, string>> = CHOICE_FIELDS[field].labels;
	return labels[value] ?? value;
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

/**
 * Adds or removes one value. Values join the field's existing clause with the same operator, so a
 * field reads as one pill: "Problem is any of Key changed, Not gathered yet".
 */
export function toggleValue(filter: TextFilter, clause: TextFilterClause): TextFilter {
	const value = clause.values[0];
	if (value === undefined) return filter;
	const index = filter.findIndex((item) => item.field === clause.field && item.op === clause.op);
	const existing = filter[index];
	if (existing === undefined) return [...filter, clause];
	const values: readonly string[] = existing.values;
	const next = values.includes(value)
		? values.filter((item) => item !== value)
		: [...values, value];
	const replaced = next.length === 0 ? undefined : withValues(existing, next);
	return replaced === undefined
		? filter.filter((_, position) => position !== index)
		: filter.map((item, position) => (position === index ? replaced : item));
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
		case "folder":
		case "asset":
		case "namespace":
			return values.length === 0 ? undefined : { ...clause, values };
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
