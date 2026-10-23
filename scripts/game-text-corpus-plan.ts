import { Schema } from "effect";
import {
	corpusCultures,
	decodeCorpusExpectations,
	findingCounts,
	corpusNotExposedYet,
	CorpusExpectations,
	CorpusFinding,
	CorpusSourceKind,
	type CorpusSubject
} from "./game-text-corpus-contract.ts";

/** This module authors intent. It deliberately imports no UE Shed package or check implementation. */
export interface PlannedCulture {
	translation: string;
	expectedSource: string;
	archiveSource: string;
	archiveMetadata: Record<string, string>;
	resourceTranslation: string;
	importPending: boolean;
	compilePending: boolean;
	po: string;
	poEntry: boolean;
	archive: boolean;
	state: string;
	facts: string[];
	unknownReasons: string[];
	problems: string[];
	findings: CorpusFinding[];
}
export interface PlannedText {
	case: string;
	instance: number;
	parameters: Record<string, typeof Schema.Json.Type>;
	kind: CorpusSourceKind;
	field: string;
	namespace: string;
	key: string;
	source: string;
	notes: string;
	mode: "text" | "invariant" | "reference" | "scaffold";
	table: string;
	tableKey: string;
	manifestSource: string;
	gathered: boolean;
	exists: boolean;
	compiledSource: string;
	previousSource: string;
	manifestMetadata: Record<string, string>;
	manifestPath: string;
	signals: string[];
	absent: string[];
	cultures: Record<string, PlannedCulture>;
}
export interface PlannedPackage {
	path: string;
	kind: string;
	folder: string;
	name: string;
	packageNamespace: string;
	persistentGuid: string;
	tableNamespace: string;
	texts: PlannedText[];
}
export interface CorpusPlan {
	format: "ue-shed-game-text-corpus-plan";
	version: 1;
	scenario: "main" | "collapse";
	phase: "initial" | "after";
	seed: number;
	lines: number;
	density: number;
	requestedLines: number;
	edits: {
		packages: string[];
		deletedPackages: string[];
		changedFiles: string[];
		operations: { kind: string; subject: string; value: string }[];
	};
	root: string;
	target: string;
	cultures: readonly string[];
	packages: PlannedPackage[];
	rules: object;
	probes: { case: string; kind: string; culture: string; expected: typeof Schema.Json.Type }[];
	expectations: CorpusExpectations;
}
const PlannedCultureSchema = Schema.Struct({
	translation: Schema.String,
	expectedSource: Schema.String,
	archiveSource: Schema.String,
	archiveMetadata: Schema.Record(Schema.String, Schema.String),
	resourceTranslation: Schema.String,
	po: Schema.String,
	poEntry: Schema.Boolean,
	importPending: Schema.Boolean,
	compilePending: Schema.Boolean,
	archive: Schema.Boolean,
	state: Schema.String,
	facts: Schema.Array(Schema.String),
	unknownReasons: Schema.Array(Schema.String),
	problems: Schema.Array(Schema.String),
	findings: Schema.Array(CorpusFinding)
});
export const CorpusPlanSchema = Schema.Struct({
	format: Schema.Literal("ue-shed-game-text-corpus-plan"),
	version: Schema.Literal(1),
	scenario: Schema.Literals(["main", "collapse"]),
	phase: Schema.Literals(["initial", "after"]),
	seed: Schema.Int,
	lines: Schema.Int,
	density: Schema.Int,
	requestedLines: Schema.Int,
	edits: Schema.Struct({
		packages: Schema.Array(Schema.String),
		deletedPackages: Schema.Array(Schema.String),
		changedFiles: Schema.Array(Schema.String),
		operations: Schema.Array(
			Schema.Struct({ kind: Schema.String, subject: Schema.String, value: Schema.String })
		)
	}),
	root: Schema.String,
	target: Schema.String,
	cultures: Schema.Array(Schema.String),
	rules: Schema.Json,
	expectations: CorpusExpectations,
	probes: Schema.Array(
		Schema.Struct({
			case: Schema.String,
			kind: Schema.String,
			culture: Schema.String,
			expected: Schema.Json
		})
	),
	packages: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			kind: Schema.Literals(["stringTable", "dataTable", "blueprint", "widgetBlueprint"]),
			folder: Schema.String,
			name: Schema.String,
			packageNamespace: Schema.String,
			persistentGuid: Schema.String,
			tableNamespace: Schema.String,
			texts: Schema.Array(
				Schema.Struct({
					case: Schema.String,
					instance: Schema.Int,
					parameters: Schema.Record(Schema.String, Schema.Json),
					kind: CorpusSourceKind,
					field: Schema.String,
					namespace: Schema.String,
					key: Schema.String,
					source: Schema.String,
					notes: Schema.String,
					mode: Schema.Literals(["text", "invariant", "reference", "scaffold"]),
					table: Schema.String,
					tableKey: Schema.String,
					manifestSource: Schema.String,
					gathered: Schema.Boolean,
					exists: Schema.Boolean,
					compiledSource: Schema.String,
					signals: Schema.Array(Schema.String),
					absent: Schema.Array(Schema.String),
					previousSource: Schema.String,
					manifestMetadata: Schema.Record(Schema.String, Schema.String),
					manifestPath: Schema.String,
					cultures: Schema.Record(Schema.String, PlannedCultureSchema)
				})
			)
		})
	)
});
export function decodeCorpusPlan(contents: string) {
	const plan = Schema.decodeUnknownSync(Schema.fromJsonString(CorpusPlanSchema))(contents);
	if (plan.packages.reduce((total, item) => total + item.texts.length, 0) !== plan.lines)
		throw new Error("Plan line count differs from its placements.");
	decodeCorpusExpectations(JSON.stringify(plan.expectations));
	if (
		plan.expectations.lines !== plan.lines ||
		plan.expectations.seed !== plan.seed ||
		plan.expectations.root !== plan.root ||
		plan.expectations.subjects.length !== plan.lines * plan.cultures.length
	)
		throw new Error("Plan and expectations headers disagree.");
	return plan;
}
const F = (
	check: string,
	actual: CorpusFinding["actual"],
	expectation: CorpusFinding["expectation"]
): CorpusFinding => ({ check, actual, expectation });
const builtin = (
	check: string,
	actual: CorpusFinding["actual"],
	expectation: CorpusFinding["expectation"]
) => F(`localization.${check}`, actual, expectation);
const cleanSpace = { leading: "", trailing: "", lineBreaks: 0 };

/** Named recipes declare answers beside their seeded constructors; placement happens afterward. */
function recipeBatch({
	seed,
	lines,
	root,
	scenario = "main",
	instance = 0
}: {
	seed: number;
	lines: number;
	root: string;
	scenario?: "main" | "collapse";
	instance?: number;
}): CorpusPlan {
	if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2_147_483_647)
		throw new Error("Invalid seed.");
	if (!Number.isSafeInteger(lines) || lines < 1 || lines > 1_000_000)
		throw new Error("Invalid lines.");
	if (!/^\/Game(?:\/[A-Za-z0-9_-]+){2,}$/u.test(root)) throw new Error("Invalid corpus root.");
	let random = seed >>> 0;
	const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
	const guid = () =>
		Array.from({ length: 4 }, () => next().toString(16).padStart(8, "0"))
			.join("")
			.toUpperCase();
	const packages: PlannedPackage[] = [];
	const target = "UEShedCorpus";
	const probes: CorpusPlan["probes"] = [];
	const roles: object[] = [],
		sourceRules: object[] = [],
		localizationRules: object[] = [];
	function pkg(
		kind: string,
		folder: string,
		name: string,
		tableNamespace = `Corpus.I${instance}.${name}`
	) {
		const value: PlannedPackage = {
			path: `${root}/${folder}/${name}`,
			kind,
			folder,
			name,
			packageNamespace: guid(),
			persistentGuid: guid(),
			tableNamespace,
			texts: []
		};
		packages.push(value);
		return value;
	}
	const table = pkg("stringTable", "StringTables", "ST_Cases");
	const rows = pkg("dataTable", "DataTables", "DT_Cases");
	const blueprint = pkg("blueprint", "Blueprints", "BP_Cases");
	const widget = pkg("widgetBlueprint", "Widgets", "WBP_Cases");
	let count = 0;
	function add(name: string, source: string, options: Partial<PlannedText> = {}, owner = table) {
		const index = count++;
		const kind: CorpusSourceKind =
			owner.kind === "stringTable"
				? "stringTableEntry"
				: owner.kind === "dataTable"
					? "dataTableCell"
					: owner.kind === "widgetBlueprint"
						? "widgetText"
						: "blueprintVariable";
		const key = `I${instance}_K${String(index).padStart(7, "0")}`;
		const text: PlannedText = {
			case: name,
			instance,
			parameters: {},
			kind,
			field: kind === "dataTableCell" ? `${key}.DisplayName` : key,
			namespace:
				owner.kind === "stringTable" ? owner.tableNamespace : `[${owner.packageNamespace}]`,
			key,
			source,
			notes: `Context for ${name}.`,
			mode: "text",
			table: "",
			tableKey: "",
			manifestSource: source,
			gathered: true,
			exists: true,
			compiledSource: "",
			previousSource: "",
			manifestMetadata: {},
			manifestPath: "",
			signals: [],
			absent: [],
			cultures: {},
			...options
		};
		for (const culture of corpusCultures) {
			const translation = source;
			text.cultures[culture] = {
				translation,
				expectedSource: text.manifestSource,
				archiveSource: text.manifestSource,
				archiveMetadata: { ...text.manifestMetadata },
				resourceTranslation: "",
				importPending: false,
				compilePending: false,
				po: translation,
				poEntry: true,
				archive: true,
				state: "translated",
				facts: ["translated"],
				unknownReasons: [],
				problems: ["up_to_date"],
				findings: []
			};
		}
		owner.texts.push(text);
		return text;
	}
	function translation(text: PlannedText, value: string, culture = "de") {
		text.cultures[culture]!.translation = value;
		text.cultures[culture]!.po = value;
	}
	function find(
		text: PlannedText,
		check: string,
		actual: CorpusFinding["actual"],
		expectation: CorpusFinding["expectation"],
		culture = "de"
	) {
		text.cultures[culture]!.findings.push(builtin(check, actual, expectation));
	}
	function plantFix(text: PlannedText, translation: string, culture = "de") {
		const mark = text.cultures[culture]!;
		mark.findings = mark.findings.map((finding) =>
			finding.check === "localization.format_argument_renamed"
				? {
						...finding,
						fix: {
							target,
							culture,
							namespace: text.namespace,
							key: text.key,
							source: text.manifestSource,
							previousTranslation: mark.po,
							translation
						}
					}
				: finding
		);
	}
	function signals(text: PlannedText, values: string[], problems = ["finding"]) {
		text.signals = values;
		for (const culture of corpusCultures) text.cultures[culture]!.problems = problems;
	}
	function state(
		text: PlannedText,
		value: string,
		problems: string[],
		cultures: readonly string[] = corpusCultures
	) {
		for (const culture of cultures)
			Object.assign(text.cultures[culture]!, { state: value, facts: [value], problems });
	}
	function facts(
		text: PlannedText,
		values: string[],
		cultures: readonly string[] = corpusCultures
	) {
		for (const culture of cultures) text.cultures[culture]!.facts = values;
	}
	function role(name: string, entries: PlannedText[]) {
		roles.push({
			id: name,
			scopes: entries.map((text) => ({
				matchers: [{ kind: "string_table_entry", operator: "exact", value: text.key }]
			}))
		});
		return name;
	}
	function translatedCase(
		name: string,
		source: string,
		value: string,
		check: string,
		actual: CorpusFinding["actual"],
		expectation: CorpusFinding["expectation"]
	) {
		const text = add(name, source);
		translation(text, value);
		find(text, check, actual, expectation);
		const near = add(`${name}-near`, `${source} N`);
		near.absent.push(`localization.${check}`);
		return text;
	}
	function finish(): CorpusPlan {
		const expectations = deriveCorpusExpectations({ packages, seed, root, target });
		return {
			format: "ue-shed-game-text-corpus-plan",
			version: 1,
			scenario,
			phase: "initial",
			seed,
			lines: count,
			density: 1,
			requestedLines: lines,
			edits: { packages: [], deletedPackages: [], changedFiles: [], operations: [] },
			root,
			target,
			cultures: corpusCultures,
			packages: packages.filter((owner) => owner.texts.length > 0),
			expectations,
			probes,
			rules: {
				schemaVersion: 3,
				roles,
				rules: sourceRules,
				localizationRules,
				checks: { segment_separator: { params: { separator: "//" } } },
				customChecks
			}
		};
	}
	const customChecks: object[] = [];
	if (scenario === "collapse") {
		add("collapse-unique-a", "Amber harbor");
		add("collapse-unique-b", "Silver harbor");
		return finish();
	}

	const draw = (low: number, high: number) => low + ((next() >>> 8) % (high - low + 1));
	const token = (width: number, salt = 0) => {
		const code = (instance * 211 + salt).toString(26).replaceAll("0", "a");
		return ("q" + code + next().toString(26)).slice(0, width).padEnd(width, "z");
	};
	for (const [name, operation] of [
		["format-missing", "drop"],
		["format-added", "add"],
		["format-renamed", "rename"]
	] as const) {
		const size = draw(1, 3),
			chosen = draw(0, size - 1);
		const args = Array.from(
			{ length: size },
			(_, i) => `A${instance.toString(16)}${String.fromCharCode(97 + draw(0, 25))}${i}`
		).sort();
		const extra = `B${instance.toString(16)}${String.fromCharCode(97 + draw(0, 25))}z`;
		const targetArgs = (
			operation === "drop"
				? args.filter((_, i) => i !== chosen)
				: operation === "add"
					? [...args, extra]
					: args.map((arg, i) => (i === chosen ? extra : arg))
		).sort();
		const source =
			token(5, operation === "drop" ? 10 : operation === "add" ? 20 : 30) +
			" " +
			args.map((arg) => `{${arg}}`).join(" ");
		const target = "Fracht " + targetArgs.map((arg) => `{${arg}}`).join(" ");
		const text = translatedCase(
			name,
			source,
			target.trimEnd(),
			operation === "rename" ? "format_argument_renamed" : "format_arguments",
			operation === "rename"
				? { arguments: targetArgs, renamed: [{ from: extra, to: args[chosen]! }] }
				: {
						arguments: targetArgs,
						missing: operation === "drop" ? [args[chosen]!] : [],
						added: operation === "add" ? [extra] : []
					},
			{ arguments: args }
		);
		text.parameters = {
			argumentCount: size,
			changedArgument: chosen,
			operation,
			arguments: args
		};
		if (operation === "rename") {
			text.absent.push("localization.format_arguments");
			// Reuse the drawn argument slots in their translation order; no tokenizer supplies this answer.
			plantFix(
				text,
				"Fracht " +
					targetArgs.map((arg) => `{${arg === extra ? args[chosen]! : arg}}`).join(" ")
			);
		}
	}
	const nestedNonce = token(6, 44);
	const nestedSource = `{N}|plural(one="{Owner} has one ${nestedNonce}",other="{Owner} has many ${nestedNonce}")`;
	const nestedTranslation = `{N}|plural(one="{Wrong} hat eins ${nestedNonce}",other="{Wrong} hat viele ${nestedNonce}")`;
	const nested = add("format-renamed-nested", nestedSource);
	translation(nested, nestedTranslation);
	find(
		nested,
		"format_argument_renamed",
		{ arguments: ["N", "Wrong"], renamed: [{ from: "Wrong", to: "Owner" }] },
		{ arguments: ["N", "Owner"] }
	);
	plantFix(
		nested,
		`{N}|plural(one="{Owner} hat eins ${nestedNonce}",other="{Owner} hat viele ${nestedNonce}")`
	);
	nested.absent.push("localization.format_arguments");
	signals(nested, ["long"], ["up_to_date"]);
	const nestedNear = add("format-renamed-nested-near", nestedSource + " N");
	nestedNear.absent.push("localization.format_argument_renamed", "localization.format_arguments");
	signals(nestedNear, ["long"], ["up_to_date"]);

	const modifier = translatedCase(
		"argument-modifier-dropped",
		"{Count}|plural(one=bird,other=birds)",
		"{Count} Vögel",
		"argument_modifiers",
		{ side: "translation", issues: [], modifiers: [] },
		{ modifiers: [{ argument: "Count", name: "plural" }] }
	);
	// The default French translation must retain the full expression, including the argument prefix.
	translation(modifier, modifier.source, "fr");
	const modifierNear = table.texts.at(-1)!;
	modifierNear.source = "{Count} bird N";
	modifierNear.manifestSource = modifierNear.source;
	for (const culture of corpusCultures) {
		translation(modifierNear, modifierNear.source, culture);
		modifierNear.cultures[culture]!.archiveSource = modifierNear.source;
	}
	for (const side of ["source", "translation"])
		find(
			modifier,
			"argument_modifiers",
			{
				side,
				issues: [
					{
						code: "redundant_modifier",
						modifier: "plural",
						argument: "Count",
						forms: [],
						position: 7
					}
				],
				modifiers: [{ argument: "Count", name: "plural" }]
			},
			{ modifiers: [{ argument: "Count", name: "plural" }] },
			"ja"
		);
	translatedCase(
		"rich-unbalanced",
		"<Em>Harbor</>",
		"<Em>Hafen",
		"rich_text",
		{ opening: 1, closing: 0 },
		{ opening: 1, closing: 1 }
	);
	const escape = translatedCase(
		"po-literal-escape",
		"River bend",
		"Fluss\\nBogen",
		"po_escape_safety",
		{ positions: [5], sequences: ["\\n"] },
		{ roundTripSafe: true }
	);
	// Unreal's PO import cannot preserve literal backslash-n (PortableObjectPipeline.cpp).
	// This entry is archive-only so the unsafe shipped string remains the subject of the check.
	escape.cultures.de!.poEntry = false;
	const edgeWhitespace = [" ", "\t", "\u3000"][draw(0, 2)]!;
	translatedCase(
		"translation-boundary-space",
		"Silver key",
		edgeWhitespace + "Silberschlüssel",
		"whitespace",
		{ ...cleanSpace, leading: edgeWhitespace },
		cleanSpace
	);
	translatedCase(
		"empty-suppresses-shape",
		"Relic {Item}",
		"",
		"empty_translation",
		{ entryExists: true, translation: "" },
		{ nonEmptyTranslation: true }
	);
	const empty = table.texts.at(-2)!;
	state(empty, "not_translated", ["translation"], ["de"]);
	empty.absent.push("localization.format_arguments", "localization.length_outlier");
	const notes = add("translator-note-missing", "Amber torch", { notes: "" });
	find(notes, "missing_translator_notes", { noteCount: 0 }, { minimumNotes: 1 }, "en");
	add("translator-note-present", "Copper torch").absent.push(
		"localization.missing_translator_notes"
	);
	translatedCase(
		"rich-tag-missing",
		"<Bold>North</>",
		"Norden",
		"rich_text_tags",
		{ tags: [], missing: ["Bold"], added: [] },
		{ tags: ["Bold"] }
	);
	translatedCase(
		"rich-tag-added",
		"Southern pier",
		"<Italic>Südpier</>",
		"rich_text_tags_added",
		{ tags: ["Italic"], added: ["Italic"] },
		{ tags: [] }
	);
	translatedCase(
		"rich-tag-case",
		"<Strong>East</>",
		"<strong>Ost</>",
		"rich_text_tag_case",
		{ changed: [{ source: "Strong", translation: "strong" }] },
		{ sameCase: true }
	);
	translatedCase(
		"line-break-missing",
		"Upper\nLower",
		"Oben Unten",
		"line_breaks",
		{ lineBreaks: 0 },
		{ lineBreaks: 1 }
	);
	translatedCase(
		"segment-missing",
		"Alpha//Beta",
		"Erste Zweite",
		"segment_separator",
		{ separator: "//", count: 0 },
		{ separator: "//", count: 1 }
	);

	for (const [name, nominal, side] of [
		["ratio-lower", 6, -1],
		["ratio-lower", 7, 0],
		["ratio-lower", 8, 1],
		["ratio-upper", 59, -1],
		["ratio-upper", 60, 0],
		["ratio-upper", 61, 1],
		["ratio-minimum-source", 4, 0]
	] as const) {
		const sourceUnits = name === "ratio-minimum-source" ? draw(15, 19) : draw(21, 39);
		const targetUnits =
			name === "ratio-lower"
				? side < 0
					? Math.floor(sourceUnits / 3) - 1
					: Math.ceil(sourceUnits / 3) + side
				: name === "ratio-upper"
					? sourceUnits * 3 + side
					: 4;
		const source = token(6, nominal) + "x".repeat(sourceUnits - 6);
		const text = add(`${name}-${nominal}`, source);
		translation(text, "d".repeat(targetUnits));
		text.parameters = { sourceUnits, targetUnits, side };
		if ((name === "ratio-lower" && side < 0) || (name === "ratio-upper" && side > 0))
			find(
				text,
				"length_outlier",
				{ length: targetUnits, ratio: Math.round((targetUnits / sourceUnits) * 100) / 100 },
				{ sourceLength: sourceUnits, minimumRatio: 0.33, maximumRatio: 3 }
			);
		else text.absent.push("localization.length_outlier");
	}
	for (const [nominal, forcedAstral] of [
		[38, false],
		[39, false],
		[40, false],
		[41, false],
		[39, true],
		[40, true]
	] as const) {
		const units = nominal === 38 ? draw(34, 38) : nominal === 41 ? draw(41, 47) : nominal;
		const astral = forcedAstral || draw(0, 1) === 1;
		const source =
			token(6, nominal + (forcedAstral ? 100 : 0)) +
			" " +
			(astral ? "🌊" : "") +
			"s".repeat(units - 7 - (astral ? 2 : 0));
		const text = add(`long-${nominal}${forcedAstral ? "-surrogate" : ""}`, source);
		text.parameters = { utf16Units: units, astral };
		if (units >= 40) signals(text, ["long"], ["up_to_date"]);
		else text.absent.push("signal.long");
	}

	const outdated = add("archive-old-source", "Open amber gate");
	outdated.cultures.de!.archiveSource = "Open wooden gate";
	state(outdated, "needs_update", ["translation"], ["de"]);
	find(
		outdated,
		"outdated_translation",
		{ translatedSource: "Open wooden gate" },
		{ source: outdated.source }
	);
	const endings = add("archive-line-endings", "Blue\nGreen");
	endings.cultures.de!.archiveSource = "Blue\r\nGreen";
	state(endings, "needs_update", ["translation"], ["de"]);
	find(
		endings,
		"source_line_endings_changed",
		{ translatedSource: "Blue\r\nGreen" },
		{ source: endings.source }
	);
	endings.absent.push("localization.outdated_translation");
	const placeholder = translatedCase(
		"placeholder-suppresses-ratio",
		"The bright harbor lantern",
		"TODO",
		"placeholder_translation",
		{ translation: "TODO" },
		{ translatedText: true }
	);
	placeholder.absent.push("localization.length_outlier");
	add("placeholder-lowercase-near", "Spanish todo").absent.push("localization.placeholder_text");
	const pending = add("placeholder-source", "TODO quest");
	find(
		pending,
		"placeholder_text",
		{ source: pending.source, matches: ["TODO"] },
		{ finalText: true },
		"en"
	);
	const spaces = add("source-double-space", "Twin  moons");
	find(
		spaces,
		"source_whitespace",
		{ source: spaces.source, leading: "", trailing: "", repeatedSpaces: 1 },
		{ trimmed: true },
		"en"
	);
	const markup = add("source-unbalanced-markup", "<Glow>Crystal");
	find(
		markup,
		"source_markup",
		{
			source: markup.source,
			richText: { opening: 1, closing: 0 },
			braces: { opening: 0, closing: 0 }
		},
		{ balanced: true },
		"en"
	);
	const number = add("number-only", "12345");
	translation(number, "12345");
	translation(number, "12345", "fr");
	find(number, "number_only_text", { source: number.source }, { cultureInvariant: true }, "en");
	add("number-with-letter-near", "12345m").absent.push("localization.number_only_text");

	const invariant = add(
		"culture-invariant",
		"Silent player label",
		{ mode: "invariant", namespace: "", key: "", gathered: false },
		rows
	);
	state(invariant, "unknown", ["finding", "unchecked"]);
	facts(invariant, ["not_translated", "unknown"]);
	signals(invariant, ["unresolved"], ["finding", "unchecked"]);
	for (const culture of corpusCultures)
		invariant.cultures[culture]!.unknownReasons = ["unresolved_identity"];
	find(
		invariant,
		"culture_invariant_text",
		{ source: invariant.source },
		{ localizable: true },
		"en"
	);
	add("package-namespace", "Editor package label", {}, rows);
	add("blueprint-variable", "Blueprint harbor label", {}, blueprint);
	const scaffold = add(
		"blueprint-empty-category",
		"",
		{
			mode: "scaffold",
			field: "NewVariables[0].Category",
			namespace: "",
			key: "",
			gathered: false
		},
		blueprint
	);
	state(scaffold, "unknown", ["unchecked"]);
	facts(scaffold, ["not_translated", "unknown"]);
	scaffold.signals = [];
	for (const culture of corpusCultures)
		scaffold.cultures[culture]!.unknownReasons = ["unresolved_identity"];
	const outsideBlueprint = pkg("blueprint", "OutsideTarget", "BP_OutsideTarget");
	const pin = add(
		"blueprint-pin",
		"Graph harbor label",
		{ kind: "blueprintPin", field: "TextToUpper_Corpus.InText", gathered: false },
		outsideBlueprint
	);
	state(pin, "outside_target", ["up_to_date"]);
	for (const culture of corpusCultures)
		pin.cultures[culture]!.facts = ["not_translated", "outside_target"];
	add("widget", "Widget harbor label", {}, widget);
	const compiled = add(
		"compiled-copy-differs",
		"Graph saved label",
		{
			compiledSource: "Graph older label",
			kind: "blueprintPin",
			field: "PrintText_Stale.InText"
		},
		blueprint
	);
	signals(compiled, ["compiled_copy_differs"], ["up_to_date"]);

	const ungathered = add("not-gathered", "Fresh ungathered lantern", { gathered: false });
	state(ungathered, "not_gathered", ["not_gathered"]);
	facts(ungathered, ["not_translated", "not_gathered"]);
	const changed = add("changed-since-gather", "Freshly painted boat", {
		manifestSource: "Old painted boat"
	});
	// Only the saved package changed. Keep the native archive at the gathered source so
	// NativeText does not independently invalidate every foreign archive's recorded source.
	translation(changed, changed.manifestSource, "en");
	state(changed, "changed_since_gather", ["changed_since_gather"]);
	facts(changed, ["translated", "changed_since_gather"]);
	const removed = add("not-found", "Removed harbor bell", { exists: false, kind: "manifest" });
	state(removed, "not_found", ["changed_since_gather"]);
	facts(removed, ["translated", "not_found"]);
	const missing = add("archive-missing-entry", "Untranslated harbor bell");
	missing.cultures.de!.archive = false;
	missing.cultures.de!.po = "";
	state(missing, "not_translated", ["translation"], ["de"]);
	find(
		missing,
		"empty_translation",
		{ entryExists: true, translation: "" },
		{ nonEmptyTranslation: true }
	);
	const unsynced = add("po-awaiting-import", "Waiting harbor bell");
	unsynced.cultures.de!.po = "Neue Hafenglocke";
	unsynced.cultures.de!.importPending = true;
	state(unsynced, "not_synced", ["translation"], ["de"]);
	facts(unsynced, ["translated", "not_synced"], ["de"]);
	const latest = add("po-latest-check", "Cargo {Slots}");
	translation(latest, "Fracht {Slots}");
	latest.cultures.de!.po = "Fracht";
	latest.cultures.de!.importPending = true;
	state(latest, "not_synced", ["translation"], ["de"]);
	facts(latest, ["translated", "not_synced"], ["de"]);
	find(
		latest,
		"format_arguments",
		{ arguments: [], missing: ["Slots"], added: [] },
		{ arguments: ["Slots"] }
	);

	// NativeText export/runtime uses the native archive translation as foreign source
	// (UE LocTextHelper.cpp:1197-1213, 1240-1252). Both sides omit foreign PO entries,
	// so archive source validity is isolated from import-pending/latest-PO behaviour.
	for (const near of [false, true]) {
		const nonce = token(6, near ? 821 : 820);
		const text = add(
			near ? "native-source-override-near" : "native-source-override",
			`Native ${nonce}`
		);
		const native = `Locale ${nonce}`;
		translation(text, native, "en");
		text.parameters = { nativeSource: native, foreignSource: near ? text.source : native };
		for (const culture of ["de", "fr", "ja"] as const) {
			const mark = text.cultures[culture]!;
			translation(
				text,
				`${culture === "de" ? "Brücke" : culture === "fr" ? "Rivage" : "岸辺"} ${nonce}`,
				culture
			);
			mark.expectedSource = native;
			mark.archiveSource = near ? text.source : native;
			mark.poEntry = false;
			if (near) {
				state(text, "needs_update", ["translation"], [culture]);
				find(
					text,
					"outdated_translation",
					{ translatedSource: text.source },
					{ source: native },
					culture
				);
			} else text.absent.push("localization.outdated_translation");
		}
	}

	const ambiguous = add("unknown-duplicate-archive", "Uncertain harbor bell");
	state(ambiguous, "unknown", ["unchecked"], ["de"]);
	ambiguous.cultures.de!.unknownReasons = ["duplicate_archive_identity"];

	// Same key across namespaces is independent. Within a table duplicate keys cannot coexist:
	// SetSourceString replaces an entry, so the plan records only its final source.
	const other = pkg("stringTable", "StringTables", "ST_Other");
	const first = add("same-key-other-namespace-a", "Azure sails", {
		key: `Same_${token(5, 700)}`
	});
	add("same-key-other-namespace-b", "Golden sails", { key: first.key }, other);
	const collisionTable = pkg("stringTable", "StringTables", "ST_Collision", table.tableNamespace);
	const collision = add("string-table-collision-a", "Collision sail", {
		key: `Collision_${token(5, 701)}`
	});
	const collisionB = add(
		"string-table-collision-b",
		collision.source,
		{ key: collision.key },
		collisionTable
	);
	const collisionEvidence = {
		tables: [
			`${table.path}.${table.name}`,
			`${collisionTable.path}.${collisionTable.name}`
		].sort(),
		tableCount: 2
	};
	for (const text of [collision, collisionB]) {
		signals(text, ["shared"]);
		find(text, "string_table_key_collision", collisionEvidence, { oneTablePerKey: true }, "en");
	}
	for (const [name, sources, sameKey] of [
		["shared-identity", ["Shared lantern", "Shared lantern"], true],
		["duplicate-source", ["Duplicate lantern", "Duplicate lantern"], false],
		["conflicting-identity", ["Conflict red", "Conflict blue"], true]
	] as const) {
		const a = add(`${name}-a`, sources[0], {}, rows);
		const b = add(
			`${name}-b`,
			sources[1],
			{ namespace: a.namespace, ...(sameKey ? { key: a.key } : undefined) },
			rows
		);
		for (const text of [a, b])
			signals(
				text,
				[
					sameKey ? "shared" : "duplicate_source",
					...(name === "conflicting-identity" ? ["conflicting"] : [])
				],
				name === "conflicting-identity"
					? ["conflicting_source", "finding", "unchecked"]
					: ["finding"]
			);
		if (name === "conflicting-identity")
			for (const text of [a, b]) {
				state(text, "unknown", ["conflicting_source", "finding", "unchecked"]);
				facts(text, ["translated", "unknown"]);
				for (const culture of corpusCultures)
					text.cultures[culture]!.unknownReasons = ["conflicting_source"];
			}
		if (!sameKey)
			find(
				a,
				"duplicate_source",
				{
					source: a.source,
					identityCount: 2,
					identities: [a, b].map(({ namespace, key }) => ({
						namespace: namespace.replace(/ ?\[[^\]]*\]$/u, ""),
						key
					}))
				},
				{ reviewDistinctKeys: true },
				"en"
			);
	}
	// Three translations give a strict majority; minority alone needs correction.
	const inconsistent = [0, 1, 2].map((i) =>
		add(`inconsistent-translation-${i}`, "Harbor keeper")
	);
	for (const text of inconsistent) {
		translation(text, "Hafenwart");
		signals(text, ["duplicate_source"]);
	}
	translation(inconsistent[2]!, "Hafenkapitän");
	find(
		inconsistent[0]!,
		"duplicate_source",
		{
			source: "Harbor keeper",
			identityCount: 3,
			identities: inconsistent.map(({ namespace, key }) => ({ namespace, key }))
		},
		{ reviewDistinctKeys: true },
		"en"
	);
	find(
		inconsistent[2]!,
		"inconsistent_translation",
		{
			translation: "Hafenkapitän",
			variants: [
				{ translation: "Hafenwart", lines: 2 },
				{ translation: "Hafenkapitän", lines: 1 }
			],
			variantCount: 2
		},
		{ consistentTranslation: true }
	);

	// Word-count and minimum-length boundaries for consistency, with a literal two-to-one majority.
	for (const [name, source, eligible] of [
		["inconsistent-length-2", "Hi", false],
		["inconsistent-length-3", "Air", true],
		["inconsistent-length-4", "Sail", true],
		["inconsistent-words-3", "Alder beacon keeper", true],
		["inconsistent-words-4", "Alder beacon keeper waits", true],
		["inconsistent-words-5", "Fabled alder beacon keeper waits", false],
		["inconsistent-visible-words", "<Em> Brass Harbor Guard </>", true]
	] as const) {
		const group = [0, 1, 2].map((i) => add(`${name}-${i}`, source));
		const normal = name.endsWith("visible-words") ? "<Em> Hafenwart </>" : "Guter Hafenwart";
		const minority = name.endsWith("visible-words") ? "<Em> Hafenkapitän </>" : "Hafenkapitän";
		for (const text of group) {
			translation(text, normal);
			signals(text, ["duplicate_source"]);
		}
		translation(group[2]!, minority);
		find(
			group[0]!,
			"duplicate_source",
			{
				source,
				identityCount: 3,
				identities: group.map(({ namespace, key }) => ({ namespace, key }))
			},
			{ reviewDistinctKeys: true },
			"en"
		);
		if (eligible)
			find(
				group[2]!,
				"inconsistent_translation",
				{
					translation: minority,
					variants: [
						{ translation: normal, lines: 2 },
						{ translation: minority, lines: 1 }
					],
					variantCount: 2
				},
				{ consistentTranslation: true }
			);
		else for (const text of group) text.absent.push("localization.inconsistent_translation");
	}
	for (const length of [23, 24, 25]) {
		const size = length === 23 ? draw(18, 23) : length === 25 ? draw(25, 32) : 24;
		const text = add(`placeholder-maximum-${length}`, `Harbor keeper ${length}`);
		text.parameters = { targetUnits: size };
		translation(text, ".".repeat(size));
		if (size <= 24)
			find(
				text,
				"placeholder_translation",
				{ translation: ".".repeat(size) },
				{ translatedText: true }
			);
		else text.absent.push("localization.placeholder_translation");
	}
	for (const [words, source] of [
		[2, "<Em> Alder Beacon </>"],
		[3, "<Em> Alder Beacon Keeper </>"],
		[4, "Alder Beacon Keeper Awaits"]
	] as const) {
		const text = add(`placeholder-visible-words-${words}`, source);
		translation(text, "...");
		if (words >= 3)
			find(text, "placeholder_translation", { translation: "..." }, { translatedText: true });
		else text.absent.push("localization.placeholder_translation");
		if (words < 4)
			find(
				text,
				"rich_text_tags",
				{ tags: [], missing: ["Em"], added: [] },
				{ tags: ["Em"] }
			);
		text.absent.push("localization.length_outlier");
	}
	const crossA = add("conflict-across-tables-a", "Crimson cart", { key: "CrossConflict" });
	const crossB = add(
		"conflict-across-tables-b",
		"Indigo cart",
		{ namespace: crossA.namespace, key: crossA.key },
		collisionTable
	);
	for (const text of [crossA, crossB]) {
		find(text, "string_table_key_collision", collisionEvidence, { oneTablePerKey: true }, "en");
		signals(text, ["shared", "conflicting"], ["conflicting_source", "finding", "unchecked"]);
		state(text, "unknown", ["conflicting_source", "finding", "unchecked"]);
		facts(text, ["translated", "unknown"]);
		for (const culture of corpusCultures)
			text.cultures[culture]!.unknownReasons = ["conflicting_source"];
	}

	for (const [name, tablePath, tableKey] of [
		["reference-resolved", `${table.path}.${table.name}`, first.key],
		["reference-missing-key", `${table.path}.${table.name}`, `Absent_${token(6, 702)}`],
		[
			"reference-missing-table",
			`${root}/StringTables/ST_Missing_${token(4, 703)}.ST_Missing_${token(4, 703)}`,
			`Absent_${token(6, 704)}`
		]
	] as const) {
		const text = add(
			name,
			name === "reference-resolved" ? first.source : "",
			{
				mode: "reference",
				table: tablePath,
				tableKey,
				namespace: name === "reference-resolved" ? first.namespace : "",
				key: tableKey,
				gathered: false
			},
			rows
		);
		if (name === "reference-resolved") {
			text.gathered = true;
			signals(first, ["shared"]);
			signals(text, ["shared"]);
			for (const culture of corpusCultures)
				text.cultures[culture] = structuredClone(first.cultures[culture]!);
		} else {
			state(text, "unknown", ["unchecked"]);
			facts(text, ["not_translated", "unknown"]);
			for (const culture of corpusCultures)
				text.cultures[culture]!.unknownReasons = [
					name === "reference-missing-key"
						? "string_table_entry_missing"
						: "string_table_namespace_unavailable"
				];
		}
	}

	for (const subject of ["source", "translation"] as const)
		for (const kind of ["pattern", "length", "forbidden_term"] as const) {
			const id = `corpus.${subject}.${kind}`;
			const name = `custom-${subject}-${kind}`;
			const text = add(name, kind === "length" ? "Budget phrase" : `Safe ${subject} ${kind}`);
			const near = add(
				`${name}-near`,
				kind === "length" ? `${subject[0]}bcdefghijklmnop` : `${subject[0]} near ${kind}`
			);
			const size = draw(17, 19);
			text.parameters = { characterCount: size };
			const value =
				kind === "length"
					? "abcdefghijklmnop" + "q".repeat(size - 16)
					: `Use bannedword ${kind[0]}`;
			if (subject === "source") {
				text.source = value;
				text.manifestSource = value;
				for (const culture of corpusCultures) {
					translation(text, value, culture);
					text.cultures[culture]!.archiveSource = value;
				}
			} else translation(text, value);
			const scope = {
				pathPrefixes: [table.path],
				cultures: subject === "source" ? ["en"] : ["de"],
				// Each check gets its own role, so another deliberately planted custom case is untouched.
				roles: [name]
			};
			customChecks.push({
				id,
				label: name,
				subject,
				kind,
				scope,
				recovery: "Review the planted case.",
				...(kind === "pattern"
					? { pattern: "bannedword", report: "match" }
					: kind === "length"
						? { measure: "characters", maximum: 16 }
						: { terms: ["bannedword"], caseSensitive: true })
			});
			const evidence =
				kind === "length"
					? { text: value, length: size }
					: { text: value, matches: [{ match: "bannedword", start: 4, end: 14 }] };
			const expectation =
				kind === "pattern"
					? { pattern: "bannedword", report: "match" }
					: kind === "length"
						? { measure: "characters", maximum: 16 }
						: { terms: ["bannedword"] };
			text.cultures[subject === "source" ? "en" : "de"]!.findings.push(
				F(id, evidence, expectation)
			);
			near.absent.push(id);
			role(name, [text, near]);
		}
	// The same astral source has 17 UTF-16 units, 16 code points and 16 visible characters.
	// These three contracts intentionally use different units.
	for (const [suffix, value, points, units] of [
		["astral", "abcdefghijklmno🌊", 16, 17],
		["combining", "abcdefghijklmno\u0301", 16, 16],
		["markup", "<Em>abcdefghijklmnop</>", 16, 23]
	] as const) {
		const text = add(`measure-${suffix}`, value);
		const sourceId = `corpus.measure.${suffix}.budget`;
		if (units > 16) {
			sourceRules.push({
				id: sourceId,
				kind: "character_budget",
				role: role(sourceId, [text]),
				maximumCharacters: 16,
				recovery: "Review the budget."
			});
			text.cultures.en!.findings.push(
				F(
					sourceId,
					{ kind: "character_count", characterCount: units, source: value },
					{ kind: "maximum_characters", maximumCharacters: 16 }
				)
			);
		}
		const id = `corpus.measure.${suffix}.visible`;
		customChecks.push({
			id,
			kind: "length",
			label: id,
			subject: "source",
			measure: "visible",
			minimum: 17,
			scope: { roles: [role(id, [text])] },
			recovery: "Review the visible count."
		});
		text.cultures.en!.findings.push(
			F(id, { text: value, length: points }, { measure: "visible", minimum: 17 })
		);
		const codepointId = `corpus.measure.${suffix}.points`;
		customChecks.push({
			id: codepointId,
			kind: "length",
			label: codepointId,
			subject: "source",
			measure: "characters",
			maximum: 16,
			scope: { roles: [role(codepointId, [text])] },
			recovery: "Review code points."
		});
		if (suffix === "markup")
			text.cultures.en!.findings.push(
				F(codepointId, { text: value, length: 23 }, { measure: "characters", maximum: 16 })
			);
	}
	for (const length of [4, 5, 6]) {
		const sourceUnits = 20 + 4 * draw(0, 4),
			targetUnits = sourceUnits / 4 + length - 5;
		const text = add(
			`compact-ratio-${length}`,
			token(6, 500 + length) + "c".repeat(sourceUnits - 6)
		);
		text.parameters = { sourceUnits, targetUnits };
		translation(text, "j".repeat(targetUnits), "ja");
		if (length === 4)
			find(
				text,
				"length_outlier",
				{ length: targetUnits, ratio: Math.round((targetUnits / sourceUnits) * 100) / 100 },
				{ sourceLength: sourceUnits, minimumRatio: 0.25, maximumRatio: 3 },
				"ja"
			);
	}

	for (const [name, space] of [
		["nbsp", "\u00a0"],
		["ideographic", "\u3000"]
	] as const) {
		const text = add(`whitespace-set-${name}`, `${space}Boundary ${name}`);
		find(
			text,
			"source_whitespace",
			{ source: text.source, leading: space, trailing: "", repeatedSpaces: 0 },
			{ trimmed: true },
			"en"
		);
		if (name === "ideographic")
			for (const culture of corpusCultures)
				find(
					text,
					"whitespace",
					{ leading: space, trailing: "", lineBreaks: 0 },
					{ leading: space, trailing: "", lineBreaks: 0 },
					culture
				);
		else text.absent.push("localization.whitespace");
	}
	const edgeEmpty = add("empty-with-source-edge", " Edge empty");
	// An empty target translation suppresses shape findings; the noted source still gets its own check.
	translation(edgeEmpty, "", "de");
	state(edgeEmpty, "not_translated", ["translation"], ["de"]);
	find(
		edgeEmpty,
		"source_whitespace",
		{ source: edgeEmpty.source, leading: " ", trailing: "", repeatedSpaces: 0 },
		{ trimmed: true },
		"en"
	);
	find(
		edgeEmpty,
		"empty_translation",
		{ entryExists: true, translation: "" },
		{ nonEmptyTranslation: true }
	);
	for (const culture of ["en", "fr", "ja"])
		find(
			edgeEmpty,
			"whitespace",
			{ leading: " ", trailing: "", lineBreaks: 0 },
			{ leading: " ", trailing: "", lineBreaks: 0 },
			culture
		);
	edgeEmpty.absent.push("localization.length_outlier");
	const metadata = add("archive-metadata-only", "Metadata source", {
		manifestMetadata: { Context: "new" }
	});
	metadata.cultures.de!.archiveMetadata = { Context: "old" };
	state(metadata, "needs_update", ["translation"], ["de"]);
	find(
		metadata,
		"outdated_translation",
		{ translatedSource: metadata.source },
		{ source: metadata.source }
	);
	const multi = add("multiple-findings", "Loot {Item}");
	translation(multi, " Beute {Objet}");
	find(multi, "whitespace", { leading: " ", trailing: "", lineBreaks: 0 }, cleanSpace);
	find(
		multi,
		"format_argument_renamed",
		{ arguments: ["Objet"], renamed: [{ from: "Objet", to: "Item" }] },
		{ arguments: ["Item"] }
	);
	plantFix(multi, " Beute {Item}");
	multi.absent.push("localization.format_arguments");
	const notesOnly = add("manifest-notes-only", "Manifest context label", {}, rows);
	probes.push({ case: notesOnly.case, kind: "without-notes", culture: "en", expected: false });
	const staleResource = add("resource-not-compiled", "Fresh compiled source");
	translation(staleResource, "Neue Übersetzung");
	staleResource.cultures.de!.resourceTranslation = "Alte Übersetzung";
	staleResource.cultures.de!.compilePending = true;
	probes.push({
		case: "archive-missing-entry",
		kind: "line-page-problems",
		culture: "en",
		expected: ["up_to_date"]
	});
	for (const value of ["45678", "!!!"]) {
		const a = add(`duplicate-native-only-${value}-a`, value);
		const b = add(`duplicate-native-only-${value}-b`, value);
		for (const text of [a, b]) {
			signals(text, ["duplicate_source"]);
			text.absent.push("localization.duplicate_source");
			if (value === "45678")
				find(text, "number_only_text", { source: value }, { cultureInvariant: true }, "en");
		}
	}
	const gatheredOnly = [0, 1].map((index) =>
		add(`duplicate-quality-only-${index}`, "Gathered harbor", {
			exists: false,
			kind: "manifest",
			manifestPath: `Content/Localization/${target}/Corpus.cpp(${index + 1})`
		})
	);
	for (const text of gatheredOnly) {
		state(text, "gathered_only", ["up_to_date"]);
		facts(text, ["translated", "gathered_only"]);
	}
	find(
		gatheredOnly[0]!,
		"duplicate_source",
		{
			source: "Gathered harbor",
			identityCount: 2,
			identities: gatheredOnly.map(({ namespace, key }) => ({ namespace, key }))
		},
		{ reviewDistinctKeys: true },
		"en"
	);
	add("string-table-replacement", "Final harbor cart", {
		previousSource: "Earlier harbor cart",
		key: "Replacement"
	});
	for (const [name, value] of [
		["cjk", "赤青緑"],
		["nbsp", "one\u00a0two"],
		["ideographic", "one\u3000two"],
		["markup", "<Em> one two </>"]
	] as const) {
		const text = add(`words-${name}`, value);
		probes.push({
			case: text.case,
			kind: "word-count",
			culture: "en",
			expected: name === "cjk" ? 1 : name === "markup" ? 4 : 2
		});
		probes.push({
			case: text.case,
			kind: "localization-word-count",
			culture: "en",
			expected: {
				status: "counted",
				words: name === "cjk" ? 3 : name === "nbsp" ? 1 : name === "markup" ? 5 : 2
			}
		});
	}
	for (const kind of ["source", "translation"] as const) {
		const id = `corpus.policy.${kind}.budget`;
		const a = add(
			`policy-${kind}-budget-over`,
			kind === "source" ? "Budget ABCDEFGHIJ" : "Target budget"
		);
		const b = add(
			`policy-${kind}-budget-at`,
			kind === "source" ? "Budget ABCDEFGHI" : "Target near budget"
		);
		const scope = role(id, [a, b]);
		if (kind === "source") {
			sourceRules.push({
				id,
				kind: "character_budget",
				maximumCharacters: 16,
				role: scope,
				recovery: "Shorten the source."
			});
			a.cultures.en!.findings.push(
				F(
					id,
					{ kind: "character_count", source: a.source, characterCount: 17 },
					{ kind: "maximum_characters", maximumCharacters: 16 }
				)
			);
		} else {
			translation(a, "abcdefghijklmnopq");
			translation(b, "abcdefghijklmnop");
			localizationRules.push({
				id,
				kind: "localization_character_budget",
				cultures: { de: 16 },
				role: scope,
				recovery: "Shorten the translation."
			});
			a.cultures.de!.findings.push(
				F(
					id,
					{
						kind: "character_count",
						translation: "abcdefghijklmnopq",
						characterCount: 17
					},
					{ kind: "maximum_characters", maximumCharacters: 16 }
				)
			);
		}
		const termId = `corpus.policy.${kind}.terms`;
		const term = add(
			`policy-${kind}-terms`,
			kind === "source" ? "Old obsolete term" : "Term policy source"
		);
		const termRole = role(termId, [term]);
		const value = kind === "source" ? term.source : "Wort obsolete hier";
		if (kind === "source")
			sourceRules.push({
				id: termId,
				kind: "terminology",
				role: termRole,
				terms: [{ kind: "forbidden", term: "obsolete" }],
				caseSensitive: true,
				recovery: "Use the current term."
			});
		else {
			translation(term, value);
			localizationRules.push({
				id: termId,
				kind: "localization_terminology",
				role: termRole,
				cultures: { de: [{ kind: "forbidden", term: "obsolete" }] },
				caseSensitive: true,
				recovery: "Use the current term."
			});
		}
		term.cultures[kind === "source" ? "en" : "de"]!.findings.push(
			F(
				termId,
				{
					kind: "terminology_match",
					...(kind === "source" ? { source: value } : { translation: value }),
					start: kind === "source" ? 4 : 5,
					end: kind === "source" ? 12 : 13,
					term: "obsolete"
				},
				{ kind: "forbidden_term", term: "obsolete" }
			)
		);
	}
	const renamedKey = add("key-changed-new", "Renamed harbor door", {
		key: "RepairNew",
		gathered: false
	});
	const oldKey = add("key-changed-old", renamedKey.source, {
		key: "RepairOld",
		exists: false,
		kind: "manifest"
	});
	state(renamedKey, "not_gathered", ["key_changed", "not_gathered"]);
	facts(renamedKey, ["not_translated", "not_gathered"]);
	state(oldKey, "not_found", ["changed_since_gather"]);
	facts(oldKey, ["translated", "not_found"]);
	find(
		renamedKey,
		"duplicate_source",
		{
			source: renamedKey.source,
			identityCount: 2,
			identities: [renamedKey, oldKey].map(({ namespace, key }) => ({ namespace, key }))
		},
		{ reviewDistinctKeys: true },
		"en"
	);
	const incrementalTable = pkg("dataTable", "DataTables", "DT_Incremental");
	const incrementalA = add(
		"incremental-conflict-a",
		"Incremental amber gate",
		{},
		incrementalTable
	);
	const incrementalB = add(
		"incremental-conflict-b",
		"Incremental silver gate",
		{ key: incrementalA.key },
		incrementalTable
	);
	for (const text of [incrementalA, incrementalB]) {
		signals(text, ["shared", "conflicting"], ["conflicting_source", "finding", "unchecked"]);
		state(text, "unknown", ["conflicting_source", "finding", "unchecked"]);
		facts(text, ["translated", "unknown"]);
		for (const culture of corpusCultures)
			text.cultures[culture]!.unknownReasons = ["conflicting_source"];
	}

	return finish();
}

/** A projection of planted records, not an evaluator of text or rules. */
export function deriveCorpusExpectations({
	packages,
	seed,
	root,
	target
}: Pick<CorpusPlan, "packages" | "seed" | "root" | "target">): CorpusExpectations {
	const declarations = new Map<string, PlannedText>();
	const identity = (text: PlannedText) =>
		JSON.stringify([text.namespace.replace(/ ?\[[^\]]*\]$/u, ""), text.key]);
	for (const owner of packages)
		for (const text of owner.texts)
			if (text.gathered && text.mode === "text" && !declarations.has(identity(text)))
				declarations.set(identity(text), text);
	const subjects: CorpusSubject[] = packages.flatMap((owner) =>
		owner.texts.flatMap((text) =>
			corpusCultures.map((culture) => {
				const { state, facts, unknownReasons, problems, findings } =
					text.cultures[culture]!;
				const declaration =
					text.mode === "invariant" || text.mode === "scaffold"
						? undefined
						: declarations.get(identity(text));
				const written = declaration?.cultures[culture];
				const compiled =
					declaration &&
					written?.archive &&
					written.translation &&
					written.archiveSource === written.expectedSource &&
					JSON.stringify(written.archiveMetadata) ===
						JSON.stringify(declaration.manifestMetadata)
						? written.resourceTranslation || written.translation
						: null;
				return {
					case: text.case,
					packagePath: owner.path,
					namespace: text.namespace,
					key: text.key,
					kind: text.kind,
					field: text.field,
					source: text.source,
					gatheredSource: declaration?.manifestSource ?? null,
					culture,
					state,
					facts,
					unknownReasons,
					problems,
					findings,
					signals: text.signals,
					absent: text.absent,
					stages: {
						po: written?.poEntry ? written.po : null,
						archive: written?.archive ? written.translation : null,
						compiled,
						importPending: written?.importPending ?? false,
						compilePending: written?.compilePending ?? false
					}
				};
			})
		)
	);
	const expectations: CorpusExpectations = {
		format: "ue-shed-game-text-corpus-expectations",
		version: 1,
		seed,
		lines: packages.reduce((total, owner) => total + owner.texts.length, 0),
		root,
		target,
		cultures: [...corpusCultures],
		subjects,
		counts: findingCounts(subjects),
		findingFixes: true,
		notExposedYet: corpusNotExposedYet
	};
	return expectations;
}

/** Small deterministic constructor stream. Never measures or parses a rule's input. */
function draws(seed: number) {
	let value = seed >>> 0;
	const integer = (low: number, high: number) => {
		value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
		return low + ((value >>> 8) % (high - low + 1));
	};
	return {
		integer,
		pick: <T>(values: readonly T[]) => values[integer(0, values.length - 1)]!,
		shuffle: <T>(values: T[]) => {
			for (let i = values.length - 1; i > 0; i--) {
				const j = integer(0, i);
				[values[i], values[j]] = [values[j]!, values[i]!];
			}
			return values;
		},
		guid: () =>
			Array.from({ length: 4 }, () => integer(0, 0xffffff).toString(16).padStart(8, "0"))
				.join("")
				.toUpperCase()
	};
}

/** Literal construction slots. Keeping their declared width preserves offsets and syntax. */
const wordSlots = [
	"Cargo",
	"Lantern",
	"Keeper",
	"bird",
	"Harbor",
	"River",
	"Silver",
	"Relic",
	"Amber",
	"Copper",
	"North",
	"Southern",
	"East",
	"Upper",
	"Lower",
	"Alpha",
	"Open",
	"Close",
	"Blue",
	"The",
	"Spanish",
	"quest",
	"Twin",
	"Crystal",
	"Fresh",
	"Freshly",
	"Removed",
	"Untranslated",
	"Waiting",
	"Uncertain",
	"Azure",
	"Collision",
	"Hi",
	"Air",
	"Sail",
	"Alder",
	"Fabled",
	"Brass",
	"Crimson",
	"Use",
	"Safe",
	"Budget",
	"abcdef",
	"Compact",
	"Boundary",
	"Edge",
	"Metadata",
	"Loot",
	"Gathered",
	"Final",
	"near",
	"Old",
	"Target",
	"Term",
	"Renamed",
	"Silent",
	"Editor",
	"Shared",
	"Duplicate",
	"Conflict",
	"Manifest",
	"Blueprint",
	"Graph",
	"Widget",
	"Golden",
	"Indigo",
	"Incremental"
] as const;

function instantiate(batch: CorpusPlan, instance: number, seed: number) {
	const random = draws(seed);
	const alphabet = "abcdefghijklmnopqrstuvwxyz";
	const literal = (width: number, slot: number) =>
		alphabet[(slot + seed) % 26]! +
		(width > 1 ? alphabet[instance % 26]! : "") +
		Array.from({ length: Math.max(0, width - 2) }, () => random.pick([...alphabet])).join("");
	const substitutions: [string, string][] = wordSlots.map((word, slot) => [
		word,
		literal(word.length, slot)
	]);
	// Argument/tag slots have fixed widths: modifier offsets and markup budget evidence stay exact.
	for (const [slot, width] of [
		["Count", 5],
		["Name", 4],
		["Nom", 3],
		["Item", 4],
		["Objet", 5],
		["Slots", 5],
		["Extra", 5],
		["Em", 2],
		["Bold", 4],
		["Italic", 6],
		["Strong", 6],
		["Glow", 4],
		["bannedword", 10],
		["obsolete", 8]
	] as const)
		substitutions.push([slot, literal(width, substitutions.length)]);
	const strong = substitutions.find(([word]) => word === "Strong")!;
	strong[1] = strong[1][0]!.toUpperCase() + strong[1].slice(1);
	const lowerStrong = strong[1].toLowerCase();
	substitutions.push(["strong", lowerStrong]);
	substitutions.push(
		["12345", String(10000 + (seed % 800) * 10 + instance)],
		["45678", String(50000 + (seed % 800) * 10 + instance)]
	);
	const punctuation = ["!", "?", "#", "."];
	substitutions.push([
		"!!!",
		punctuation[instance % 4]! +
			punctuation[Math.floor(instance / 4) % 4]! +
			punctuation[seed % 4]!
	]);
	substitutions.push([
		"赤青緑",
		String.fromCharCode(0x4e00 + instance, 0x5000 + (seed % 100), 0x5100 + (seed % 100))
	]);
	substitutions.unshift(
		["sbcdefghijklmnop", literal(16, 84)],
		["tbcdefghijklmnop", literal(16, 85)]
	);
	substitutions.unshift(
		["one\u00a0two", literal(3, 80) + "\u00a0two"],
		["one\u3000two", literal(3, 81) + "\u3000two"]
	);
	const swapCultures = random.integer(0, 1) === 1;
	// A single substitution pass over authored literals; this is not a tokenizer or measurement.
	const substitute = (text: string) => {
		if (text.startsWith("/Game/") || text.startsWith("Corpus.")) return text;
		let output = text;
		// Protect replacements so one constructor slot cannot rewrite another slot's drawn value.
		for (let i = 0; i < substitutions.length; i++)
			output = output.replaceAll(substitutions[i]![0], `\0${i}\0`);
		for (let i = 0; i < substitutions.length; i++)
			output = output.replaceAll(`\0${i}\0`, substitutions[i]![1]);
		return swapCultures && output === "de"
			? "fr"
			: swapCultures && output === "fr"
				? "de"
				: output;
	};

	const transform = (value: typeof Schema.Json.Type): typeof Schema.Json.Type =>
		Array.isArray(value)
			? value.map(transform)
			: Schema.is(Schema.Record(Schema.String, Schema.Json))(value)
				? Object.fromEntries(
						Object.entries(value).map(([key, item]) => [
							swapCultures && key === "de"
								? "fr"
								: swapCultures && key === "fr"
									? "de"
									: key,
							[
								"case",
								"kind",
								"key",
								"tableKey",
								"namespace",
								"table",
								"path",
								"folder",
								"field",
								"packageNamespace",
								"persistentGuid",
								"target",
								"root",
								"name",
								"tableNamespace",
								"manifestPath"
							].includes(key)
								? item
								: transform(item)
						])
					)
				: Schema.is(Schema.String)(value)
					? substitute(value)
					: value;
	// Every textual change is applied to both the construction and its literal evidence.
	const result = transform(Schema.decodeUnknownSync(Schema.Json)(batch));
	// SAFETY: the wire schema has validated all fields; the owned clone makes its arrays mutable for placement.
	const plan = structuredClone(Schema.decodeUnknownSync(CorpusPlanSchema)(result)) as CorpusPlan;
	for (const owner of plan.packages)
		for (const text of owner.texts) {
			text.case += `@${instance}`;
			text.parameters = {
				...text.parameters,
				instance,
				translationCulture: swapCultures ? "fr" : "de"
			};
		}
	for (const probe of plan.probes) probe.case += `@${instance}`;
	return plan;
}

const kinds = [
	"stringTableEntry",
	"dataTableCell",
	"blueprintVariable",
	"blueprintPin",
	"widgetText"
] as const;
const packageKind = (kind: CorpusSourceKind) =>
	kind === "stringTableEntry"
		? "stringTable"
		: kind === "dataTableCell"
			? "dataTable"
			: kind === "widgetText"
				? "widgetBlueprint"
				: "blueprint";

/** Background is assembled from format-preserving slots, with declared widths below 39 units. */
function backgroundText(
	id: number,
	seed: number,
	kind: CorpusSourceKind,
	random: ReturnType<typeof draws>,
	template = random.integer(0, 5)
): PlannedText {
	const token = `b${seed.toString(36)}x${id.toString(36).padStart(5, "0")}`;
	const padding = "r".repeat(random.integer(0, 2));
	// The largest constructor is <Em> + four-letter stem + token + </>, under 35 units.
	const stem = { en: "Cove", de: "Bucht", fr: "Rive", ja: "岸辺" };
	const render = (culture: keyof typeof stem) =>
		template === 0
			? `${stem[culture]} ${token}${padding}`
			: template === 1
				? `${stem[culture]} ${token}${padding} {N}`
				: template === 2
					? `<Em>${stem[culture]} ${token}${padding}</>`
					: template === 3
						? `${stem[culture]}\n${token}${padding}`
						: template === 4
							? `${culture === "en" ? "Café" : culture === "de" ? "Höhe" : culture === "fr" ? "Îlot" : "海岸"} ${token}${padding}`
							: `${culture === "en" ? "赤青" : culture === "de" ? "緑白" : culture === "fr" ? "紫黒" : "金銀"} ${token}${padding}`;
	const source = render("en");
	const cultures: Record<string, PlannedCulture> = {};
	for (const culture of corpusCultures)
		cultures[culture] = {
			translation: render(culture),
			expectedSource: source,
			archiveSource: source,
			archiveMetadata: {},
			resourceTranslation: "",
			importPending: false,
			compilePending: false,
			po: render(culture),
			poEntry: true,
			archive: true,
			state: "translated",
			facts: ["translated"],
			unknownReasons: [],
			problems: ["up_to_date"],
			findings: []
		};
	return {
		case: "background",
		instance: -1,
		parameters: { template, token, padding },
		kind,
		field: "",
		namespace: "",
		key: `BG${id}`,
		source,
		notes: `Background ${token}.`,
		mode: "text",
		table: "",
		tableKey: "",
		manifestSource: source,
		gathered: true,
		exists: true,
		compiledSource: "",
		previousSource: "",
		manifestMetadata: {},
		manifestPath: "",
		signals: [],
		absent: [],
		cultures
	};
}

/** Semantic edits are drawn independently after initial placement, so both phases share identities. */
function editPlan(plan: CorpusPlan, random: ReturnType<typeof draws>) {
	const candidates = plan.packages.flatMap((owner) =>
		owner.texts
			.filter(
				(text) =>
					text.case === "background" &&
					text.parameters.template === 0 &&
					owner.kind === "dataTable"
			)
			.map((text) => ({ owner, text }))
	);
	if (candidates.length < 3) {
		// A small corpus has too little plain DataTable background, so it gets its own edit probe and
		// still plants every edit kind.
		const probe: PlannedPackage = {
			kind: "dataTable",
			name: "EditProbe",
			folder: "Edits",
			path: `${plan.root}/Edits/EditProbe`,
			packageNamespace: random.guid(),
			persistentGuid: random.guid(),
			tableNamespace: "Corpus.EditProbe",
			texts: []
		};
		for (let i = candidates.length; i < 3; i++) {
			const text = backgroundText(1_000_000 + i, plan.seed, "dataTableCell", random, 0);
			text.field = `${text.key}.DisplayName`;
			text.namespace = `[${probe.packageNamespace}]`;
			probe.texts.push(text);
			candidates.push({ owner: probe, text });
		}
		plan.packages.push(probe);
	}
	random.shuffle(candidates);
	const sourceEdit = candidates[0]!,
		poEdit = candidates[1]!,
		archiveEdit = candidates[2]!;
	const culture = random.pick(["de", "fr", "ja"]);
	const register = (kind: string, owner: PlannedPackage, text: PlannedText, value: string) => {
		plan.edits.operations.push({ kind, subject: `${owner.path}:${text.key}`, value });
		if (!plan.edits.packages.includes(owner.path)) plan.edits.packages.push(owner.path);
	};
	const newSource = `Reef ${sourceEdit.text.parameters.token}`;
	register("source", sourceEdit.owner, sourceEdit.text, newSource);
	register("po", poEdit.owner, poEdit.text, `Import ${poEdit.text.parameters.token}`);
	register(
		"archive",
		archiveEdit.owner,
		archiveEdit.text,
		`Archiv ${archiveEdit.text.parameters.token}`
	);
	if (plan.phase === "after") {
		sourceEdit.text.case = "edit-source";
		sourceEdit.text.source = newSource;
		for (const mark of Object.values(sourceEdit.text.cultures)) {
			mark.state = "changed_since_gather";
			mark.facts = ["translated", "changed_since_gather"];
			mark.problems = ["changed_since_gather"];
		}
		poEdit.text.case = "edit-po";
		const po = poEdit.text.cultures[culture]!;
		po.po = `Import ${poEdit.text.parameters.token}`;
		po.importPending = true;
		po.state = "not_synced";
		po.facts = ["translated", "not_synced"];
		po.problems = ["translation"];
		archiveEdit.text.case = "edit-archive";
		const archive = archiveEdit.text.cultures[culture]!;
		archive.resourceTranslation = archive.translation;
		archive.translation = `Archiv ${archiveEdit.text.parameters.token}`;
		archive.importPending = true;
		archive.compilePending = true;
		archive.state = "not_synced";
		archive.facts = ["translated", "not_synced"];
		archive.problems = ["translation"];
	}
	let deletion = random.pick(
		plan.packages.filter(
			(owner) =>
				owner.kind === "dataTable" &&
				owner.texts.every((text) => text.case === "background") &&
				!plan.edits.packages.includes(owner.path)
		)
	);
	if (!deletion) {
		deletion = {
			kind: "dataTable",
			name: "DeleteProbe",
			folder: "Edits",
			path: `${plan.root}/Edits/DeleteProbe`,
			packageNamespace: random.guid(),
			persistentGuid: random.guid(),
			tableNamespace: "Corpus.DeleteProbe",
			texts: []
		};
		const text = backgroundText(1_050_000, plan.seed, "dataTableCell", random);
		text.field = `${text.key}.DisplayName`;
		text.namespace = `[${deletion.packageNamespace}]`;
		deletion.texts.push(text);
		plan.packages.push(deletion);
	}

	plan.edits.deletedPackages.push(deletion.path);
	plan.edits.operations.push({ kind: "delete_package", subject: deletion.path, value: "" });
	if (plan.phase === "after")
		for (const text of deletion.texts) {
			text.exists = false;
			text.case = "edit-deleted-package";
			for (const mark of Object.values(text.cultures)) {
				mark.state = "not_found";
				mark.facts = ["translated", "not_found"];
				mark.problems = ["changed_since_gather"];
			}
		}
	const kind = random.pick(["stringTableEntry", "dataTableCell"] as const),
		name = `Added_${random.integer(1000, 9999)}`;
	const owner: PlannedPackage = {
		kind: packageKind(kind),
		name,
		folder: "Edits",
		path: `${plan.root}/Edits/${name}`,
		packageNamespace: random.guid(),
		persistentGuid: random.guid(),
		tableNamespace: `Corpus.${name}`,
		texts: []
	};
	plan.edits.packages.push(owner.path);
	plan.edits.operations.push({ kind: "add_package", subject: owner.path, value: kind });
	const count = random.integer(1, 4);
	if (plan.phase === "after") {
		for (let i = 0; i < count; i++) {
			const text = backgroundText(1_100_000 + i, plan.seed, kind, random);
			text.case = "edit-added-package";
			text.gathered = false;
			text.namespace =
				kind === "stringTableEntry" ? owner.tableNamespace : `[${owner.packageNamespace}]`;
			text.field = kind === "stringTableEntry" ? text.key : `${text.key}.DisplayName`;
			if (kind === "dataTableCell") {
				text.notes = "";
				text.cultures.en!.findings.push(
					builtin("missing_translator_notes", { noteCount: 0 }, { minimumNotes: 1 })
				);
			}
			for (const mark of Object.values(text.cultures)) {
				mark.state = "not_gathered";
				mark.facts = ["not_translated", "not_gathered"];
				mark.problems = ["not_gathered"];
			}
			owner.texts.push(text);
		}
		plan.packages.push(owner);
	}
	plan.edits.changedFiles = [...plan.edits.packages, ...plan.edits.deletedPackages].map(
		(path) => `Content/${path.slice(6)}.uasset`
	);
	plan.edits.changedFiles.push(
		...["de", "fr", "ja"].flatMap((code) => [
			`Content/Localization/${plan.target}/${code}/${plan.target}.archive`,
			`Content/Localization/${plan.target}/${code}/${plan.target}.po`
		])
	);
}

/** Every recipe instance has its own draws and identities; background and placement are interleaved. */
export function planCorpus({
	seed,
	lines,
	root,
	density = Math.max(2, Math.min(8, Math.ceil(lines / 2000))),
	scenario = "main",
	phase = "initial"
}: {
	seed: number;
	lines: number;
	root: string;
	density?: number | undefined;
	scenario?: "main" | "collapse";
	phase?: "initial" | "after";
}): CorpusPlan {
	if (!Number.isInteger(density) || density < 1 || density > 12)
		throw new Error("Invalid density (1–12).");
	const random = draws(seed),
		batches: CorpusPlan[] = [];
	for (let instance = 0; instance < (scenario === "collapse" ? 1 : density); instance++) {
		const batch = recipeBatch({
			seed: (seed + instance * 104729) % 2_147_483_648,
			lines: 1,
			root: `${root}/Instances/I${instance}`,
			scenario,
			instance
		});
		const variation = instantiate(batch, instance, seed + instance * 104729);
		for (const owner of variation.packages)
			owner.folder = `Instances/I${instance}/${owner.folder}`;
		batches.push(variation);
	}
	const first = batches[0]!;
	const plan: CorpusPlan = {
		...first,
		root,
		seed,
		phase,
		density,
		requestedLines: lines,
		cultures: [...corpusCultures],
		packages: batches.flatMap((batch) => batch.packages),
		probes: batches.flatMap((batch) => batch.probes),
		edits: { packages: [], deletedPackages: [], changedFiles: [], operations: [] }
	};
	// Instance-scoped rules are composed explicitly; no global heuristic is introduced.
	const Rules = Schema.Struct({
		schemaVersion: Schema.Int,
		roles: Schema.Array(Schema.Json),
		rules: Schema.Array(Schema.Json),
		localizationRules: Schema.Array(Schema.Json),
		customChecks: Schema.Array(Schema.Json),
		checks: Schema.Json
	});
	const documents = batches.map((batch, i) => {
		const data = Schema.decodeUnknownSync(Rules)(batch.rules);
		const names = new Map<string, string>();
		for (const group of [data.roles, data.rules, data.localizationRules, data.customChecks])
			for (const item of group) {
				const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
					item
				);
				if (Schema.is(Schema.String)(record.id)) names.set(record.id, `${record.id}.i${i}`);
			}
		const replace = (value: typeof Schema.Json.Type): typeof Schema.Json.Type =>
			Array.isArray(value)
				? value.map(replace)
				: Schema.is(Schema.Record(Schema.String, Schema.Json))(value)
					? Object.fromEntries(
							Object.entries(value).map(([key, item]) => [key, replace(item)])
						)
					: Schema.is(Schema.String)(value)
						? (names.get(value) ?? value)
						: value;
		for (const owner of batches[i]!.packages)
			for (const text of owner.texts) {
				for (const mark of Object.values(text.cultures))
					mark.findings = mark.findings.map((finding) => ({
						...finding,
						check: names.get(finding.check) ?? finding.check
					}));
				text.absent = text.absent.map((id) => names.get(id) ?? id);
			}
		return Schema.decodeUnknownSync(Rules)(
			replace(Schema.decodeUnknownSync(Schema.Json)(data))
		);
	});
	plan.rules = {
		schemaVersion: 3,
		roles: documents.flatMap((d) => d.roles),
		rules: documents.flatMap((d) => d.rules),
		localizationRules: documents.flatMap((d) => d.localizationRules),
		customChecks: documents.flatMap((d) => d.customChecks),
		checks: documents[0]!.checks
	};
	if (scenario === "main") {
		const pools = new Map<string, { owner: PlannedPackage; capacity: number }>();
		let serial = 0;
		const ownerFor = (kind: CorpusSourceKind) => {
			const type = packageKind(kind),
				pool = pools.get(type);
			if (pool && pool.owner.texts.length < pool.capacity) return pool.owner;
			const name = `${type === "stringTable" ? "ST" : type === "dataTable" ? "DT" : type === "blueprint" ? "BP" : "WBP"}_${serial++}`;
			const owner: PlannedPackage = {
				path: `${root}/Mixed/${name}`,
				folder: "Mixed",
				name,
				kind: type,
				packageNamespace: random.guid(),
				persistentGuid: random.guid(),
				tableNamespace: `Corpus.${name}`,
				texts: []
			};
			plan.packages.push(owner);
			pools.set(type, {
				owner,
				capacity:
					type === "stringTable"
						? random.integer(20, 60)
						: type === "dataTable"
							? random.integer(16, 50)
							: type === "blueprint"
								? Math.max(random.integer(4, 8), random.integer(4, 8))
								: random.integer(3, 10)
			});
			return owner;
		};
		const place = (text: PlannedText, owner: PlannedPackage) => {
			text.kind =
				owner.kind === "blueprint"
					? text.kind === "blueprintPin"
						? "blueprintPin"
						: "blueprintVariable"
					: owner.kind === "stringTable"
						? "stringTableEntry"
						: owner.kind === "dataTable"
							? "dataTableCell"
							: "widgetText";
			text.namespace =
				text.kind === "stringTableEntry"
					? owner.tableNamespace
					: `[${owner.packageNamespace}]`;
			text.field =
				text.kind === "dataTableCell"
					? `${text.key}.DisplayName`
					: text.kind === "blueprintPin"
						? `${text.case === "background" ? "TextToUpper" : "PrintText"}_${text.key}.InText`
						: text.key;
			owner.texts.push(text);
		};
		const original = plan.packages.slice(),
			moving: PlannedText[] = [];
		// The named scaffold recipe supplies the state for each editor-generated category.
		const categoryRecipe = original
			.flatMap((owner) => owner.texts)
			.find((text) => text.mode === "scaffold")!;
		for (const owner of original) {
			const identities = new Map<string, number>();
			for (const text of owner.texts)
				identities.set(text.key, (identities.get(text.key) ?? 0) + 1);
			owner.texts = owner.texts.filter((text) => {
				const recipe = text.case.split("@")[0]!;
				const movable =
					text.mode === "text" &&
					text.exists &&
					text.gathered &&
					!text.compiledSource &&
					!text.previousSource &&
					identities.get(text.key) === 1 &&
					!text.signals.some((signal) => signal !== "long") &&
					![
						"manifest-notes-only",
						"package-namespace",
						"blueprint-variable",
						"widget",
						"string-table-collision-a",
						"string-table-collision-b",
						"same-key-other-namespace-a",
						"same-key-other-namespace-b",
						"conflict-across-tables-a",
						"conflict-across-tables-b"
					].includes(recipe);
				if (movable) {
					moving.push(text);
					return false;
				}
				return text.mode !== "scaffold";
			});
		}
		const visible =
			plan.packages.reduce((count, owner) => count + owner.texts.length, 0) + moving.length;
		for (let i = visible; i < Math.max(lines, visible + 20); i++) {
			const kind = kinds[[0, 0, 0, 0, 1, 1, 1, 2, 3, 4][(i + seed) % 10]!]!;
			moving.push(backgroundText(i, seed, kind, random));
		}
		random.shuffle(moving);
		for (const text of moving) {
			if (text.case !== "background") text.kind = random.pick(kinds);
			const owner = ownerFor(text.kind);
			if (
				text.case.startsWith("custom-") ||
				text.case.startsWith("policy-") ||
				text.case.startsWith("measure-")
			) {
				const name = `Case_${serial++}`;
				const dedicated = {
					...owner,
					path: `${root}/Cases/${name}`,
					folder: "Cases",
					name,
					packageNamespace: random.guid(),
					persistentGuid: random.guid(),
					tableNamespace: `Corpus.${name}`,
					texts: []
				};
				plan.packages.push(dedicated);
				place(text, dedicated);
			} else place(text, owner);
		}
		// Regenerate role scopes from the selected saved places, including the authoring pin.
		const roleEntries = new Map(
			plan.packages.flatMap((owner) =>
				owner.texts.map((text) => [text.key, { owner, text }] as const)
			)
		);
		const record = {
			...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(plan.rules)
		};
		const roleValues = Schema.decodeUnknownSync(
			Schema.Array(
				Schema.Struct({
					id: Schema.String,
					scopes: Schema.Array(
						Schema.Struct({
							matchers: Schema.Array(
								Schema.Struct({
									kind: Schema.String,
									operator: Schema.optionalKey(Schema.String),
									value: Schema.String
								})
							)
						})
					)
				})
			)
		)(record.roles);
		record.roles = roleValues.map((role) => ({
			...role,
			scopes: role.scopes.map((scope) => {
				const found = roleEntries.get(scope.matchers[0]!.value)!;
				return {
					matchers: [
						{ kind: "object_path", operator: "prefix", value: found.owner.path + "." }
					]
				};
			})
		}));
		const checks = Schema.decodeUnknownSync(
			Schema.Array(Schema.Record(Schema.String, Schema.Json))
		)(record.customChecks);
		record.customChecks = checks.map((check) => {
			const scope = {
				...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(check.scope)
			};
			delete scope.pathPrefixes;
			return { ...check, scope };
		});
		plan.rules = record;

		for (const owner of plan.packages) {
			random.shuffle(owner.texts);
			const variables = owner.texts.filter((text) => text.kind === "blueprintVariable");
			for (let i = 0; i < variables.length; i++) {
				const scaffold = structuredClone(variables[i]!);
				scaffold.case = `blueprint-empty-category@${variables[i]!.key}`;
				scaffold.mode = "scaffold";
				scaffold.field = `NewVariables[${i}].Category`;
				scaffold.source = "";
				scaffold.manifestSource = "";
				scaffold.key = "";
				scaffold.namespace = "";
				scaffold.gathered = false;
				scaffold.signals = [];
				scaffold.absent = [];
				scaffold.cultures = structuredClone(categoryRecipe.cultures);
				owner.texts.push(scaffold);
			}
			// One placement rule supplies structural facts. Recipe findings are not inferred here.
			if (owner.kind === "blueprint" || owner.kind === "widgetBlueprint")
				for (const text of owner.texts)
					if (text.mode !== "scaffold" && !text.signals.includes("evidence_only"))
						text.signals.unshift("evidence_only");
		}
		for (const owner of plan.packages)
			if (owner.texts.some((text) => text.case.startsWith("incremental-conflict"))) {
				const keptSource = owner.texts[0]!.manifestSource;
				plan.edits.packages.push(owner.path);
				plan.edits.operations.push({
					kind: "resolve_conflict",
					subject: owner.path,
					value: keptSource
				});
				if (phase === "after")
					for (const text of owner.texts) {
						text.source = keptSource;
						text.signals = ["shared"];
						for (const mark of Object.values(text.cultures)) {
							mark.state = "translated";
							mark.facts = ["translated"];
							mark.unknownReasons = [];
							mark.problems = ["finding"];
						}
					}
			}

		editPlan(plan, draws(seed ^ 0x51ed270b));
	}
	plan.packages = plan.packages.filter((owner) => owner.texts.length);
	plan.lines = plan.packages.reduce((count, owner) => count + owner.texts.length, 0);
	// Placement changes object kinds, identities and cultures. Carry the planted replacement
	// to those final coordinates, using the same saved preconditions the recipe wrote.
	for (const owner of plan.packages)
		for (const text of owner.texts)
			for (const [culture, mark] of Object.entries(text.cultures))
				mark.findings = mark.findings.map((finding) =>
					finding.fix
						? {
								...finding,
								fix: {
									...finding.fix,
									target: plan.target,
									culture,
									namespace:
										text.kind === "stringTableEntry"
											? text.namespace
											: text.namespace.replace(/ ?\[[^\]]*\]$/u, ""),
									key: text.key,
									source: text.manifestSource,
									previousTranslation: mark.poEntry
										? mark.po
										: mark.archive
											? mark.translation
											: null
								}
							}
						: finding
				);
	plan.expectations = deriveCorpusExpectations(plan);
	return plan;
}
