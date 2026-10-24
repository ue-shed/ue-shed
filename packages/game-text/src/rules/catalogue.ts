import { localizationCheckCatalogue } from "../localization-check-catalogue.js";
import type { BuiltInCheckId } from "../localization-check-ids.js";
import { type Arg, asExpr, expr as x } from "./builder.js";
import type { Expr, Rule } from "./schema.js";

const f = x.field;
const p = x.param;
const v = x.var;
const g = x.get;
const o = x.object;
const nonempty = (value: Expr) => x.gt(x.utf16Length(value), 0);
const positive = (value: Expr) => x.gt(value, 0);
const item = v("item");
const source = f("line.comparisonSource");
const translation = f("latest");
const translated = nonempty(x.trim(translation));
const comparable = x.and(f("line.checkable"), f("line.comparable"), x.not(x.isNull(translation)));
const translatedComparable = x.and(comparable, translated);
const sourceText = v("text");
const sourceTexts = x.coalesce(
	f("sourceVariants"),
	x.list(x.if(nonempty(x.trim(f("source"))), f("source"), f("comparisonSource")))
);
const placeholders = (text: Expr, markers = p("markers"), phrases = p("phrases")) =>
	x.sortByStart(
		x.concatLists(
			x.termListMatches(text, markers, true, "lmnu"),
			x.termListMatches(text, phrases, false, "lmnu")
		)
	);
const classValue = (value: Record<string, string>) => x.lit(value);
const category = (value: string) => classValue({ category: value });
const punctuationSpace = x.lit({ union: [{ category: "P" }, "jsSpace"] });
const groupKey = (text: Expr) => {
	const key = x.removeClass(
		x.lower(text),
		x.lit({ union: [{ category: "P" }, { category: "S" }, { category: "Z" }, "jsSpace"] })
	);
	return x.if(nonempty(key), key, x.trim(text));
};

/** A built-in rule's expressions; recovery guidance may be bare text. */
type Body = Pick<Rule, "when" | "actual" | "expectation"> &
	Omit<Partial<Rule>, "recovery"> & { readonly recovery: Arg };

function builtin(id: BuiltInCheckId, subject: Rule["subject"], expressions: Body): Rule {
	const descriptor = localizationCheckCatalogue[id];
	return {
		id,
		ruleId: `localization.${id}`,
		kind: id,
		label: descriptor.label,
		subject,
		family: "builtin",
		severity: descriptor.severity,
		params: {
			...descriptor.defaults,
			...(id === "placeholder_translation"
				? {
						sourceMarkers: localizationCheckCatalogue.placeholder_text.defaults.markers,
						sourcePhrases: localizationCheckCatalogue.placeholder_text.defaults.phrases
					}
				: undefined),
			...(id === "placeholder_text" ? { sourceTerminology: [] } : undefined),
			...(id === "segment_separator" ? { separator: null } : undefined)
		},
		...expressions,
		recovery: asExpr(expressions.recovery)
	};
}
const lc = (id: BuiltInCheckId, body: Parameters<typeof builtin>[2]) =>
	builtin(id, "line_culture", { ...body, when: x.and(comparable, body.when) });
const line = (id: BuiltInCheckId, body: Parameters<typeof builtin>[2]) =>
	builtin(id, "line", { ...body, when: x.and(f("checkable"), body.when) });
const sourceRule = (id: BuiltInCheckId, body: Parameters<typeof builtin>[2]) =>
	line(id, { each: sourceTexts, eachAs: "text", ...body });

const sourcePattern = x.formatPattern(source, f("culture"));
const translationPattern = x.formatPattern(translation, f("culture"));
const expectedArgs = x.formatArgumentNames(sourcePattern);
const actualArgs = x.formatArgumentNames(translationPattern);
const missing = x.if(
	translated,
	x.minus(x.formatArgumentOrder(sourcePattern), actualArgs),
	x.list()
);
const added = x.minus(
	x.minus(x.formatArgumentOrder(translationPattern), expectedArgs),
	p("optionalArguments")
);
const canComparePattern = x.and(
	x.not(x.isNull(x.formatCompiled(sourcePattern))),
	x.not(x.isNull(x.formatCompiled(translationPattern)))
);
const renamed = x.findingField("format_argument_renamed", "actual.renamed");
const renameCount = x.coalesce(x.count(renamed), 0);
const pairs = x.zip(added, missing);
const renamedPairs = x.map(pairs, o({ from: g(item, "0"), to: g(item, "1") }));
const actionableIssues = (pattern: Expr) =>
	x.filter(
		x.formatIssues(pattern),
		x.not(x.in(g(item, "code"), x.lit(["unsupported_culture", "syntax_limit"])))
	);
const tags = x.compareRichTextTags(
	x.withoutOptionalArgumentTags(source, p("optionalArguments")),
	x.withoutOptionalArgumentTags(translation, p("optionalArguments"))
);
const requiredTags = (field: string) =>
	x.filter(g(tags, field), x.not(x.in(x.lower(item), x.map(p("optionalTags"), x.lower(item)))));
const placeholderWord = (text: Expr) => x.trimClass(x.lower(text), punctuationSpace, "end");
const trimmedTranslation = x.trim(translation);
const sourcePlaceholders = placeholders(source, p("sourceMarkers"), p("sourcePhrases"));
const lowerWords = x.map(p("words"), x.lower(item));
const caseWord = x.first(
	x.filter(p("caseSensitiveWords"), x.eq(x.lower(item), placeholderWord(trimmedTranslation)))
);
const placeholder = x.and(
	translatedComparable,
	x.not(f("isNative")),
	x.le(x.utf16Length(trimmedTranslation), p("maximumLength")),
	x.anyChar(source, category("L")),
	x.ne(groupKey(trimmedTranslation), groupKey(source)),
	x.eq(x.count(sourcePlaceholders), 0),
	x.not(x.in(placeholderWord(x.trim(source)), lowerWords)),
	x.if(
		x.not(
			x.anyChar(trimmedTranslation, x.lit({ union: [{ category: "L" }, { category: "N" }] }))
		),
		x.ge(x.visibleWords(source), p("minimumPunctuationSourceWords")),
		x.if(
			x.isNull(caseWord),
			x.in(placeholderWord(trimmedTranslation), lowerWords),
			x.startsWith(trimmedTranslation, caseWord)
		)
	)
);
const compact = x.any(
	p("compactCultures"),
	x.or(
		x.eq(x.lower(f("culture")), x.lower(item)),
		x.startsWith(x.lower(f("culture")), x.concat(x.lower(item), "-"))
	)
);
const minimumRatio = x.if(compact, p("compactMinimumRatio"), p("minimumRatio"));
const sourceLength = x.visibleLength(source);
const translationLength = x.visibleLength(translation);
const ratio = x.div(translationLength, sourceLength);
const xmlClosings = g(x.richTextTagBalance(sourceText), "xmlClosings");
const richBalance = o({
	opening: g(x.richTextTagBalance(sourceText), "opening"),
	closing: g(x.richTextTagBalance(sourceText), "closing")
});
const braces = x.formatBraceBalance(sourceText);
const sourceSpaces = o({
	leading: x.leadingClass(sourceText, "jsSpace"),
	trailing: x.trailingClass(sourceText, "jsSpace"),
	repeatedSpaces: x.runs(x.trim(sourceText), x.lit({ chars: " " }), 2)
});
const sourcePlaceholderRanges = placeholders(sourceText);
/** Whether a scope's roles and path prefixes admit an occurrence, as a rule's own `scope` does. */
export const scopeAdmits = (occurrence: Expr, scope: Expr) =>
	x.and(
		x.or(
			x.isNull(g(scope, "roles")),
			x.any(
				x.coalesce(g(scope, "roles"), x.list()),
				x.matchesRole(occurrence, v("scopeRole")),
				"scopeRole"
			)
		),
		x.or(
			x.isNull(g(scope, "pathPrefixes")),
			x.any(
				x.coalesce(g(scope, "pathPrefixes"), x.list()),
				x.pathHasPrefix(occurrence, v("prefix")),
				"prefix"
			)
		)
	);
const reportedPlaceholderRanges = x.flatMap(
	x.filter(
		p("sourceTerminology"),
		x.any(
			x.occurrences(),
			x.and(
				x.eq(g(v("occurrence"), "source"), sourceText),
				x.matchesRole(v("occurrence"), g(v("termRule"), "role")),
				scopeAdmits(v("occurrence"), x.coalesce(g(v("termRule"), "scope"), o({})))
			),
			"occurrence"
		),
		"termRule"
	),
	x.flatMap(
		g(v("termRule"), "terms"),
		x.termMatches(sourceText, item, g(v("termRule"), "caseSensitive"))
	),
	"termRule"
);
const overlapsPlaceholder = (range: Expr) =>
	x.any(
		sourcePlaceholderRanges,
		x.and(x.lt(g(item, "start"), g(range, "end")), x.lt(g(range, "start"), g(item, "end")))
	);
const reported = x.filter(reportedPlaceholderRanges, overlapsPlaceholder(v("range")), "range");
const unreportedMatches = x.map(
	x.filter(
		sourcePlaceholderRanges,
		x.not(
			x.any(
				reported,
				x.and(
					x.lt(g(item, "start"), g(v("placeholder"), "end")),
					x.lt(g(v("placeholder"), "start"), g(item, "end"))
				)
			)
		),
		"placeholder"
	),
	g(item, "match")
);
const unreported = x.if(positive(x.count(reported)), unreportedMatches, null);
/** The source terminology reports every placeholder: lists of source findings show it instead. */
const reportedBySource = x.and(positive(x.count(reported)), x.eq(x.count(unreportedMatches), 0));

// Group checks read other rows through aggregates, computed over every row whatever the scope.
/** `localizationDuplicateCandidate`, on a line or, with `line.`, on one of its cultures. */
const duplicateCandidate = (prefix: "" | "line.") =>
	x.and(
		x.not(x.isNull(f(`${prefix}joinPosition`))),
		x.not(x.isNull(f(`${prefix}identity`))),
		nonempty(x.trim(f(`${prefix}source`))),
		x.anyChar(f(`${prefix}source`), category("L")),
		x.not(f(`${prefix}allOutside`)),
		x.not(f(`${prefix}conflicting`))
	);
/**
 * A candidate with another identity at another place (`DuplicateSources.hasOther`). A line
 * without a saved place has one of its own, its identity, which no saved place equals. Tuples
 * are distinct, so a line's cultures count once.
 */
const keptDuplicate = (prefix: "" | "line.") => {
	const identity = f(`${prefix}identity`),
		sites = f(`${prefix}duplicateSites`);
	return x.existsOther({
		over: x.if(positive(x.count(sites)), sites, x.list(identity)),
		by: f(`${prefix}source`),
		differing: x.list(identity, item),
		among: duplicateCandidate(prefix)
	});
};
const keptLine = keptDuplicate("");
const duplicates = { by: f("source"), among: keptLine };
const identityOrder = x.list(
	g(f("identity"), "namespace"),
	g(f("identity"), "key"),
	f("joinPosition")
);
const sharedSource = f("line.source");
/** `localizationTranslationVariants` counts these: a kept line's shipped translation, not native. */
const variantRow = x.and(
	keptDuplicate("line."),
	x.anyChar(sharedSource, category("L")),
	x.ge(x.visibleLength(sharedSource), p("minimumLength")),
	x.le(x.visibleWords(sharedSource), p("maximumWords")),
	x.not(f("isNative")),
	x.not(x.isNull(translation)),
	translated
);
const variantGroup = { by: x.list(sharedSource, f("culture")), among: variantRow };
const variants = x.groupTally({
	...variantGroup,
	value: groupKey(translation),
	display: translation
});
const majority = x.first(variants);
/** The culture ships the source untranslated on most of these lines. */
const majorityUntranslated = x.eq(g(majority, "value"), groupKey(sharedSource));
const PROPERTY_INDEX = String.raw`\[[^\]]*\]|\{[^}]*\}|\("[^"]*"\)`;
/** `localizationPropertyKey`: the saved property, container indexes removed. */
const propertyKey = (occurrence: Expr) => {
	const location = g(occurrence, "location"),
		kind = g(location, "kind");
	const path = x.regexReplace(g(location, "propertyPath"), PROPERTY_INDEX, "");
	return x.if(
		x.eq(kind, "asset_property"),
		x.concat("p\u0000", g(location, "classPath"), "\u0000", path),
		x.if(
			x.eq(kind, "data_table_cell"),
			x.concat("d\u0000", g(location, "objectPath"), "\u0000", path),
			null
		)
	);
};
/**
 * `invariantTextPlace`: not editor text, a String Table entry, a debug package or a text render.
 * The package path is the object path up to the first dot after its last slash.
 */
const invariantTextPlace = (occurrence: Expr) => {
	const location = g(occurrence, "location"),
		kind = g(location, "kind");
	return x.and(
		x.ne(g(occurrence, "audience"), "editor"),
		x.ne(kind, "string_table_entry"),
		x.not(x.regexTest(g(location, "objectPath"), "debug.*/|(?:^|/)[^/.]*debug", "i")),
		x.not(
			x.and(
				x.eq(kind, "asset_property"),
				x.endsWith(g(location, "classPath"), ".TextRenderComponent")
			)
		)
	);
};
const occurrence = v("occurrence");
const propertyCount = (among: Expr) =>
	x.corpusCount({ by: propertyKey(item), key: propertyKey(occurrence), among });

/** The longest distinct saved source, in UTF-16 units, as the native `long` signal measures it. */
const longest = x.maxOf(
	x.map(x.distinct(x.map(x.occurrences(), g(item, "source"))), x.utf16Length(item))
);

/** v4 definitions of every built-in check, in the existing check catalogue order. */
export const exampleRules: readonly Rule[] = [
	lc("format_arguments", {
		when: x.and(
			canComparePattern,
			x.or(
				positive(x.count(x.drop(missing, renameCount))),
				positive(
					x.count(x.minus(added, x.map(x.coalesce(renamed, x.list()), g(item, "from"))))
				)
			)
		),
		actual: o({
			arguments: actualArgs,
			missing: x.sortCodeUnit(x.drop(missing, renameCount)),
			added: x.sortCodeUnit(
				x.minus(added, x.map(x.coalesce(renamed, x.list()), g(item, "from")))
			)
		}),
		expectation: o({ arguments: expectedArgs }),
		recovery:
			"Keep the source's case-sensitive format argument names in the translation, including arguments inside modifier forms."
	}),
	builtin("argument_modifiers", "line_culture", {
		each: x.lit(["source", "translation"]),
		when: x.and(
			f("line.checkable"),
			f("line.comparable"),
			x.if(
				x.eq(item, "source"),
				positive(x.count(actionableIssues(sourcePattern))),
				x.and(
					translated,
					x.or(
						positive(x.count(actionableIssues(translationPattern))),
						x.and(
							canComparePattern,
							x.ne(
								x.formatModifiers(sourcePattern),
								x.formatModifiers(translationPattern)
							)
						)
					)
				)
			)
		),
		actual: o({
			side: item,
			issues: x.if(
				x.eq(item, "source"),
				actionableIssues(sourcePattern),
				actionableIssues(translationPattern)
			),
			modifiers: x.if(
				x.eq(item, "source"),
				x.formatModifiers(sourcePattern),
				x.formatModifiers(translationPattern)
			)
		}),
		expectation: o({ modifiers: x.formatModifiers(sourcePattern) }),
		recovery: x.if(
			x.eq(item, "source"),
			"Repair the source's modifier syntax and culture-required forms before translating it.",
			"Repair modifier syntax and culture-required forms; preserve the source's argument modifiers."
		)
	}),
	lc("rich_text", {
		when: x.not(x.richTextValid(source, translation)),
		actual: x.richTextCounts(translation),
		expectation: x.richTextCounts(source),
		recovery: "Balance opening rich-text tags with </>, retaining intentional source imbalance."
	}),
	lc("po_escape_safety", {
		let: { matches: x.findAll(translation, x.lit(["\\n", "\\r", "\\t"])) },
		when: positive(x.count(v("matches"))),
		actual: o({
			positions: x.map(v("matches"), g(item, "start")),
			sequences: x.map(v("matches"), g(item, "match"))
		}),
		expectation: o({ roundTripSafe: true }),
		recovery:
			"Replace literal backslash control sequences with actual control characters or reword them before Unreal's PO round trip."
	}),
	lc("whitespace", {
		when: x.and(
			x.ne(f("po"), ""),
			x.ne(f("archive"), ""),
			x.or(
				x.ne(
					g(x.unrealWhitespace(source), "leading"),
					g(x.unrealWhitespace(translation), "leading")
				),
				x.ne(
					g(x.unrealWhitespace(source), "trailing"),
					g(x.unrealWhitespace(translation), "trailing")
				),
				x.unrealUnsafeWhitespace(translation)
			)
		),
		actual: x.unrealWhitespace(translation),
		expectation: x.unrealWhitespace(source),
		recovery:
			"Preserve the source's intentional boundary whitespace; remove unsafe boundary spaces or tabs."
	}),
	builtin("empty_translation", "line_culture", {
		when: x.and(f("line.checkable"), x.or(x.eq(f("po"), ""), x.eq(f("archive"), ""))),
		actual: o({ entryExists: true, translation: "" }),
		expectation: o({ nonEmptyTranslation: true }),
		translationOrigin: x.if(x.eq(f("po"), ""), "po", "archive"),
		recovery:
			"Provide a non-empty translation in the culture's PO entry, then import and compile with Unreal."
	}),
	line("missing_translator_notes", {
		when: x.and(
			x.eq(x.count(f("manifestNotes")), 0),
			x.not(x.any(x.occurrences(), nonempty(x.trim(g(item, "devNotes")))))
		),
		actual: o({ noteCount: 0 }),
		expectation: o({ minimumNotes: 1 }),
		recovery: "Add translator context to a source occurrence or manifest-producing source."
	}),
	builtin("duplicate_source", "line", {
		// The group's first identity in order reports once for the group.
		when: x.and(
			keptLine,
			x.ge(x.groupCount(duplicates), 2),
			x.eq(x.groupRank({ ...duplicates, order: identityOrder }), 0)
		),
		actual: o({
			source: f("source"),
			identityCount: x.groupCount(duplicates),
			identities: x.groupTake({
				...duplicates,
				order: identityOrder,
				value: f("identity"),
				n: 5
			})
		}),
		expectation: o({ reviewDistinctKeys: true }),
		recovery:
			"Review whether these distinct identities need different context or should share a key. Equal text never links translations."
	}),
	lc("format_argument_renamed", {
		when: x.and(canComparePattern, positive(x.count(pairs))),
		actual: o({ arguments: actualArgs, renamed: renamedPairs }),
		expectation: o({ arguments: expectedArgs }),
		fix: x.if(
			x.and(
				f("line.gathered"),
				x.not(
					x.any(
						f("unknownReasons"),
						x.in(
							item,
							x.lit([
								"duplicate_manifest_identity",
								"duplicate_archive_identity",
								"duplicate_po_identity"
							])
						)
					)
				),
				x.eq(x.count(missing), 1),
				x.eq(x.count(added), 1)
			),
			x.formatRenameArgument(translation, x.first(added), x.first(missing), f("culture")),
			null
		),
		recovery:
			"Use the source's argument names unchanged; translate the words around {arguments}, never the names inside them."
	}),
	lc("rich_text_tags", {
		when: x.and(translated, positive(x.count(requiredTags("missing")))),
		actual: o({
			tags: g(tags, "translationTags"),
			missing: requiredTags("missing"),
			added: requiredTags("added")
		}),
		expectation: o({ tags: g(tags, "sourceTags") }),
		recovery:
			"Keep the source's rich-text tags, such as <b>…</> and <img/>, around the matching words; don't add or drop any."
	}),
	lc("rich_text_tag_case", {
		when: x.and(translated, positive(x.count(g(tags, "changed")))),
		actual: o({ changed: g(tags, "changed") }),
		expectation: o({ sameCase: true }),
		recovery: "Spell rich-text tag names exactly as the source does."
	}),
	lc("line_breaks", {
		when: x.and(
			translated,
			x.ne(x.interiorLineBreaks(source), x.interiorLineBreaks(translation))
		),
		actual: o({ lineBreaks: x.interiorLineBreaks(translation) }),
		expectation: o({ lineBreaks: x.interiorLineBreaks(source) }),
		recovery:
			"Use as many line breaks as the source, so the text keeps its layout in the same space."
	}),
	lc("segment_separator", {
		when: x.and(
			translated,
			x.not(x.isNull(p("separator"))),
			x.ne(
				x.countOccurrences(source, p("separator")),
				x.countOccurrences(translation, p("separator"))
			)
		),
		actual: o({
			separator: p("separator"),
			count: x.countOccurrences(translation, p("separator"))
		}),
		expectation: o({
			separator: p("separator"),
			count: x.countOccurrences(source, p("separator"))
		}),
		recovery: x.concat(
			'Keep each "',
			p("separator"),
			'" segment of the source in the translation, in the same order.'
		)
	}),
	lc("length_outlier", {
		when: x.and(
			translatedComparable,
			x.not(x.finding("placeholder_translation")),
			x.ge(sourceLength, p("minimumSourceLength")),
			x.gt(translationLength, 0),
			x.or(x.lt(ratio, minimumRatio), x.gt(ratio, p("maximumRatio")))
		),
		actual: o({ length: translationLength, ratio: x.round(ratio, 2) }),
		expectation: o({
			sourceLength,
			minimumRatio: x.round(minimumRatio, 2),
			maximumRatio: p("maximumRatio")
		}),
		recovery:
			"Check that the translation belongs to this line and is complete; a translation this much shorter or longer is often another line's text."
	}),
	...(["outdated_translation", "source_line_endings_changed"] as const).map((id) =>
		lc(id, {
			when: x.and(
				translatedComparable,
				x.not(x.isNull(f("line.manifestSource"))),
				x.eq(f("latestOrigin"), "archive"),
				x.not(x.isNull(f("archive"))),
				x.not(f("isNative")),
				x.in("needs_update", f("facts")),
				id === "source_line_endings_changed"
					? x.and(
							x.ne(f("archiveSource"), f("expectedSource")),
							x.eq(
								x.normalizeLineEndings(f("archiveSource")),
								x.normalizeLineEndings(f("expectedSource"))
							)
						)
					: x.or(
							x.eq(f("archiveSource"), f("expectedSource")),
							x.ne(
								x.normalizeLineEndings(f("archiveSource")),
								x.normalizeLineEndings(f("expectedSource"))
							)
						)
			),
			actual: o({ translatedSource: f("archiveSource") }),
			expectation: o({ source: f("expectedSource") }),
			recovery:
				id === "outdated_translation"
					? "Translate the current source text and import it; Unreal ships the source instead of a translation made for older text."
					: "Save the source with the line endings it was translated with, or re-import the translation against the current source."
		})
	),
	builtin("inconsistent_translation", "line_culture", {
		// Two variants at least and one most used. Where most lines ship the source untranslated
		// and under half as many translate it, the culture keeps it untranslated on purpose;
		// otherwise those untranslated lines are the ones to fix.
		when: x.and(
			variantRow,
			x.ge(x.count(variants), 2),
			x.ne(g(majority, "count"), g(g(variants, "1"), "count")),
			x.if(
				majorityUntranslated,
				x.and(
					x.ge(
						x.mul(x.sub(x.groupCount(variantGroup), g(majority, "count")), 2),
						g(majority, "count")
					),
					x.eq(groupKey(translation), g(majority, "value"))
				),
				x.ne(groupKey(translation), g(majority, "value"))
			)
		),
		actual: o({
			translation,
			variants: x.map(
				x.take(variants, 5),
				o({ translation: g(item, "display"), lines: g(item, "count") })
			),
			variantCount: x.count(variants),
			untranslated: x.if(x.eq(groupKey(translation), groupKey(sharedSource)), true, null)
		}),
		expectation: o({ consistentTranslation: true }),
		recovery:
			"Use the culture's usual translation of this text, or add translator notes that explain why this key differs."
	}),
	lc("rich_text_tags_added", {
		let: {
			additions: x.filter(
				requiredTags("added"),
				x.not(
					x.in(
						x.lower(item),
						x.map(
							x.coalesce(x.findingField("rich_text_tags", "actual.added"), x.list()),
							x.lower(item)
						)
					)
				)
			)
		},
		when: x.and(translated, positive(x.count(v("additions")))),
		actual: o({ tags: g(tags, "translationTags"), added: v("additions") }),
		expectation: o({ tags: g(tags, "sourceTags") }),
		recovery:
			"Style the same words as the source; list a tag a culture may add in the rule file's optionalTags."
	}),
	lc("placeholder_translation", {
		when: placeholder,
		actual: o({ translation: trimmedTranslation }),
		expectation: o({ translatedText: true }),
		recovery:
			"Translate the line; the culture ships this placeholder to players in place of the text."
	}),
	builtin("culture_invariant_text", "line", {
		// Every saved occurrence is culture invariant, and one is where invariant text is a slip:
		// its property holds at least as much localizable text across the project.
		when: x.and(
			x.isNull(f("identity")),
			x.anyChar(f("source"), category("L")),
			positive(x.count(x.occurrences())),
			x.all(x.occurrences(), x.eq(g(item, "unresolvedReason"), "culture_invariant")),
			x.any(
				x.occurrences(),
				x.and(
					invariantTextPlace(occurrence),
					x.ge(
						propertyCount(
							x.in(g(item, "unitStatus"), x.lit(["resolved", "string_table"]))
						),
						propertyCount(
							x.and(
								x.eq(g(item, "unresolvedReason"), "culture_invariant"),
								invariantTextPlace(item)
							)
						)
					)
				),
				"occurrence"
			)
		),
		actual: o({ source: f("source") }),
		expectation: o({ localizable: true }),
		translationOrigin: x.lit("absent"),
		recovery:
			"Make the text localizable (clear Culture Invariant, or use NSLOCTEXT/LOCTEXT or a String Table) so the gather collects it; keep it invariant only if players never see it."
	}),
	sourceRule("placeholder_text", {
		when: positive(x.count(sourcePlaceholderRanges)),
		actual: o({
			source: sourceText,
			matches: x.map(sourcePlaceholderRanges, g(item, "match"))
		}),
		expectation: o({ finalText: true }),
		extra: o({ unreportedMatches: unreported }),
		shadowed: reportedBySource,
		recovery:
			"Replace the placeholder with final text, or keep the line out of the build until it has some."
	}),
	sourceRule("source_whitespace", {
		when: x.and(
			f("gathered"),
			x.not(f("bytecodeOnly")),
			x.or(
				nonempty(g(sourceSpaces, "leading")),
				nonempty(g(sourceSpaces, "trailing")),
				x.gt(g(sourceSpaces, "repeatedSpaces"), 0)
			)
		),
		actual: o({
			source: sourceText,
			leading: g(sourceSpaces, "leading"),
			trailing: g(sourceSpaces, "trailing"),
			repeatedSpaces: g(sourceSpaces, "repeatedSpaces")
		}),
		expectation: o({ trimmed: true }),
		recovery:
			"Remove spaces and line breaks at the ends and doubled spaces; build spacing into the format pattern instead of joining text."
	}),
	sourceRule("source_markup", {
		when: x.and(
			x.not(f("bytecodeOnly")),
			x.or(
				x.ne(g(richBalance, "opening"), g(richBalance, "closing")),
				x.ne(g(braces, "opening"), g(braces, "closing")),
				positive(x.count(xmlClosings))
			)
		),
		actual: o({
			source: sourceText,
			richText: richBalance,
			braces,
			xmlClosings: x.if(positive(x.count(xmlClosings)), x.distinct(xmlClosings), null)
		}),
		expectation: o({ balanced: true }),
		recovery: x.if(
			positive(x.count(xmlClosings)),
			"Close rich-text tags with </>; Unreal shows a closing such as </Name> as text.",
			"Close each rich-text tag with </> and pair each { with }; escape a literal brace with a backtick."
		)
	}),
	sourceRule("number_only_text", {
		when: x.and(
			x.not(f("bytecodeOnly")),
			x.not(x.contains(sourceText, "{")),
			x.not(x.anyChar(sourceText, category("L"))),
			x.anyChar(sourceText, category("N"))
		),
		actual: o({ source: sourceText }),
		expectation: o({ cultureInvariant: true }),
		recovery:
			"Make number-only text culture invariant, or format the number with FText::AsNumber, so translators are not sent it."
	}),
	line("string_table_key_collision", {
		when: x.gt(x.count(f("stringTables")), 1),
		actual: o({
			tables: x.take(f("stringTables"), 16),
			tableCount: x.count(f("stringTables"))
		}),
		expectation: o({ oneTablePerKey: true }),
		recovery:
			"Give each String Table its own namespace or rename the key; Unreal keeps one entry per namespace and key."
	}),
	// Browse's review signals. Their own occurrences decide; gathered-only lines have none.
	builtin("shared", "line", {
		when: x.gt(x.count(x.occurrences()), 1),
		actual: o({ occurrences: x.count(x.occurrences()) }),
		expectation: o({ singleUse: true }),
		recovery:
			"Check that the text means the same in every place; give a place its own key where its context differs."
	}),
	builtin("long", "line", {
		when: x.ge(longest, p("limit")),
		actual: o({ length: longest }),
		expectation: o({ maximumLength: p("limit") }),
		recovery:
			"Check that the text and its translations fit where they are shown; translations often run longer."
	})
];
