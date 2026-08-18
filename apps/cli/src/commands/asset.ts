import { Argument, Command, Flag } from "effect/unstable/cli";
import { Option } from "effect";
import {
	runAssetsScan,
	runInputInspect,
	runTextReview,
	runTextScan,
	runTextSearch
} from "../asset-workflows.js";

const optionalFlag = (name: string) => Flag.string(name).pipe(Flag.optional);

function optionalValue<A>(value: Option.Option<A>): A | undefined {
	return Option.isSome(value) ? value.value : undefined;
}

function readerFields(reader: Option.Option<string>) {
	const value = optionalValue(reader);
	return value === undefined ? {} : { reader: value };
}

function repeatedStringFlag(name: string) {
	return Flag.string(name).pipe(Flag.atMost(Number.MAX_SAFE_INTEGER));
}

function positiveIntegerFlag(name: string, message: string) {
	return Flag.integer(name).pipe(
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
		path: Argument.string("path"),
		classPrefixes: repeatedStringFlag("class-prefix"),
		classes: repeatedStringFlag("class"),
		names: repeatedStringFlag("name"),
		maximumAssets: positiveIntegerFlag(
			"maximum-assets",
			"--maximum-assets requires a positive integer"
		).pipe(Flag.optional),
		full: Flag.boolean("full").pipe(Flag.optional),
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
	Command.withSubcommands([assetsScanCommand])
);

const textScanCommand = Command.make(
	"scan",
	{ projectRoot: Argument.string("project-root"), reader: readerFlag },
	({ projectRoot, reader }) =>
		runTextScan({ _tag: "TextScan", projectRoot, ...readerFields(reader) })
).pipe(Command.withDescription("Build the saved player-facing text corpus."));

const textSearchCommand = Command.make(
	"search",
	{
		projectRoot: Argument.string("project-root"),
		query: Argument.string("query").pipe(Argument.variadic({ min: 1 })),
		reader: readerFlag
	},
	({ projectRoot, query, reader }) => {
		const value = query.join(" ").trim();
		return runTextSearch({
			_tag: "TextSearch",
			projectRoot,
			query: value,
			...readerFields(reader)
		});
	}
).pipe(Command.withDescription("Search the saved player-facing text corpus."));

const textReviewCommand = Command.make(
	"review",
	{
		projectRoot: Argument.string("project-root"),
		reader: readerFlag,
		rules: Flag.string("rules")
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

export const textCommand = Command.make("text").pipe(
	Command.withDescription("Inspect, search, and review saved player-facing text."),
	Command.withSubcommands([textScanCommand, textSearchCommand, textReviewCommand])
);

const inputInspectCommand = Command.make(
	"inspect",
	{ path: Argument.string("asset-or-project"), reader: readerFlag },
	({ path, reader }) => runInputInspect({ _tag: "InputInspect", path, ...readerFields(reader) })
).pipe(Command.withDescription("Inspect saved Enhanced Input assets."));

export const inputCommand = Command.make("input").pipe(
	Command.withDescription("Inspect saved Enhanced Input assets."),
	Command.withSubcommands([inputInspectCommand])
);
