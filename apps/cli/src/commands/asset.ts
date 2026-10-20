import { Argument, Command, Flag } from "effect/cli";
import { Option } from "effect";
import {
	localizationFlags,
	optionalLocalizationFlags,
	optionalWhereFlags,
	optionalFilterFlags
} from "./localization-flags.js";
import { lazyWorkflow } from "../lazy-workflows.js";

const runSavedReview = lazyWorkflow(
	() => import("../saved-review-workflows.js"),
	(module) => module.runSavedReview
);
const runAssetsScan = lazyWorkflow(
	() => import("../asset-workflows.js"),
	(module) => module.runAssetsScan
);
const runInputInspect = lazyWorkflow(
	() => import("../asset-workflows.js"),
	(module) => module.runInputInspect
);
const runTextReview = lazyWorkflow(
	() => import("../asset-workflows.js"),
	(module) => module.runTextReview
);
const runTextRulesInit = lazyWorkflow(
	() => import("../asset-workflows.js"),
	(module) => module.runTextRulesInit
);
const runTextScan = lazyWorkflow(
	() => import("../asset-workflows.js"),
	(module) => module.runTextScan
);
const runTextSearch = lazyWorkflow(
	() => import("../asset-workflows.js"),
	(module) => module.runTextSearch
);

const optionalFlag = (name: string) => Flag.String(name).pipe(Flag.optional);

function optionalValue<A>(value: Option.Option<A>): A | undefined {
	return Option.isSome(value) ? value.value : undefined;
}

function readerFields(reader: Option.Option<string>) {
	const value = optionalValue(reader);
	return value === undefined ? undefined : { reader: value };
}

function repeatedStringFlag(name: string) {
	return Flag.String(name).pipe(Flag.atMost(Number.MAX_SAFE_INTEGER));
}

function positiveIntegerFlag(name: string, message: string) {
	return Flag.Int(name).pipe(
		Flag.filter(
			(value) => value > 0,
			() => message
		)
	);
}

const readerFlag = optionalFlag("reader");

const assetsScanCommand = Command.make(
	"scan",
	{
		path: Argument.String("path"),
		classPrefixes: repeatedStringFlag("class-prefix"),
		classes: repeatedStringFlag("class"),
		names: repeatedStringFlag("name"),
		maximumAssets: positiveIntegerFlag(
			"maximum-assets",
			"--maximum-assets requires a positive integer"
		).pipe(Flag.optional),
		full: Flag.Boolean("full").pipe(Flag.optional),
		reader: readerFlag
	},
	({ path, classPrefixes, classes, names, maximumAssets, full, reader }) => {
		const maximumAssetsValue = optionalValue(maximumAssets);
		const fullValue = optionalValue(full);
		return runAssetsScan({
			_tag: "AssetsScan",
			path,
			...(classPrefixes.length === 0 ? undefined : { classPrefixes }),
			...(classes.length === 0 ? undefined : { classes }),
			...(names.length === 0 ? undefined : { names }),
			...(maximumAssetsValue === undefined
				? undefined
				: { maximumAssets: maximumAssetsValue }),
			...(fullValue === undefined ? undefined : { full: fullValue }),
			...readerFields(reader)
		});
	}
).pipe(Command.withDescription("Scan saved assets under a project or explicit path."));

export const assetsCommand = Command.make("assets").pipe(
	Command.withDescription("Inspect saved Unreal assets."),
	Command.withSubcommands([
		assetsScanCommand,
		...(["blueprint", "sequence"] as const).map((name) =>
			Command.make(
				name,
				{
					path: Argument.String("asset-path"),
					baseline: optionalFlag("baseline"),
					reader: readerFlag
				},
				({ path, baseline, reader }) => {
					const before = optionalValue(baseline);
					return runSavedReview({
						_tag: "SavedReview",
						domain: name === "blueprint" ? "blueprint" : "level_sequence",
						path,
						...(before === undefined ? undefined : { baseline: before }),
						...readerFields(reader)
					});
				}
			).pipe(
				Command.withDescription(
					"Inspect saved structure, values and references; optionally compare with --baseline <path>."
				)
			)
		)
	])
);

const textScanCommand = Command.make(
	"scan",
	{ projectRoot: Argument.String("project-root"), reader: readerFlag },
	({ projectRoot, reader }) =>
		runTextScan({ _tag: "TextScan", projectRoot, ...readerFields(reader) })
).pipe(Command.withDescription("Build the saved player-facing text corpus."));

const textSearchCommand = Command.make(
	"search",
	{
		projectRoot: Argument.String("project-root"),
		query: Argument.String("query").pipe(Argument.variadic({ min: 1 })),
		target: optionalFlag("target"),
		searchTranslations: Flag.Boolean("search-translations").pipe(Flag.optional),
		...localizationFlags(),
		reader: readerFlag
	},
	({
		projectRoot,
		query,
		reader,
		target,
		culture,
		state,
		limit,
		searchTranslations,
		kinds,
		path,
		files,
		filters,
		group,
		cultures
	}) => {
		const value = query.join(" ").trim();
		return runTextSearch({
			_tag: "TextSearch",
			projectRoot,
			query: value,
			limit,
			...optionalLocalizationFlags(culture, state),
			...optionalWhereFlags(kinds, path, files),
			...optionalFilterFlags(filters, cultures, group),
			...(Option.isSome(target) ? { target: target.value } : undefined),
			...(Option.isSome(searchTranslations)
				? { searchTranslations: searchTranslations.value }
				: undefined),
			...readerFields(reader)
		});
	}
).pipe(Command.withDescription("Search the saved player-facing text corpus."));

const textReviewCommand = Command.make(
	"review",
	{
		projectRoot: Argument.String("project-root"),
		reader: readerFlag,
		rules: Flag.String("rules")
	},
	({ projectRoot, reader, rules }) =>
		runTextReview({
			_tag: "TextReview",
			projectRoot,
			ruleFile: rules,
			...readerFields(reader)
		})
).pipe(
	Command.withDescription("Review the saved text corpus with project-authored quality rules.")
);

const textRulesCommand = Command.make("rules").pipe(
	Command.withSubcommands([
		Command.make(
			"init",
			{ projectRoot: Argument.String("project-root"), output: optionalFlag("output") },
			({ projectRoot, output }) => {
				const value = optionalValue(output);
				return runTextRulesInit({
					_tag: "TextRulesInit",
					projectRoot,
					...(value === undefined ? undefined : { output: value })
				});
			}
		).pipe(Command.withDescription("Create example writing checks without overwriting a file."))
	])
);

export const textCommand = Command.make("text").pipe(
	Command.withDescription("Inspect, search, and review saved player-facing text."),
	Command.withSubcommands([
		textScanCommand,
		textSearchCommand,
		textReviewCommand,
		textRulesCommand
	])
);

const inputInspectCommand = Command.make(
	"inspect",
	{ path: Argument.String("asset-or-project"), reader: readerFlag },
	({ path, reader }) => runInputInspect({ _tag: "InputInspect", path, ...readerFields(reader) })
).pipe(Command.withDescription("Inspect saved Enhanced Input assets."));

export const inputCommand = Command.make("input").pipe(
	Command.withDescription("Inspect saved Enhanced Input assets."),
	Command.withSubcommands([inputInspectCommand])
);
