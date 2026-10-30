import { Effect, Option, Schema } from "effect";
import {
	TextQualityFindingId,
	WorkspaceQualityFilter,
	LocalizationEdit
} from "@ue-shed/game-text/corpus";
import {
	BuiltInCheckEntry,
	CustomLocalizationCheck,
	GameTextRuleDocument,
	LocalizationProjectRule
} from "@ue-shed/game-text/rules";
import {
	LocalizationSelection,
	LocalizationLineId,
	TextCapabilityFilter,
	TextFilter,
	TextGroupBy,
	TextUnitId,
	TextWhere,
	TextQualityRule,
	TextTerminologyEntry
} from "@ue-shed/game-text/schema";
import { legacyFilter, type LegacyFilters } from "./game-text-filter-model.js";
import type { RuleEditorState } from "./game-text-rule-state.js";

const TranslationDraft = LocalizationEdit.mapFields((fields) => ({
	...fields,
	translation: Schema.String
}));

export const GameTextEditSession = Schema.Struct({
	staged: Schema.Array(
		Schema.Struct({
			target: LocalizationSelection.fields.target,
			edit: LocalizationEdit,
			source: Schema.String
		})
	),
	drafts: Schema.Array(
		Schema.Struct({
			target: LocalizationSelection.fields.target,
			edit: TranslationDraft,
			source: Schema.String
		})
	)
});
export type GameTextEditSession = Schema.Schema.Type<typeof GameTextEditSession>;

// Drafts validate their shape at storage boundaries while allowing incomplete authored fields.
const [Forbidden, Preferred] = TextTerminologyEntry.members;
const DraftTerm = Schema.Union([
	Forbidden.mapFields((fields) => ({ ...fields, term: Schema.String })),
	Preferred.mapFields((fields) => ({
		...fields,
		term: Schema.String,
		alternatives: Schema.Array(Schema.String)
	}))
]);
const [SourceBudget, SourceTerms] = TextQualityRule.members;
const DraftSourceRule = Schema.Union([
	SourceBudget.mapFields((fields) => ({
		...fields,
		recovery: Schema.String,
		maximumCharacters: Schema.Number
	})),
	SourceTerms.mapFields((fields) => ({
		...fields,
		recovery: Schema.String,
		terms: Schema.Array(DraftTerm)
	}))
]);
const [CultureBudget, CultureTerms] = LocalizationProjectRule.members;
const DraftLocalizationRule = Schema.Union([
	CultureBudget.mapFields((fields) => ({
		...fields,
		recovery: Schema.String,
		defaultMaximumCharacters: Schema.optionalKey(Schema.Number),
		cultures: Schema.Record(Schema.String, Schema.Number)
	})),
	CultureTerms.mapFields((fields) => ({
		...fields,
		recovery: Schema.String,
		cultures: Schema.Record(Schema.String, Schema.Array(DraftTerm))
	}))
]);
// The editor edits source and localization rules; the file's other entries pass through it whole.
const DraftDocument = GameTextRuleDocument.mapFields((fields) => ({
	...fields,
	rules: Schema.Array(
		Schema.Union([
			BuiltInCheckEntry,
			DraftSourceRule,
			DraftLocalizationRule,
			CustomLocalizationCheck
		])
	)
}));

/**
 * A stored field that no longer fits its schema is dropped alone, instead of discarding every
 * preference and draft stored with it.
 */
const lenient = <S extends Schema.Top>(field: S) =>
	field.pipe(Schema.catchDecoding(() => Effect.succeedNone));

/** Lenses stored before filter pills; decoded only to migrate the host's preferences. */
const LegacyReviewLens = Schema.Literals([
	"all",
	"shared",
	"duplicate_source",
	"long",
	"unresolved",
	"conflicting"
]);

const StoredPreferences = Schema.Struct({
	localizationTarget: lenient(Schema.optionalKey(LocalizationSelection.fields.target)),
	localizationCulture: lenient(LocalizationSelection.fields.culture),
	localizationCultures: lenient(LocalizationSelection.fields.cultures),
	localizationState: lenient(LocalizationSelection.fields.state),
	localizationReview: lenient(LocalizationSelection.fields.review),
	localizationKeyChanged: lenient(Schema.optionalKey(Schema.Boolean)),
	searchTranslations: lenient(Schema.optionalKey(Schema.Boolean)),
	selectedLocalizationId: lenient(Schema.optionalKey(LocalizationLineId)),
	query: lenient(Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512)))),
	capability: lenient(Schema.optionalKey(TextCapabilityFilter)),
	lens: lenient(Schema.optionalKey(LegacyReviewLens)),
	withoutNotes: lenient(Schema.optionalKey(Schema.Boolean)),
	where: lenient(Schema.optionalKey(TextWhere)),
	mode: lenient(Schema.optionalKey(Schema.Literals(["corpus", "quality", "reports", "compare"]))),
	qualityFilter: lenient(Schema.optionalKey(WorkspaceQualityFilter)),
	selectedId: lenient(Schema.optionalKey(TextUnitId)),
	selectedFindingId: lenient(Schema.optionalKey(TextQualityFindingId)),
	qualityDocument: lenient(Schema.optionalKey(GameTextRuleDocument)),
	editSession: lenient(Schema.optionalKey(GameTextEditSession)),
	qualityEditor: lenient(
		Schema.optionalKey(
			Schema.Struct({
				// Absent when the draft is the saved document, and the saved document when it is the
				// applied one: each distinct document is stored once.
				draft: Schema.optionalKey(DraftDocument),
				savedDocument: Schema.optionalKey(GameTextRuleDocument)
			})
		)
	),
	filter: lenient(Schema.optionalKey(TextFilter)),
	group: lenient(Schema.optionalKey(Schema.Literals([...TextGroupBy.literals, "none"])))
});

export interface GameTextPreferences {
	readonly localizationTarget?:
		| Schema.Schema.Type<typeof LocalizationSelection>["target"]
		| undefined;
	readonly localizationCulture?:
		| Schema.Schema.Type<typeof LocalizationSelection>["culture"]
		| undefined;
	/** Every picked culture; preferences saved before multi-select only have `localizationCulture`. */
	readonly localizationCultures?:
		| Schema.Schema.Type<typeof LocalizationSelection>["cultures"]
		| undefined;
	readonly localizationState?:
		| Schema.Schema.Type<typeof LocalizationSelection>["state"]
		| undefined;
	readonly localizationReview?:
		| Schema.Schema.Type<typeof LocalizationSelection>["review"]
		| undefined;
	readonly localizationKeyChanged?: boolean | undefined;
	readonly searchTranslations?: boolean | undefined;
	readonly selectedLocalizationId?: Schema.Schema.Type<typeof LocalizationLineId> | undefined;
	readonly query: string;
	readonly capability: Schema.Schema.Type<typeof TextCapabilityFilter>;
	/** A lens saved by an earlier Game Text; `migratePreferences` turns it into a pill. */
	readonly lens?: LegacyFilters["lens"];
	readonly withoutNotes?: boolean;
	readonly where?: Schema.Schema.Type<typeof TextWhere> | undefined;
	readonly mode?: "corpus" | "quality" | "reports" | "compare";
	readonly qualityFilter?: Schema.Schema.Type<typeof WorkspaceQualityFilter>;
	readonly selectedId: Schema.Schema.Type<typeof TextUnitId> | undefined;
	readonly selectedFindingId?: Schema.Schema.Type<typeof TextQualityFindingId> | undefined;
	readonly qualityDocument?: Schema.Schema.Type<typeof GameTextRuleDocument> | undefined;
	readonly qualityEditor?: RuleEditorState | undefined;
	readonly editSession?: GameTextEditSession | undefined;
	/** Filter pills. Absent in preferences saved before pills; see `migratePreferences`. */
	readonly filter?: TextFilter | undefined;
	/** How the list groups lines; `none` lists them flat. Problem when absent. */
	readonly group?: TextGroupBy | "none" | undefined;
}

/**
 * Preferences saved before filter pills keep their toggles, lenses and state chips as fields. They
 * become pills here once; what has no pill (changed files, gathered-only and other line states)
 * stays where it was. A lens saved beside pills becomes one more pill.
 */
export function migratePreferences(preferences: GameTextPreferences): GameTextPreferences {
	const { lens, ...rest } = preferences;
	if (rest.filter !== undefined)
		return { ...rest, filter: [...rest.filter, ...legacyFilter({ lens }).filter] };
	const { filter, remainingState } = legacyFilter(preferences);
	const files = preferences.where?.files;
	return {
		...rest,
		filter,
		capability: "all",
		withoutNotes: false,
		where: files === undefined ? undefined : { files },
		localizationState: remainingState,
		localizationKeyChanged: false
	};
}

/**
 * A preset's target, cultures and translation filters as the preference fields a restore reads. A
 * preset without them picks the first target and every culture, as before presets carried them.
 */
export function localizationPreferences(
	selection: Schema.Schema.Type<typeof LocalizationSelection> | undefined
) {
	return {
		localizationTarget: selection?.target,
		localizationCulture: selection?.culture,
		localizationCultures: selection?.cultures,
		localizationState: selection?.state,
		localizationReview: selection?.review,
		localizationKeyChanged: selection?.keyChanged ?? false,
		searchTranslations: selection?.searchTranslations ?? false
	} satisfies Partial<GameTextPreferences>;
}

type StoredPreferences = Schema.Schema.Type<typeof StoredPreferences>;
const decodeStoredPreferences = Schema.decodeUnknownOption(
	Schema.fromJsonString(StoredPreferences)
);

/** The view's settings and the work in progress are stored apart, so either can fail alone. */
const VIEW_PREFIX = "ue-shed:game-text:";
const WORK_PREFIX = "ue-shed:game-text-work:";
const VIEW_LIMIT = 1_048_576;
const WORK_LIMIT = 2_097_152;
/** Open translation drafts kept for recovery; the most recently opened win. */
const DRAFT_LIMIT = 100;

function decodeStored(contents: string, limit: number): StoredPreferences {
	const decoded = decodeStoredPreferences(contents.length <= limit ? contents : "{}");
	return Option.isSome(decoded) ? decoded.value : {};
}

/** The rule editor stores each distinct document once: draft and saved copies only differ when edited. */
function restoredEditor(value: StoredPreferences): RuleEditorState | undefined {
	const editor = value.qualityEditor;
	if (!editor) return undefined;
	const savedDocument = editor.savedDocument ?? value.qualityDocument;
	const draft = editor.draft ?? savedDocument;
	return draft === undefined ? undefined : { draft, savedDocument };
}

function preferencesFrom(value: StoredPreferences): GameTextPreferences {
	const { qualityEditor: _editor, ...rest } = value;
	const qualityEditor = restoredEditor(value);
	return migratePreferences({
		...rest,
		...(qualityEditor ? { qualityEditor } : undefined),
		query: value.query ?? "",
		capability: value.capability ?? "all",
		withoutNotes: value.withoutNotes ?? false,
		selectedId: value.selectedId
	});
}

/** One stored document, as written by versions that kept the view and its work together. */
export function decodeGameTextPreferences(contents: string): GameTextPreferences {
	return preferencesFrom(decodeStored(contents, VIEW_LIMIT + WORK_LIMIT));
}

/** The view and its work in progress as stored for one project. */
export function storedGameTextPreferences(key: string): GameTextPreferences {
	const view = decodeStored(window.localStorage.getItem(VIEW_PREFIX + key) ?? "{}", VIEW_LIMIT);
	const work = decodeStored(window.localStorage.getItem(WORK_PREFIX + key) ?? "{}", WORK_LIMIT);
	return preferencesFrom({ ...view, ...work });
}

export const readGameTextPreferences = Effect.fn("GameText.preferences.read")((key: string) =>
	Effect.try({
		try: () => storedGameTextPreferences(key),
		catch: () => undefined
	}).pipe(Effect.catch(() => Effect.succeed(decodeGameTextPreferences("{}"))))
);

function sameDocument(
	left: GameTextPreferences["qualityDocument"],
	right: GameTextPreferences["qualityDocument"]
) {
	return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/** Work in progress as stored: bounded drafts, and each rule document written once. */
function storedWork(preferences: GameTextPreferences) {
	const session = preferences.editSession;
	const editor = preferences.qualityEditor;
	const savedDocument =
		editor?.savedDocument === undefined ||
		sameDocument(editor.savedDocument, preferences.qualityDocument)
			? undefined
			: editor.savedDocument;
	const draft =
		editor === undefined ||
		sameDocument(editor.draft, editor.savedDocument ?? preferences.qualityDocument)
			? undefined
			: editor.draft;
	return {
		...(session && (session.staged.length > 0 || session.drafts.length > 0)
			? {
					editSession: {
						staged: session.staged,
						drafts: session.drafts.slice(-DRAFT_LIMIT)
					}
				}
			: undefined),
		...(editor
			? {
					qualityEditor: {
						...(draft ? { draft } : undefined),
						...(savedDocument ? { savedDocument } : undefined)
					}
				}
			: undefined)
	};
}

/**
 * `saved` when everything was written; `drafts_not_saved` when the view was written but the work
 * in progress was too large or could not be stored, in which case no older copy of it remains to
 * be recovered by mistake; `failed` when nothing could be written.
 */
export type PreferencesSaveResult = "saved" | "drafts_not_saved" | "failed";

/**
 * Writes synchronously, so a page that is hiding or a route being disposed keeps its last change.
 * Storage failures are results, never exceptions.
 */
export function writeGameTextPreferences(
	key: string,
	preferences: GameTextPreferences
): PreferencesSaveResult {
	try {
		const { editSession: _session, qualityEditor: _editor, ...view } = preferences;
		const viewContents = JSON.stringify(view);
		if (viewContents.length > VIEW_LIMIT) return "failed";
		window.localStorage.setItem(VIEW_PREFIX + key, viewContents);
	} catch {
		return "failed";
	}
	const work = storedWork(preferences);
	try {
		if (Object.keys(work).length === 0) {
			window.localStorage.removeItem(WORK_PREFIX + key);
			return "saved";
		}
		const workContents = JSON.stringify(work);
		if (workContents.length <= WORK_LIMIT) {
			window.localStorage.setItem(WORK_PREFIX + key, workContents);
			return "saved";
		}
	} catch {
		// Falls through: an older copy must not be recovered in place of this one.
	}
	try {
		window.localStorage.removeItem(WORK_PREFIX + key);
	} catch {
		return "failed";
	}
	return "drafts_not_saved";
}

export const saveGameTextPreferences = Effect.fn("GameText.preferences.save")(
	(key: string, preferences: GameTextPreferences) =>
		Effect.sync(() => writeGameTextPreferences(key, preferences))
);
