import { textCorpusDiagnosticSummary } from "./corpus-summary.js";
import type {
	CultureCode,
	LocalizationChangeSet,
	LocalizationIdentity,
	LocalizationTargetEvidence
} from "@ue-shed/localization/browser";
import { BuiltInCheckId } from "./localization-check-ids.js";
import {
	localizationCheckDefaults,
	localizationRuleId,
	type InconsistentTranslationParams
} from "./localization-check-catalogue.js";
import { localizationExpectedSource, localizationManifestNotes } from "./localization.js";
import { localizationLineUnits } from "./gathered-text.js";
import {
	DuplicateSources,
	duplicateOccurrencePlace,
	duplicateManifestPlace
} from "./duplicate-sources.js";
import {
	GameTextLocalizationError,
	type LocalizationJoin,
	type LocalizationLine,
	type LocalizationCultureState
} from "./localization-schema.js";
import {
	LocalizationQualityReport,
	type LocalizationQualityFinding,
	type LocalizationPolicyFinding,
	type LocalizationCustomFinding,
	type LocalizationCheckOptions,
	type LocalizationCheckDiagnostic
} from "./localization-quality-schema.js";
import { localizationEvidenceFileStatuses } from "./localization-status.js";
import type { TextQualityAffectedOccurrence } from "./quality-schema.js";
import {
	resolveLocalizationChecks,
	type GameTextRuleDocument,
	type ResolvedLocalizationChecks
} from "./game-text-rules.js";
import { matchesTextRole, prepareTextQualityRules, termMatches } from "./quality.js";
import type { TextRole } from "./quality-schema.js";
import { evaluateLocalizationPolicy } from "./localization-policy.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import { withoutAcceptedFindings } from "./localization-review.js";
import { localizationCheckInScope } from "./localization-check-scope.js";
import {
	customLocalizationChecks,
	localizationLineCustomFindings
} from "./localization-custom-checks.js";
export {
	localizationShippedTranslation,
	LocalizationShippedTranslation
} from "./localization-shipped-translation.js";
import type { TextCorpus, TextOccurrence, TextUnit } from "./schema.js";
import {
	compareRichTextTags,
	consistentTranslationCandidate,
	countOccurrences,
	formatBraceBalance,
	interiorLineBreaks,
	lengthOutlier,
	lengthOutlierMinimumRatio,
	normalizedLineEndings,
	numberOnlyText,
	placeholderMatchRanges,
	placeholderTranslation,
	richTextTagBalance,
	sharedSourceCandidate,
	sourceWhitespace,
	translationGroupKey,
	visibleTextLength,
	withoutOptionalArgumentTags
} from "./localization-text-shape.js";
import {
	parseUnrealFormatPattern,
	unrealRichTextCounts,
	unrealRichTextValid,
	unrealWhitespace,
	unrealUnsafeWhitespace,
	type UnrealFormatPattern,
	type UnrealModifierIdentity
} from "./unreal-text-syntax.js";

interface FindingBase {
	readonly lineId: LocalizationQualityFinding["lineId"];
	readonly target: LocalizationQualityFinding["target"];
	readonly culture: LocalizationQualityFinding["culture"];
	readonly identity: LocalizationIdentity;
	readonly affectedOccurrences: LocalizationQualityFinding["affectedOccurrences"];
	readonly manifestLocations: LocalizationQualityFinding["manifestLocations"];
	readonly translationOrigin: LocalizationQualityFinding["translationOrigin"];
	readonly sourceVariants?: readonly string[];
}
/** A finding before `add` sets its check's severity. */
type Unrated<F> = F extends unknown ? Omit<F, "severity"> : never;
type UnratedFinding = Unrated<LocalizationQualityFinding>;
type LocalizationChange = LocalizationChangeSet["changes"][number];
type DuplicateSourceActual = Extract<
	LocalizationQualityFinding,
	{ kind: "duplicate_source" }
>["actual"];

function argumentNames(pattern: UnrealFormatPattern): readonly string[] {
	return [...new Set(pattern.arguments.map((argument) => argument.name))].sort();
}

function modifiers(pattern: UnrealFormatPattern): readonly UnrealModifierIdentity[] {
	return pattern.modifiers
		.map((modifier) => ({ argument: modifier.argument, name: modifier.name }))
		.sort(
			(a, b) =>
				(a.argument ?? "").localeCompare(b.argument ?? "") || a.name.localeCompare(b.name)
		);
}

function renameArgument(
	text: string,
	from: string,
	to: string,
	culture: LocalizationCultureState["culture"]
): string | undefined {
	const parsed = parseUnrealFormatPattern(text, culture);
	if (parsed.compiled !== true) return undefined;
	const replacements = parsed.arguments
		.filter((argument) => argument.name === from && argument.start >= 0)
		.map((argument) => ({
			start: argument.start,
			end: argument.end,
			value: `{${to}}`
		}));
	for (const modifier of parsed.modifiers.filter(
		(item) => item.depth === 0 && item.name !== "hpp"
	)) {
		const forms = modifier.forms.map((form) => ({
			...form,
			renamed: renameArgument(form.value, from, to, culture)
		}));
		if (forms.some((form) => form.renamed === undefined)) return undefined;
		if (!forms.some((form) => form.renamed !== form.value)) continue;
		const values = forms.map(
			(form) =>
				`${modifier.name === "plural" || modifier.name === "ordinal" ? `${form.name}=` : ""}${JSON.stringify(form.renamed)}`
		);
		replacements.push({
			start: modifier.start,
			end: modifier.end,
			value: `|${modifier.name}(${values.join(",")})`
		});
	}
	let value = text;
	for (const replacement of [...replacements].sort((a, b) => b.start - a.start))
		value =
			value.slice(0, replacement.start) + replacement.value + value.slice(replacement.end);
	return value;
}

/** Built-in checks shared by every line of a target; prepared once per target. */
export interface LocalizationLineCheckContext {
	readonly target: LocalizationJoin["target"];
	/** Source-level findings belong to this culture when the line has it in the target. */
	readonly nativeCulture: LocalizationJoin["nativeCulture"];
	readonly options: LocalizationCheckOptions;
	readonly enabled: readonly BuiltInCheckId[];
	/** Shared sources by text; only sources with more than one identity are needed. */
	readonly duplicates: ReadonlyMap<string, DuplicateSourceActual>;
	/** Shipped translations of shared sources by source and culture; only those that differ. */
	readonly translations: ReadonlyMap<
		string,
		ReadonlyMap<CultureCode, LocalizationTranslationVariants>
	>;
	/** Each built-in check's settings under the rule file: severity and parameters. */
	readonly checks: ResolvedLocalizationChecks;
	/** The checks' tag and argument lists as sets, prepared once from `checks`. */
	readonly lists: LocalizationCheckLists;
	/** The rule file's roles by ID, for check scopes. */
	readonly roles: ReadonlyMap<string, TextRole>;
	/** The rule file's source terminology rules: each role and the terms it discourages. */
	readonly sourceTerminology: readonly SourceTerminology[];

	/**
	 * `localizationPropertiesWhereLocalizable` over the project: culture-invariant text is
	 * reported only in these properties.
	 */
	readonly localizableProperties: ReadonlySet<string>;
	/**
	 * Whether a saved occurrence of the line has translator notes, and the String Tables that
	 * declare its key, answered without its units; a scan whose units are costly to build passes
	 * them. Absent, the line's units answer. Units are built only for lines with findings.
	 */
	readonly occurrenceNotes?: ((line: LocalizationLine) => boolean) | undefined;
	readonly stringTables?: ((line: LocalizationLine) => readonly string[]) | undefined;
	/**
	 * Whether a line without an identity holds only culture-invariant text and some of it is
	 * `reportableInvariantText`, answered without its units; a scan whose units are costly to build
	 * passes it. Absent, the line's units answer.
	 */
	readonly cultureInvariant?: ((line: LocalizationLine) => boolean) | undefined;
}

/** The String Tables of a line's saved String Table entries, sorted. */
export function localizationStringTables(lineUnits: readonly TextUnit[]): string[] {
	const tables = new Set<string>();
	for (const unit of lineUnits)
		for (const occurrence of unit.occurrences)
			if (occurrence.location.kind === "string_table_entry")
				tables.add(occurrence.location.objectPath);
	return [...tables].sort(byCodeUnit);
}

/** Every saved occurrence of the line is culture invariant, and it has one. */
export function localizationCultureInvariantUnits(lineUnits: readonly TextUnit[]): boolean {
	let found = false;
	for (const unit of lineUnits)
		for (const occurrence of unit.occurrences) {
			if (
				occurrence.identity.status !== "unresolved" ||
				occurrence.identity.reason !== "culture_invariant"
			)
				return false;
			found = true;
		}
	return found;
}

/** Container indexes in a property path: `[3]`, map entries `{2}` and named entries `("Name")`. */
const PROPERTY_INDEX = /\[[^\]]*\]|\{[^}]*\}|\("[^"]*"\)/gu;

/**
 * The saved property a text sits in, the same for every instance: an asset property by its class
 * and property path, a DataTable cell by its table and column, container indexes removed.
 * Undefined for String Table entries.
 */
export function localizationPropertyKey(location: TextOccurrence["location"]): string | undefined {
	switch (location.kind) {
		case "asset_property":
			return `p\0${location.classPath}\0${location.propertyPath.replace(PROPERTY_INDEX, "")}`;
		case "data_table_cell":
			return `d\0${location.objectPath}\0${location.propertyPath.replace(PROPERTY_INDEX, "")}`;
		case "string_table_entry":
			return undefined;
	}
}

/**
 * Properties holding culture-invariant text (counted where `invariantTextPlace` holds) with at
 * least as much keyed and String Table text: the invariant text there is likely a slip. A property
 * mostly invariant, such as a credits column of names with a few localized headings, is invariant
 * on purpose.
 */
export function localizationPropertiesWhereLocalizable(
	invariant: ReadonlyMap<string, number>,
	localizable: ReadonlyMap<string, number>
): Set<string> {
	const keys = new Set<string>();
	for (const [key, count] of invariant) if ((localizable.get(key) ?? 0) >= count) keys.add(key);
	return keys;
}

/** The localizable properties of a corpus, for `localizableProperties`. */
export function localizationLocalizableProperties(
	units: Iterable<Pick<TextUnit, "occurrences">>
): Set<string> {
	const invariant = new Map<string, number>(),
		localizable = new Map<string, number>();
	for (const unit of units)
		for (const occurrence of unit.occurrences) {
			const identity = occurrence.identity;
			const counts =
				identity.status !== "unresolved"
					? localizable
					: identity.reason === "culture_invariant" && invariantTextPlace(occurrence)
						? invariant
						: undefined;
			const key = counts && localizationPropertyKey(occurrence.location);
			if (key !== undefined) counts!.set(key, (counts!.get(key) ?? 0) + 1);
		}
	return localizationPropertiesWhereLocalizable(invariant, localizable);
}

/** A package path with "debug" in a folder or asset name: debug menus, saves and test maps. */
const DEBUG_PACKAGE = /debug/iu;
/**
 * World-space text renders: labels on actors placed in levels, sequences and Blueprint templates,
 * mostly debug labels such as spawner names and waypoint distances.
 */
const TEXT_RENDER_CLASS = /\.TextRenderComponent$/u;

/**
 * A saved place where culture-invariant text could reach players by mistake: not editor text, not
 * in debug content, not a text render component, not a String Table entry.
 */
export function invariantTextPlace(
	occurrence: Pick<TextOccurrence, "audience" | "location">
): boolean {
	if (occurrence.audience === "editor") return false;
	const location = occurrence.location;
	if (location.kind === "string_table_entry") return false;
	const path = location.objectPath,
		dot = path.indexOf(".", path.lastIndexOf("/") + 1);
	if (DEBUG_PACKAGE.test(dot < 0 ? path : path.slice(0, dot))) return false;
	return !(location.kind === "asset_property" && TEXT_RENDER_CLASS.test(location.classPath));
}

/**
 * Whether culture-invariant text in this saved place is worth a finding: an `invariantTextPlace`
 * in a property that mostly holds localizable text elsewhere in the project.
 */
export function reportableInvariantText(
	occurrence: Pick<TextOccurrence, "audience" | "location">,
	localizableProperties: ReadonlySet<string>
): boolean {
	if (!invariantTextPlace(occurrence)) return false;
	const key = localizationPropertyKey(occurrence.location);
	return key !== undefined && localizableProperties.has(key);
}

const BYTECODE_MANIFEST_PATH = "[Script Bytecode]";

/**
 * Findings and supporting diagnostics for one checked localization line. Policy-dependent
 * findings remain separate from unread or unsupported evidence, which cannot establish a clean
 * result.
 */
export interface LocalizationLineCheckOutput {
	readonly findings: LocalizationQualityFinding[];
	readonly checkDiagnostics: LocalizationCheckDiagnostic[];
	readonly changes: LocalizationChange[];
}

/**
 * The culture a line's source-level findings (`missing_translator_notes`, `duplicate_source` and
 * the source checks) are reported under, once per line: the target's native culture when the line
 * has it in the target, otherwise the first of its cultures in the target by code.
 */
export function localizationSourceCulture(
	line: Pick<LocalizationLine, "cultures">,
	nativeCulture: LocalizationJoin["nativeCulture"]
): LocalizationCultureState["culture"] | undefined {
	let first: LocalizationCultureState["culture"] | undefined;
	for (const culture of line.cultures) {
		if (culture.state === "outside_target") continue;
		if (culture.culture === nativeCulture) return culture.culture;
		if (first === undefined || culture.culture.localeCompare(first) < 0)
			first = culture.culture;
	}
	return first;
}

/** A source terminology rule as `placeholder_text` reads it: where it applies and what it finds. */
interface SourceTerminology {
	readonly role: TextRole;
	readonly caseSensitive: boolean;
	/** Forbidden terms and the alternatives of preferred terms, as the source rule matches them. */
	readonly terms: readonly string[];
}

/** Optional tag (lower-cased) and argument names of the checks that take them, as sets. */
export interface LocalizationCheckLists {
	readonly formatArguments: ReadonlySet<string>;
	readonly renamedArguments: ReadonlySet<string>;
	readonly tagCaseArguments: ReadonlySet<string>;
	readonly richTextTags: {
		readonly tags: ReadonlySet<string>;
		readonly arguments: ReadonlySet<string>;
	};
	readonly richTextTagsAdded: {
		readonly tags: ReadonlySet<string>;
		readonly arguments: ReadonlySet<string>;
	};
}

function localizationCheckLists(checks: ResolvedLocalizationChecks): LocalizationCheckLists {
	// Equal lists share one set, so the tag comparison runs once when the checks agree.
	const sets = new Map<string, ReadonlySet<string>>();
	const set = (values: readonly string[]) => {
		const key = values.join("\0");
		let value = sets.get(key);
		if (!value) sets.set(key, (value = new Set(values)));
		return value;
	};
	const lower = (values: readonly string[]) => set(values.map((value) => value.toLowerCase()));
	return {
		formatArguments: set(checks.format_arguments.params.optionalArguments),
		renamedArguments: set(checks.format_argument_renamed.params.optionalArguments),
		tagCaseArguments: set(checks.rich_text_tag_case.params.optionalArguments),
		richTextTags: {
			tags: lower(checks.rich_text_tags.params.optionalTags),
			arguments: set(checks.rich_text_tags.params.optionalArguments)
		},
		richTextTagsAdded: {
			tags: lower(checks.rich_text_tags_added.params.optionalTags),
			arguments: set(checks.rich_text_tags_added.params.optionalArguments)
		}
	};
}

/** The rule file's settings the line checks read. */
export function localizationRuleContext(ruleDocument: GameTextRuleDocument | undefined) {
	const checks = resolveLocalizationChecks(ruleDocument);
	return {
		checks,
		lists: localizationCheckLists(checks),
		roles: new Map((ruleDocument?.roles ?? []).map((role) => [role.id, role])),
		sourceTerminology: (ruleDocument ? prepareTextQualityRules(ruleDocument) : []).flatMap(
			({ rule, role, terms }): SourceTerminology[] =>
				rule.kind === "terminology"
					? [
							{
								role,
								caseSensitive: rule.caseSensitive,
								terms: terms.map(({ term }) => term)
							}
						]
					: []
		)
	};
}

/**
 * The placeholders of `text` that the rule file's source terminology does not report, when it
 * reports some: a discouraged term overlapping the placeholder, in an occurrence of the line with
 * this text at a place of the term's role. That is the source rule's own finding, so a list that
 * shows both names each placeholder once. Units are read only when a term overlaps a placeholder.
 */
function unreportedPlaceholders(
	text: string,
	placeholders: ReadonlyArray<{
		readonly match: string;
		readonly start: number;
		readonly end: number;
	}>,
	terminology: readonly SourceTerminology[],
	units: () => readonly TextUnit[]
): string[] | undefined {
	const overlaps = (range: { readonly start: number; readonly end: number }) =>
		placeholders.some(({ start, end }) => range.start < end && start < range.end);
	const candidates = terminology.flatMap(({ role, caseSensitive, terms }) => {
		const ranges = terms
			.flatMap((term) => termMatches(text, term, caseSensitive))
			.filter(overlaps);
		return ranges.length ? [{ role, ranges }] : [];
	});
	if (candidates.length === 0) return undefined;
	const reported: Array<{ readonly start: number; readonly end: number }> = [];
	for (const { role, ranges } of candidates)
		if (
			units().some((unit) =>
				unit.occurrences.some(
					(occurrence) => occurrence.source === text && matchesTextRole(occurrence, role)
				)
			)
		)
			reported.push(...ranges);
	if (reported.length === 0) return undefined;
	return placeholders
		.filter(
			({ start, end }) => !reported.some((range) => range.start < end && start < range.end)
		)
		.map(({ match }) => match);
}

/** Rejects a selection outside the target and lists the built-in checks that run. */
export function enabledLocalizationChecks(
	join: Pick<LocalizationJoin, "target" | "cultures">,
	evidence: LocalizationTargetEvidence,
	options: LocalizationCheckOptions = {},
	ruleDocument?: GameTextRuleDocument
): readonly BuiltInCheckId[] {
	if (
		join.target !== evidence.target.name ||
		(options.culture !== undefined && !join.cultures.includes(options.culture))
	)
		throw new GameTextLocalizationError({
			retrySafe: false,
			nextStep: "fix_input",
			code: "invalid_selection",
			message: "The localization check selection is invalid.",
			recovery: "Choose a loaded target and one of its listed cultures."
		});
	const disabled = new Set(options.disabledChecks ?? []);
	const checks = resolveLocalizationChecks(ruleDocument);
	return BuiltInCheckId.literals.filter(
		(id) =>
			checks[id].enabled &&
			!disabled.has(id) &&
			(!options.checks || options.checks.includes(id))
	);
}

/** One key with several saved texts; the join's line source joins them for search. */
export function localizationConflictingSource(line: Pick<LocalizationLine, "cultures">): boolean {
	return line.cultures.some((culture) => culture.unknownReasons.includes("conflicting_source"));
}

/**
 * Lines with an identity, one source with letters and at least one culture in the target can
 * share a source. Number-only text and keys with conflicting sources are left out.
 */
export function localizationDuplicateCandidate(line: LocalizationLine): boolean {
	return (
		line.identity !== null &&
		line.source.trim().length > 0 &&
		sharedSourceCandidate(line.source) &&
		!line.cultures.every((culture) => culture.state === "outside_target") &&
		!localizationConflictingSource(line)
	);
}

/**
 * Groups candidate lines by source. Identities are sorted; the first five are kept, and the first
 * line carries the group's one finding. Identities that compare equal keep their lines' join order:
 * the order they are added in, unless the caller adds them in another order and passes each line's
 * position in the join. `rows` are the callers' row numbers of every line in a shared group, in
 * ascending order with each row's source in `rowSources`, for a second pass over just those lines.
 */
export function localizationDuplicateSources() {
	// Identity, join position and row, in turn; no object per line.
	const groups = new Map<string, Array<LocalizationIdentity | number>>();
	const places = new Map<number, () => readonly string[]>();
	let added = 0;
	return {
		add(
			source: string,
			identity: LocalizationIdentity,
			joinPosition = added,
			row = -1,
			locations?: () => readonly string[]
		) {
			if (locations) places.set(joinPosition, locations);
			added++;
			const group = groups.get(source);
			if (group) group.push(identity, joinPosition, row);
			else groups.set(source, [identity, joinPosition, row]);
		},
		finish() {
			const shared = new Map<string, DuplicateSourceActual>();
			const rows: Array<{ row: number; source: string }> = [];
			for (const [source, group] of groups) {
				if (group.length < 6) continue;
				// SAFETY: `add` is the only writer and pushes an identity, its position and row.
				// Verified by: localization-checks.test.ts — shared-source groups preserve identity ordering and finding ownership.
				let identities = Array.from({ length: group.length / 3 }, (_, index) => ({
					identity: group[index * 3] as LocalizationIdentity,
					position: group[index * 3 + 1] as number,
					row: group[index * 3 + 2] as number
				})).sort(
					(a, b) =>
						a.identity.namespace.localeCompare(b.identity.namespace) ||
						a.identity.key.localeCompare(b.identity.key) ||
						a.position - b.position
				);
				const counterparts = new DuplicateSources<string, string, string>();
				const located = identities.map((entry) => {
					const identity = JSON.stringify([entry.identity.namespace, entry.identity.key]);
					const known = places.get(entry.position)?.() ?? [];
					// Without a precise place, retain the existing distinct-key behavior.
					const sites = known.length ? known : [`unknown:${identity}`];
					for (const place of sites) counterparts.add(source, identity, place);
					return { entry, identity, sites };
				});
				identities = located
					.filter(({ identity, sites }) =>
						sites.some((place) => counterparts.hasOther(source, identity, place))
					)
					.map(({ entry }) => entry);
				if (identities.length < 2) continue;
				shared.set(source, {
					source,
					identityCount: identities.length,
					identities: identities.slice(0, 5).map(({ identity }) => identity)
				});
				for (const { row } of identities) if (row >= 0) rows.push({ row, source });
			}
			groups.clear();
			rows.sort((a, b) => a.row - b.row);
			return {
				shared,
				rows: rows.map(({ row }) => row),
				rowSources: rows.map(({ source }) => source)
			};
		}
	};
}

/** Saved places take precedence over the manifest's historical coordinates. */
export function localizationDuplicatePlaces(
	line: Pick<LocalizationLine, "manifest">,
	occurrences: readonly TextOccurrence[]
): readonly string[] {
	if (occurrences.length) return occurrences.map(duplicateOccurrencePlace);
	return line.manifest.flatMap((entry) => {
		const place = duplicateManifestPlace(entry.path);
		return place === undefined ? [] : [place];
	});
}

/** One shared source's shipped translations in one culture, with one most used translation. */
export interface LocalizationTranslationVariants {
	/**
	 * Distinct translations and how many lines ship each, most used first, then by text.
	 * Translations with the same `translationGroupKey` count as one, shown in the spelling that
	 * sorts first.
	 */
	readonly variants: ReadonlyArray<{ readonly translation: string; readonly lines: number }>;
	/** The `translationGroupKey` of the most used translation. */
	readonly majority: string;
	/** The most used translation is the source text: those lines are the ones to fix. */
	readonly majorityUntranslated: boolean;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Counts each shared source's shipped translations per culture, for `inconsistent_translation`.
 * Only lines in `shared` groups with a source worth comparing are counted, and not in the native
 * culture, so memory follows the distinct translations of shared lines, not the target. Counts do
 * not depend on the order lines are added in. `finish` keeps the cultures with more than one
 * translation and one most used.
 */
export function localizationTranslationVariants(
	shared: ReadonlyMap<string, DuplicateSourceActual>,
	nativeCulture: CultureCode | null,
	params: InconsistentTranslationParams = localizationCheckDefaults.inconsistent_translation
) {
	/** Per source and culture: lines and first spelling by group key. */
	const groups = new Map<
		string,
		Map<CultureCode, Map<string, { lines: number; translation: string }>>
	>();
	/** One culture's non-empty shipped translation of a candidate line. */
	const count = (source: string, culture: CultureCode, translation: string) => {
		if (culture === nativeCulture || translation.trim().length === 0) return;
		let cultures = groups.get(source);
		if (!cultures) groups.set(source, (cultures = new Map()));
		let counts = cultures.get(culture);
		if (!counts) cultures.set(culture, (counts = new Map()));
		const key = translationGroupKey(translation),
			group = counts.get(key);
		if (!group) counts.set(key, { lines: 1, translation });
		else {
			group.lines++;
			if (translation < group.translation) group.translation = translation;
		}
	};
	return {
		/** A hydrated line: counted when it is a candidate, for each culture in the target. */
		add(line: LocalizationLine) {
			if (!localizationTranslationCandidate(line, shared, params)) return;
			for (const culture of line.cultures) {
				if (culture.state === "outside_target") continue;
				const translation = localizationShippedTranslation(culture).value;
				if (translation) count(line.source, culture.culture, translation);
			}
		},
		/**
		 * One culture of a line the caller read from columns: a line of a shared group whose source
		 * passes `consistentTranslationCandidate`, in a culture inside the target.
		 */
		addTranslation(source: string, culture: CultureCode, translation: string) {
			count(source, culture, translation);
		},
		finish(): ReadonlyMap<string, ReadonlyMap<CultureCode, LocalizationTranslationVariants>> {
			const result = new Map<string, Map<CultureCode, LocalizationTranslationVariants>>();
			for (const [source, cultures] of groups) {
				const sourceKey = translationGroupKey(source);
				for (const [culture, counts] of cultures) {
					if (counts.size < 2) continue;
					const variants = Array.from(counts, ([key, group]) => ({ key, ...group })).sort(
						(a, b) => b.lines - a.lines || byCodeUnit(a.translation, b.translation)
					);
					// A tie names no usual translation to compare with.
					if (variants[0]!.lines === variants[1]!.lines) continue;
					const majorityUntranslated = variants[0]!.key === sourceKey;
					// Most lines ship the source and under half as many translate it: the culture keeps
					// this text untranslated on purpose, as internal labels and names often are.
					if (majorityUntranslated) {
						let translated = 0;
						for (let index = 1; index < variants.length; index++)
							translated += variants[index]!.lines;
						if (translated * 2 < variants[0]!.lines) continue;
					}
					let byCulture = result.get(source);
					if (!byCulture) result.set(source, (byCulture = new Map()));
					byCulture.set(culture, {
						variants: variants.map(({ translation, lines }) => ({
							translation,
							lines
						})),
						majority: variants[0]!.key,
						majorityUntranslated
					});
				}
			}
			groups.clear();
			return result;
		}
	};
}

/** A line whose translations `inconsistent_translation` compares with its shared source's. */
function localizationTranslationCandidate(
	line: LocalizationLine,
	shared: ReadonlyMap<string, DuplicateSourceActual>,
	params: InconsistentTranslationParams
): boolean {
	return (
		(shared.get(line.source)?.identityCount ?? 0) > 1 &&
		localizationDuplicateCandidate(line) &&
		consistentTranslationCandidate(line.source, params)
	);
}

/** Built-in finding order: line, culture, check, then the observed value. */
export function compareLocalizationFindings(
	a: LocalizationQualityFinding,
	b: LocalizationQualityFinding
) {
	return (
		a.lineId.localeCompare(b.lineId) ||
		a.culture.localeCompare(b.culture) ||
		a.kind.localeCompare(b.kind) ||
		JSON.stringify(a.actual).localeCompare(JSON.stringify(b.actual))
	);
}

/** Report order once policy findings join the built-ins. */
export function compareReportedLocalizationFindings(
	a: LocalizationQualityFinding | LocalizationPolicyFinding | LocalizationCustomFinding,
	b: LocalizationQualityFinding | LocalizationPolicyFinding | LocalizationCustomFinding
) {
	return (
		a.lineId.localeCompare(b.lineId) ||
		a.culture.localeCompare(b.culture) ||
		a.kind.localeCompare(b.kind) ||
		a.ruleId.localeCompare(b.ruleId) ||
		JSON.stringify(a.actual).localeCompare(JSON.stringify(b.actual))
	);
}

/** Argument names in order of first appearance. */
function argumentOrder(pattern: UnrealFormatPattern): readonly string[] {
	return [...new Set(pattern.arguments.map((argument) => argument.name))];
}

/**
 * A line's distinct saved sources when they conflict, sorted: the texts its authored occurrences
 * (String Table references aside, as in the join) carry. Undefined unless there are several.
 */
function conflictingSourceVariants(
	line: LocalizationLine,
	lineUnits: readonly TextUnit[]
): readonly string[] | undefined {
	if (!localizationConflictingSource(line)) return undefined;
	const authored = lineUnits.filter((unit) => unit.identity.status !== "string_table");
	const sources = new Set<string>();
	for (const unit of authored.length ? authored : lineUnits)
		for (const occurrence of unit.occurrences) sources.add(occurrence.source);
	return sources.size > 1 ? [...sources].sort(byCodeUnit) : undefined;
}

const ruleIdOf = localizationRuleId;
const sameIdentity = (a: LocalizationIdentity | undefined, b: LocalizationIdentity) =>
	a !== undefined && a.namespace === b.namespace && a.key === b.key;
const affectedOf = (lineUnits: readonly TextUnit[]): TextQualityAffectedOccurrence[] =>
	lineUnits
		.flatMap((unit) =>
			unit.occurrences.map((occurrence) => ({
				id: occurrence.id,
				packageFile: occurrence.packageFile,
				location: occurrence.location
			}))
		)
		.sort((a, b) => a.id.localeCompare(b.id));

/** Source checks of one text: the line's source, or each of its conflicting sources. */
function sourceTextFindings(
	text: string,
	base: FindingBase,
	line: {
		readonly gathered: boolean;
		readonly bytecode: boolean;
		readonly terminology: readonly SourceTerminology[];
		readonly units: () => readonly TextUnit[];
		readonly checks: ResolvedLocalizationChecks;
	},
	add: (finding: UnratedFinding) => void
) {
	const placeholders = placeholderMatchRanges(text, line.checks.placeholder_text.params);
	if (placeholders.length) {
		const unreported = unreportedPlaceholders(text, placeholders, line.terminology, line.units);
		add({
			...base,
			ruleId: ruleIdOf("placeholder_text"),
			kind: "placeholder_text",
			actual: { source: text, matches: placeholders.map(({ match }) => match) },
			expectation: { finalText: true },
			...(unreported ? { unreportedMatches: unreported } : undefined),
			recovery:
				"Replace the placeholder with final text, or keep the line out of the build until it has some."
		});
	}
	// Bytecode fragments keep the spaces they are joined with; text the gather skips is not sent.
	const space = line.gathered && !line.bytecode ? sourceWhitespace(text) : undefined;
	if (space && (space.leading || space.trailing || space.repeatedSpaces))
		add({
			...base,
			ruleId: ruleIdOf("source_whitespace"),
			kind: "source_whitespace",
			actual: { source: text, ...space },
			expectation: { trimmed: true },
			recovery:
				"Remove spaces and line breaks at the ends and doubled spaces; build spacing into the format pattern instead of joining text."
		});
	if (line.bytecode) return;
	const { xmlClosings, ...richText } = richTextTagBalance(text),
		braces = formatBraceBalance(text);
	if (
		richText.opening !== richText.closing ||
		braces.opening !== braces.closing ||
		xmlClosings.length
	)
		add({
			...base,
			ruleId: ruleIdOf("source_markup"),
			kind: "source_markup",
			actual: {
				source: text,
				richText,
				braces,
				...(xmlClosings.length ? { xmlClosings: [...new Set(xmlClosings)] } : undefined)
			},
			expectation: { balanced: true },
			recovery: xmlClosings.length
				? "Close rich-text tags with </>; Unreal shows a closing such as </Name> as text."
				: "Close each rich-text tag with </> and pair each { with }; escape a literal brace with a backtick."
		});
	if (numberOnlyText(text))
		add({
			...base,
			ruleId: ruleIdOf("number_only_text"),
			kind: "number_only_text",
			actual: { source: text },
			expectation: { cultureInvariant: true },
			recovery:
				"Make number-only text culture invariant, or format the number with FText::AsNumber, so translators are not sent it."
		});
}

/** One line's built-in findings, check diagnostics and suggested changes, in check order. */
export function checkLocalizationLine(
	line: LocalizationLine,
	units: () => readonly TextUnit[],
	context: LocalizationLineCheckContext,
	{ findings, checkDiagnostics, changes }: LocalizationLineCheckOutput
): void {
	const { target, options, enabled } = context;
	const cultures = [...line.cultures].sort((a, b) => a.culture.localeCompare(b.culture));
	for (const culture of cultures) {
		if (
			(options.culture && culture.culture !== options.culture) ||
			culture.state === "outside_target"
		)
			continue;
		for (const code of culture.unknownReasons)
			checkDiagnostics.push({ lineId: line.id, culture: culture.culture, code });
		if (culture.reducedSourceChecking)
			checkDiagnostics.push({
				lineId: line.id,
				culture: culture.culture,
				code: "reduced_source_checking"
			});
	}
	// A line's units are built when a finding needs them: a key saved in thousands of places,
	// such as an editor label, takes seconds to build and usually has no finding.
	let lineUnits: readonly TextUnit[] | undefined,
		affected: TextQualityAffectedOccurrence[] | undefined;
	const unitsOnce = () => (lineUnits ??= units());
	const savedPlaces = () => unitsOnce().flatMap((unit) => unit.occurrences);
	/**
	 * Whether a check runs and its scope holds for this line in `culture`. Scope is asked after a
	 * check has something to report, so a line's units are built only for a scoped finding.
	 */
	const active = (id: BuiltInCheckId, culture: CultureCode) =>
		enabled.includes(id) &&
		localizationCheckInScope(context.checks[id].scope, culture, savedPlaces, context.roles);
	const add = (finding: UnratedFinding) => {
		if (!active(finding.kind, finding.culture)) return false;
		// SAFETY: `finding` is one member of the union without its severity, and the severity
		// added is the one the rule file gives that member's kind.
		// Verified by: localization-check-settings.test.ts — applies enabled, preset, severity and parameters.
		findings.push({
			...finding,
			affectedOccurrences: (affected ??= affectedOf(unitsOnce())),
			severity: context.checks[finding.kind].severity
		} as LocalizationQualityFinding);
		return true;
	};
	const sourceCulture = localizationSourceCulture(line, context.nativeCulture);
	if (!line.identity) {
		if (
			sourceCulture === undefined ||
			(options.culture && options.culture !== sourceCulture) ||
			!enabled.includes("culture_invariant_text") ||
			!sharedSourceCandidate(line.source)
		)
			return;
		// Most lines without a key are not culture invariant; a scan can say so without units.
		if (context.cultureInvariant && !context.cultureInvariant(line)) return;
		const invariantUnits = unitsOnce();
		if (
			localizationCultureInvariantUnits(invariantUnits) &&
			invariantUnits.some((unit) =>
				unit.occurrences.some((occurrence) =>
					reportableInvariantText(occurrence, context.localizableProperties)
				)
			)
		)
			add({
				lineId: line.id,
				target,
				culture: sourceCulture,
				identity: null,
				affectedOccurrences: [],
				manifestLocations: [],
				translationOrigin: "absent",
				ruleId: ruleIdOf("culture_invariant_text"),
				kind: "culture_invariant_text",
				actual: { source: line.source },
				expectation: { localizable: true },
				recovery:
					"Make the text localizable (clear Culture Invariant, or use NSLOCTEXT/LOCTEXT or a String Table) so the gather collects it; keep it invariant only if players never see it."
			});
		return;
	}
	const manifestSource = line.manifest[0]?.source.Text;
	const source = manifestSource ?? line.source;
	// A partly read package can leave the saved text blank; the manifest's source still counts.
	if (source.trim().length === 0 && line.source.trim().length === 0) return;
	const sourceVariants = localizationConflictingSource(line)
		? conflictingSourceVariants(line, unitsOnce())
		: undefined;
	// Conflicting texts without a manifest leave no one source to compare a translation with.
	const comparable = sourceVariants === undefined || manifestSource !== undefined;
	const manifestLocations = [...new Set(line.manifest.map((entry) => entry.path))].sort();
	const candidate = localizationDuplicateCandidate(line);
	// Blueprint text compiled into script bytecode: the gather records each concatenated fragment,
	// with its spaces, and no saved place.
	const bytecode =
		line.manifest.length > 0 &&
		line.manifest.every((entry) => entry.path.endsWith(BYTECODE_MANIFEST_PATH));
	const sourceChecks = {
		gathered: line.manifest.length > 0,
		bytecode,
		terminology: enabled.includes("placeholder_text") ? context.sourceTerminology : [],
		units: unitsOnce,
		checks: context.checks
	};
	/** The source's visible length, measured once for every culture. */
	let sourceLength: number | undefined;
	for (const culture of cultures) {
		if (
			(options.culture && culture.culture !== options.culture) ||
			culture.state === "outside_target"
		)
			continue;
		const shipped = localizationShippedTranslation(culture);
		const base: FindingBase = {
			lineId: line.id,
			target,
			culture: culture.culture,
			identity: line.identity,
			// `add` fills in the saved places.
			affectedOccurrences: [],
			manifestLocations,
			translationOrigin: shipped.origin,
			...(sourceVariants ? { sourceVariants } : undefined)
		};
		const emptyPO = culture.po?.msgstr["0"] === "";
		const emptyArchive = culture.archive?.translation.Text === "";
		if (emptyPO || emptyArchive)
			add({
				...base,
				translationOrigin: emptyPO ? "po" : "archive",
				ruleId: ruleIdOf("empty_translation"),
				kind: "empty_translation",
				actual: { entryExists: true, translation: "" },
				expectation: { nonEmptyTranslation: true },
				recovery:
					"Provide a non-empty translation in the culture's PO entry, then import and compile with Unreal."
			});
		// Source-level checks report once per line, under the line's source culture.
		if (culture.culture === sourceCulture) {
			if (
				enabled.includes("missing_translator_notes") &&
				line.manifest.every((entry) => localizationManifestNotes(entry).length === 0) &&
				!(context.occurrenceNotes
					? context.occurrenceNotes(line)
					: unitsOnce().some((unit) =>
							unit.occurrences.some(
								(occurrence) => occurrence.devNotes.trim().length > 0
							)
						))
			)
				add({
					...base,
					ruleId: ruleIdOf("missing_translator_notes"),
					kind: "missing_translator_notes",
					actual: { noteCount: 0 },
					expectation: { minimumNotes: 1 },
					recovery:
						"Add translator context to a source occurrence or manifest-producing source."
				});
			// One finding per shared text, on the line whose identity sorts first.
			const duplicates = candidate ? context.duplicates.get(line.source) : undefined;
			if (
				duplicates &&
				duplicates.identityCount > 1 &&
				sameIdentity(duplicates.identities[0], line.identity)
			)
				add({
					...base,
					ruleId: ruleIdOf("duplicate_source"),
					kind: "duplicate_source",
					actual: duplicates,
					expectation: { reviewDistinctKeys: true },
					recovery:
						"Review whether these distinct identities need different context or should share a key. Equal text never links translations."
				});
			for (const text of sourceVariants ?? [line.source.trim() ? line.source : source])
				sourceTextFindings(text, base, sourceChecks, add);
			const tables = !enabled.includes("string_table_key_collision")
				? []
				: context.stringTables
					? context.stringTables(line)
					: localizationStringTables(unitsOnce());
			if (tables.length > 1)
				add({
					...base,
					ruleId: ruleIdOf("string_table_key_collision"),
					kind: "string_table_key_collision",
					actual: {
						tables: tables.slice(0, 16),
						tableCount: tables.length
					},
					expectation: { oneTablePerKey: true },
					recovery:
						"Give each String Table its own namespace or rename the key; Unreal keeps one entry per namespace and key."
				});
		}
		if (!line.manifest.length)
			checkDiagnostics.push({
				lineId: line.id,
				culture: culture.culture,
				code: "source_unavailable"
			});
		if (!comparable) {
			if (shipped.value === null)
				checkDiagnostics.push({
					lineId: line.id,
					culture: culture.culture,
					code: "translation_unavailable"
				});
			continue;
		}
		const sourcePattern = parseUnrealFormatPattern(source, culture.culture);
		const sourceModifiers = modifiers(sourcePattern);
		const patternIssues = (pattern: UnrealFormatPattern) => {
			for (const issue of pattern.issues)
				if (issue.code === "unsupported_culture" || issue.code === "syntax_limit")
					checkDiagnostics.push({
						lineId: line.id,
						culture: culture.culture,
						code: issue.code
					});
			return pattern.issues.filter(
				(issue) => issue.code !== "unsupported_culture" && issue.code !== "syntax_limit"
			);
		};
		const sourceIssues = patternIssues(sourcePattern);
		if (sourceIssues.length)
			add({
				...base,
				ruleId: ruleIdOf("argument_modifiers"),
				kind: "argument_modifiers",
				actual: { side: "source", issues: sourceIssues, modifiers: sourceModifiers },
				expectation: { modifiers: sourceModifiers },
				recovery:
					"Repair the source's modifier syntax and culture-required forms before translating it."
			});
		if (shipped.value === null) {
			checkDiagnostics.push({
				lineId: line.id,
				culture: culture.culture,
				code: "translation_unavailable"
			});
			continue;
		}
		const translation = shipped.value;
		// Shape checks compare text; an empty translation is `empty_translation`'s finding alone.
		const translated = translation.trim().length > 0;
		if (
			translated &&
			manifestSource !== undefined &&
			shipped.origin === "archive" &&
			culture.archive &&
			culture.culture !== context.nativeCulture &&
			culture.facts.includes("needs_update")
		) {
			const translatedSource = culture.archive.source.Text;
			const expectedSource = localizationExpectedSource(
				line.manifest[0]!.source,
				culture.culture,
				context.nativeCulture,
				line.cultures.find((mark) => mark.culture === context.nativeCulture)?.archive
			).Text;
			if (
				translatedSource !== expectedSource &&
				normalizedLineEndings(translatedSource) === normalizedLineEndings(expectedSource)
			)
				add({
					...base,
					ruleId: ruleIdOf("source_line_endings_changed"),
					kind: "source_line_endings_changed",
					actual: { translatedSource },
					expectation: { source: expectedSource },
					recovery:
						"Save the source with the line endings it was translated with, or re-import the translation against the current source."
				});
			else
				add({
					...base,
					ruleId: ruleIdOf("outdated_translation"),
					kind: "outdated_translation",
					actual: { translatedSource },
					expectation: { source: expectedSource },
					recovery:
						"Translate the current source text and import it; Unreal ships the source instead of a translation made for older text."
				});
		}
		const escapeMatches = [...translation.matchAll(/\\[nrt]/gu)];
		if (escapeMatches.length)
			add({
				...base,
				ruleId: ruleIdOf("po_escape_safety"),
				kind: "po_escape_safety",
				actual: {
					positions: escapeMatches.map((match) => match.index),
					sequences: escapeMatches.map((match) => match[0])
				},
				expectation: { roundTripSafe: true },
				recovery:
					"Replace literal backslash control sequences with actual control characters or reword them before Unreal's PO round trip."
			});
		const expectedSpace = unrealWhitespace(source);
		const actualSpace = unrealWhitespace(translation);
		if (
			expectedSpace.leading !== actualSpace.leading ||
			expectedSpace.trailing !== actualSpace.trailing ||
			unrealUnsafeWhitespace(translation)
		)
			add({
				...base,
				ruleId: ruleIdOf("whitespace"),
				kind: "whitespace",
				actual: actualSpace,
				expectation: expectedSpace,
				recovery:
					"Preserve the source's intentional boundary whitespace; remove unsafe boundary spaces or tabs."
			});
		const expectedBreaks = translated ? interiorLineBreaks(source) : 0,
			actualBreaks = translated ? interiorLineBreaks(translation) : 0;
		if (expectedBreaks !== actualBreaks)
			add({
				...base,
				ruleId: ruleIdOf("line_breaks"),
				kind: "line_breaks",
				actual: { lineBreaks: actualBreaks },
				expectation: { lineBreaks: expectedBreaks },
				recovery:
					"Use as many line breaks as the source, so the text keeps its layout in the same space."
			});
		if (!unrealRichTextValid(source, translation))
			add({
				...base,
				ruleId: ruleIdOf("rich_text"),
				kind: "rich_text",
				actual: unrealRichTextCounts(translation),
				expectation: unrealRichTextCounts(source),
				recovery:
					"Balance opening rich-text tags with </>, retaining intentional source imbalance."
			});
		// Each tag check leaves out its own optional arguments; equal lists compare once.
		const tagComparisons = new Map<
			ReadonlySet<string>,
			ReturnType<typeof compareRichTextTags>
		>();
		const tagsWithout = (optional: ReadonlySet<string>) => {
			if (!translated) return undefined;
			if (!tagComparisons.has(optional))
				tagComparisons.set(
					optional,
					compareRichTextTags(
						withoutOptionalArgumentTags(source, optional),
						withoutOptionalArgumentTags(translation, optional)
					)
				);
			return tagComparisons.get(optional);
		};
		const { richTextTags, richTextTagsAdded } = context.lists;
		const tags = tagsWithout(richTextTags.arguments);
		const required = (name: string) => !richTextTags.tags.has(name.toLowerCase());
		const missingTags = tags?.missing.filter(required) ?? [],
			addedTags = tags?.added.filter(required) ?? [];
		const addedOnly = tagsWithout(richTextTagsAdded.arguments);
		let reportedTagAdditions: readonly string[] = [];
		if (tags && missingTags.length)
			if (
				add({
					...base,
					ruleId: ruleIdOf("rich_text_tags"),
					kind: "rich_text_tags",
					actual: { tags: tags.translationTags, missing: missingTags, added: addedTags },
					expectation: { tags: tags.sourceTags },
					recovery:
						"Keep the source's rich-text tags, such as <b>…</> and <img/>, around the matching words; don't add or drop any."
				})
			)
				reportedTagAdditions = addedTags;
		const reportedTags = new Set(reportedTagAdditions.map((name) => name.toLowerCase()));
		const addedOnlyTags =
			addedOnly?.added.filter(
				(name) =>
					!richTextTagsAdded.tags.has(name.toLowerCase()) &&
					!reportedTags.has(name.toLowerCase())
			) ?? [];
		if (addedOnly && addedOnlyTags.length)
			add({
				...base,
				ruleId: ruleIdOf("rich_text_tags_added"),
				kind: "rich_text_tags_added",
				actual: { tags: addedOnly.translationTags, added: addedOnlyTags },
				expectation: { tags: addedOnly.sourceTags },
				recovery:
					"Style the same words as the source; list a tag a culture may add in the rule file's optionalTags."
			});
		const caseTags = tagsWithout(context.lists.tagCaseArguments);
		if (caseTags?.changed.length)
			add({
				...base,
				ruleId: ruleIdOf("rich_text_tag_case"),
				kind: "rich_text_tag_case",
				actual: { changed: caseTags.changed },
				expectation: { sameCase: true },
				recovery: "Spell rich-text tag names exactly as the source does."
			});
		const translationPattern = parseUnrealFormatPattern(translation, culture.culture);
		const expectedArgs = argumentNames(sourcePattern);
		const actualArgs = argumentNames(translationPattern);
		const canComparePattern =
			sourcePattern.compiled !== null && translationPattern.compiled !== null;
		const missing = translated
			? argumentOrder(sourcePattern).filter((name) => !actualArgs.includes(name))
			: [];
		// The game always supplies an optional argument, so a translation may add it. Each check
		// leaves out its own optional arguments.
		const addedArguments = (optional: ReadonlySet<string>) =>
			argumentOrder(translationPattern).filter(
				(name) => !expectedArgs.includes(name) && !optional.has(name)
			);
		const added = addedArguments(context.lists.renamedArguments);
		// A dropped and an added name pair up, in order of appearance, as a rename.
		const pairs =
			missing.length && added.length && active("format_argument_renamed", culture.culture)
				? Math.min(missing.length, added.length)
				: 0;
		let reportedPairs = 0;
		if (canComparePattern && pairs > 0) {
			const finding: Unrated<
				Extract<LocalizationQualityFinding, { kind: "format_argument_renamed" }>
			> = {
				...base,
				ruleId: ruleIdOf("format_argument_renamed"),
				kind: "format_argument_renamed",
				actual: {
					arguments: actualArgs,
					renamed: Array.from({ length: pairs }, (_, index) => ({
						from: added[index]!,
						to: missing[index]!
					}))
				},
				expectation: { arguments: expectedArgs },
				recovery:
					"Use the source's argument names unchanged; translate the words around {arguments}, never the names inside them."
			};
			const from = added[0];
			const to = missing[0];
			if (
				enabled.includes("format_argument_renamed") &&
				line.manifest.length > 0 &&
				!culture.unknownReasons.some(
					(reason) =>
						reason === "duplicate_manifest_identity" ||
						reason === "duplicate_archive_identity" ||
						reason === "duplicate_po_identity"
				) &&
				missing.length === 1 &&
				added.length === 1 &&
				from !== undefined &&
				to !== undefined
			) {
				const replacement = renameArgument(translation, from, to, culture.culture);
				if (
					replacement !== undefined &&
					JSON.stringify(
						argumentNames(parseUnrealFormatPattern(replacement, culture.culture))
					) === JSON.stringify(expectedArgs)
				) {
					const change = {
						target,
						culture: culture.culture,
						...line.identity,
						source,
						previousTranslation:
							culture.po?.msgstr["0"] ?? culture.archive?.translation.Text ?? null,
						translation: replacement
					};
					Object.assign(finding, { suggestedChange: change });
					changes.push(change);
				}
			}
			if (add(finding)) reportedPairs = pairs;
		}
		const renamedFrom = new Set(added.slice(0, reportedPairs));
		const dropped = missing.slice(reportedPairs).sort(),
			extra = addedArguments(context.lists.formatArguments)
				.filter((name) => !renamedFrom.has(name))
				.sort();
		if (canComparePattern && (dropped.length || extra.length))
			add({
				...base,
				ruleId: ruleIdOf("format_arguments"),
				kind: "format_arguments",
				actual: { arguments: actualArgs, missing: dropped, added: extra },
				expectation: { arguments: expectedArgs },
				recovery:
					"Keep the source's case-sensitive format argument names in the translation, including arguments inside modifier forms."
			});
		const translationModifiers = modifiers(translationPattern);
		const actionable = patternIssues(translationPattern);
		if (
			translated &&
			(actionable.length ||
				(canComparePattern &&
					JSON.stringify(sourceModifiers) !== JSON.stringify(translationModifiers)))
		)
			add({
				...base,
				ruleId: ruleIdOf("argument_modifiers"),
				kind: "argument_modifiers",
				actual: {
					side: "translation",
					issues: actionable,
					modifiers: translationModifiers
				},
				expectation: { modifiers: sourceModifiers },
				recovery:
					"Repair modifier syntax and culture-required forms; preserve the source's argument modifiers."
			});
		const separator = context.checks.segment_separator.params.separator;
		if (separator !== undefined && translated) {
			const expected = countOccurrences(source, separator),
				actual = countOccurrences(translation, separator);
			if (expected !== actual)
				add({
					...base,
					ruleId: ruleIdOf("segment_separator"),
					kind: "segment_separator",
					actual: { separator, count: actual },
					expectation: { separator, count: expected },
					recovery: `Keep each "${separator}" segment of the source in the translation, in the same order.`
				});
		}
		const placeholder =
			translated && culture.culture !== context.nativeCulture
				? placeholderTranslation(
						source,
						translation,
						context.checks.placeholder_translation.params,
						context.checks.placeholder_text.params
					)
				: undefined;
		if (placeholder !== undefined)
			add({
				...base,
				ruleId: ruleIdOf("placeholder_translation"),
				kind: "placeholder_translation",
				actual: { translation: placeholder },
				expectation: { translatedText: true },
				recovery:
					"Translate the line; the culture ships this placeholder to players in place of the text."
			});
		const lengthParams = context.checks.length_outlier.params;
		const minimumRatio = lengthOutlierMinimumRatio(culture.culture, lengthParams);
		// A placeholder is placeholder_translation's finding, when that check runs here.
		const outlier =
			translated &&
			(placeholder === undefined || !active("placeholder_translation", culture.culture))
				? lengthOutlier(
						source,
						translation,
						(sourceLength ??= visibleTextLength(source)),
						minimumRatio,
						lengthParams
					)
				: undefined;
		if (outlier)
			add({
				...base,
				ruleId: ruleIdOf("length_outlier"),
				kind: "length_outlier",
				actual: { length: outlier.length, ratio: outlier.ratio },
				expectation: {
					sourceLength: outlier.sourceLength,
					minimumRatio: Math.round(minimumRatio * 100) / 100,
					maximumRatio: lengthParams.maximumRatio
				},
				recovery:
					"Check that the translation belongs to this line and is complete; a translation this much shorter or longer is often another line's text."
			});
		const variants =
			candidate && translated && culture.culture !== context.nativeCulture
				? context.translations.get(line.source)?.get(culture.culture)
				: undefined;
		const groupKey = variants && translationGroupKey(translation);
		// Where most lines ship the source untranslated, those lines are the ones to fix.
		if (
			variants &&
			(variants.majorityUntranslated
				? groupKey === variants.majority
				: groupKey !== variants.majority)
		)
			add({
				...base,
				ruleId: ruleIdOf("inconsistent_translation"),
				kind: "inconsistent_translation",
				actual: {
					translation,
					variants: variants.variants.slice(0, 5),
					variantCount: variants.variants.length,
					...(groupKey === translationGroupKey(line.source)
						? { untranslated: true as const }
						: undefined)
				},
				expectation: { consistentTranslation: true },
				recovery:
					"Use the culture's usual translation of this text, or add translator notes that explain why this key differs."
			});
	}
}

/** Built-ins are read-only; proposals never modify evidence, corpus, PO or archives. */
export function checkLocalizationTarget(
	corpus: TextCorpus,
	join: LocalizationJoin,
	evidence: LocalizationTargetEvidence,
	options: LocalizationCheckOptions = {},
	ruleDocument?: GameTextRuleDocument
): LocalizationQualityReport {
	const enabled = enabledLocalizationChecks(join, evidence, options, ruleDocument);
	const findings: LocalizationQualityFinding[] = [];
	const checkDiagnostics: LocalizationCheckDiagnostic[] = [];
	const changes: LocalizationChange[] = [];
	const byUnit = new Map(corpus.units.map((unit) => [unit.id, unit]));
	const duplicates = localizationDuplicateSources();
	for (const [position, line] of join.lines.entries())
		if (localizationDuplicateCandidate(line))
			duplicates.add(line.source, line.identity!, position, -1, () =>
				localizationDuplicatePlaces(
					line,
					localizationLineUnits(line, byUnit).flatMap((unit) => unit.occurrences)
				)
			);
	const { shared } = duplicates.finish();
	const ruleContext = localizationRuleContext(ruleDocument);
	const translations = localizationTranslationVariants(
		shared,
		join.nativeCulture,
		ruleContext.checks.inconsistent_translation.params
	);
	if (enabled.includes("inconsistent_translation"))
		for (const line of join.lines) translations.add(line);
	const context: LocalizationLineCheckContext = {
		target: join.target,
		nativeCulture: join.nativeCulture,
		options,
		enabled,
		duplicates: shared,
		translations: translations.finish(),
		...ruleContext,
		localizableProperties: enabled.includes("culture_invariant_text")
			? localizationLocalizableProperties(corpus.units)
			: new Set()
	};
	for (const line of [...join.lines].sort((a, b) => a.id.localeCompare(b.id)))
		checkLocalizationLine(line, () => localizationLineUnits(line, byUnit), context, {
			findings,
			checkDiagnostics,
			changes
		});
	findings.sort(compareLocalizationFindings);
	const files = localizationEvidenceFileStatuses(evidence);
	const policy =
		ruleDocument !== undefined && ruleDocument.schemaVersion !== 1
			? evaluateLocalizationPolicy(corpus, join, ruleDocument, options)
			: { findings: [], diagnostics: [] };
	const customChecks = customLocalizationChecks(ruleDocument);
	const custom: LocalizationCustomFinding[] = [];
	if (customChecks.length) {
		const customContext = {
			target: join.target,
			nativeCulture: join.nativeCulture,
			options,
			roles: context.roles
		};
		const lines = [...join.lines].sort((a, b) => a.id.localeCompare(b.id));
		for (const check of customChecks)
			for (const line of lines)
				localizationLineCustomFindings(
					line,
					() => localizationLineUnits(line, byUnit),
					check,
					localizationSourceCulture(line, join.nativeCulture),
					customContext,
					custom
				);
	}
	const visible = withoutAcceptedFindings(
		join,
		[...findings, ...policy.findings, ...custom],
		options.review
	);
	const combined = [...visible.findings].sort(compareReportedLocalizationFindings);
	const report = LocalizationQualityReport.make({
		schemaVersion: 1,
		ruleDocumentVersion: ruleDocument?.schemaVersion ?? 1,
		status: corpus.status,
		coverage: corpus.coverage,
		...textCorpusDiagnosticSummary(corpus.diagnostics),
		target: join.target,
		gatherEvidence: files,
		findings: combined,
		checkDiagnostics,
		roles: [],
		rules: [
			...(ruleDocument !== undefined && ruleDocument.schemaVersion !== 1
				? (ruleDocument.localizationRules ?? []).map((rule) => ({
						ruleId: rule.id,
						findingCount: visible.findings.filter(
							(finding) => finding.ruleId === rule.id
						).length
					}))
				: []),
			...enabled.map((id) => ({
				ruleId: ruleIdOf(id),
				findingCount: visible.findings.filter((finding) => finding.kind === id).length
			})),
			...customChecks.map((check) => ({
				ruleId: check.id,
				findingCount: visible.findings.filter((finding) => finding.ruleId === check.id)
					.length
			}))
		],
		changes: {
			schemaVersion: 1,
			provenance: {
				producer: "ue-shed.localization.checks",
				files: files.flatMap((file) => (file.provenance ? [file.provenance] : []))
			},
			changes
		}
	});
	if (ruleDocument !== undefined && ruleDocument.schemaVersion !== 1)
		Object.assign(report, { ruleDiagnostics: policy.diagnostics });
	if (options.review) Object.assign(report, { acceptedFindings: visible.accepted });
	if (customChecks.length)
		Object.assign(report, {
			customChecks: customChecks.map(({ id, label }) => ({ ruleId: id, label }))
		});
	return report;
}
