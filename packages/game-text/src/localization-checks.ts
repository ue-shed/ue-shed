import type {
	CultureCode,
	LocalizationIdentity,
	LocalizationTargetEvidence
} from "@ue-shed/localization/browser";
import { BuiltInCheckId } from "./localization-check-ids.js";
import {
	localizationCheckDefaults,
	localizationRuleId,
	type InconsistentTranslationParams
} from "./localization-check-catalogue.js";
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
import type {
	LocalizationQualityFinding,
	LocalizationPolicyFinding,
	LocalizationCustomFinding,
	LocalizationCheckOptions
} from "./localization-quality-schema.js";
import type { TextQualityAffectedOccurrence, TextRole } from "./quality-schema.js";
import {
	resolveLocalizationChecks,
	type GameTextRuleDocument,
	type ResolvedLocalizationChecks
} from "./game-text-rules.js";
import { localizationCheckInScope } from "./localization-check-scope.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
export {
	localizationShippedTranslation,
	LocalizationShippedTranslation
} from "./localization-shipped-translation.js";
import type { TextOccurrence, TextUnit } from "./schema.js";
import {
	consistentTranslationCandidate,
	sharedSourceCandidate,
	translationGroupKey
} from "./localization-text-shape.js";
type DuplicateSourceActual = Extract<
	LocalizationQualityFinding,
	{ kind: "duplicate_source" }
>["actual"];
type Unrated<F> = F extends unknown ? Omit<F, "severity"> : never;
type UnratedFinding = Unrated<LocalizationQualityFinding>;
/** Resolved host selection and corpus aggregates used by the remaining group checks. */
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
	/** The rule file's roles by ID, for check scopes. */
	readonly roles: ReadonlyMap<string, TextRole>;

	/**
	 * `localizationPropertiesWhereLocalizable` over the project: culture-invariant text is
	 * reported only in these properties.
	 */
	readonly localizableProperties: ReadonlySet<string>;
	/**
	 * Whether a line without an identity holds only culture-invariant text and some of it is
	 * `reportableInvariantText`, answered without its units; a scan whose units are costly to build
	 * passes it. Absent, the line's units answer.
	 */
	readonly cultureInvariant?: ((line: LocalizationLine) => boolean) | undefined;
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

/** Shared settings for the remaining corpus group checks. */
export function localizationRuleContext(document: GameTextRuleDocument | undefined) {
	return {
		checks: resolveLocalizationChecks(document),
		roles: new Map((document?.roles ?? []).map((role) => [role.id, role]))
	};
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

/** Duplicate sources, inconsistent translations and invariant text across the corpus. */
export function checkLocalizationGroups(
	line: LocalizationLine,
	units: () => readonly TextUnit[],
	context: LocalizationLineCheckContext,
	findings: LocalizationQualityFinding[]
): void {
	const { target, options, enabled } = context;
	let lineUnits: readonly TextUnit[] | undefined,
		affected: TextQualityAffectedOccurrence[] | undefined;
	const unitsOnce = () => (lineUnits ??= units());
	const active = (id: BuiltInCheckId, culture: CultureCode) =>
		enabled.includes(id) &&
		localizationCheckInScope(
			context.checks[id].scope,
			culture,
			() => unitsOnce().flatMap((unit) => unit.occurrences),
			context.roles
		);
	const add = (finding: UnratedFinding) => {
		if (!active(finding.kind, finding.culture)) return;
		// SAFETY: severity preserves the discriminated finding member.
		// Verified by: the indexed group-check tests.
		findings.push({
			...finding,
			affectedOccurrences: (affected ??= affectedOf(unitsOnce())),
			severity: context.checks[finding.kind].severity
		} as LocalizationQualityFinding);
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

	const manifestSource = line.manifest[0]?.source.Text,
		source = manifestSource ?? line.source;
	if (!source.trim() && !line.source.trim()) return;
	const sourceVariants = localizationConflictingSource(line)
		? conflictingSourceVariants(line, unitsOnce())
		: undefined;
	const comparable = sourceVariants === undefined || manifestSource !== undefined;
	const candidate = localizationDuplicateCandidate(line);
	const manifestLocations = [...new Set(line.manifest.map((entry) => entry.path))].sort();
	for (const culture of [...line.cultures].sort((a, b) => a.culture.localeCompare(b.culture))) {
		if (
			(options.culture && options.culture !== culture.culture) ||
			culture.state === "outside_target"
		)
			continue;
		const shipped = localizationShippedTranslation(culture);
		const base = {
			lineId: line.id,
			target,
			culture: culture.culture,
			identity: line.identity,
			affectedOccurrences: [],
			manifestLocations,
			translationOrigin: shipped.origin,
			...(sourceVariants ? { sourceVariants } : undefined)
		};
		if (culture.culture === sourceCulture) {
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
		}
		if (!comparable || shipped.value === null) continue;
		const translation = shipped.value,
			translated = translation.trim().length > 0;
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
