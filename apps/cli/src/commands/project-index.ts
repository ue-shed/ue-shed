import { Argument, Command, Flag } from "effect/cli";
import { Option } from "effect";
import { optionalFlag, optionalValue, positiveIntegerFlag, readerFields } from "./options.js";
import { lazyWorkflow } from "../lazy-workflows.js";

const runProjectIndexCount = lazyWorkflow(
	() => import("../workflows/project-index.js"),
	(module) => module.runProjectIndexCount
);
const runProjectIndexMaps = lazyWorkflow(
	() => import("../workflows/project-index.js"),
	(module) => module.runProjectIndexMaps
);
const runProjectIndexQuery = lazyWorkflow(
	() => import("../workflows/project-index.js"),
	(module) => module.runProjectIndexQuery
);
const runProjectIndexRebuild = lazyWorkflow(
	() => import("../workflows/project-index.js"),
	(module) => module.runProjectIndexRebuild
);
const runProjectIndexRefresh = lazyWorkflow(
	() => import("../workflows/project-index.js"),
	(module) => module.runProjectIndexRefresh
);
const runProjectIndexStatus = lazyWorkflow(
	() => import("../workflows/project-index.js"),
	(module) => module.runProjectIndexStatus
);

const target = {
	projectRoot: Argument.String("project-root"),
	cacheRoot: Argument.String("cache-root"),
	reader: optionalFlag("reader")
};

function targetFields(value: {
	readonly cacheRoot: string;
	readonly projectRoot: string;
	readonly reader: Option.Option<string>;
}) {
	return {
		cacheRoot: value.cacheRoot,
		projectRoot: value.projectRoot,
		...readerFields(value.reader)
	};
}

const status = Command.make("status", target, (value) =>
	runProjectIndexStatus({ _tag: "ProjectIndexStatus", ...targetFields(value) })
).pipe(Command.withDescription("Read the committed Project Index status without refreshing."));

const refresh = Command.make("refresh", target, (value) =>
	runProjectIndexRefresh({ _tag: "ProjectIndexRefresh", ...targetFields(value) })
).pipe(Command.withDescription("Refresh the disposable Project Index Catalog."));

const rebuild = Command.make("rebuild", target, (value) =>
	runProjectIndexRebuild({ _tag: "ProjectIndexRebuild", ...targetFields(value) })
).pipe(Command.withDescription("Rebuild the disposable Project Index Catalog."));

const pageOptions = {
	...target,
	limit: positiveIntegerFlag("limit", "--limit requires a positive integer").pipe(
		Flag.withDefault(100)
	),
	cursor: optionalFlag("cursor")
};

const maps = Command.make("maps", pageOptions, ({ cursor, limit, ...value }) => {
	const cursorValue = optionalValue(cursor);
	return runProjectIndexMaps({
		_tag: "ProjectIndexMaps",
		...targetFields(value),
		limit,
		...(cursorValue === undefined ? undefined : { cursor: cursorValue })
	});
}).pipe(Command.withDescription("Read one bounded page of saved maps."));

const query = Command.make(
	"query",
	{
		...pageOptions,
		kind: Argument.Literals("kind", [
			"exact-class",
			"class-prefix",
			"class-name-suffix",
			"serialized-name"
		]),
		values: Argument.String("value").pipe(Argument.variadic({ min: 1 }))
	},
	({ cursor, kind, limit, values, ...value }) => {
		const cursorValue = optionalValue(cursor);
		return runProjectIndexQuery({
			_tag: "ProjectIndexQuery",
			...targetFields(value),
			kind,
			limit,
			values,
			...(cursorValue === undefined ? undefined : { cursor: cursorValue })
		});
	}
).pipe(Command.withDescription("Read one bounded domain-neutral candidate page."));

const count = Command.make(
	"count",
	{
		...target,
		exactClasses: Flag.String("exact-class").pipe(Flag.atMost(64)),
		classPrefixes: Flag.String("class-prefix").pipe(Flag.atMost(64)),
		classNameSuffixes: Flag.String("class-name-suffix").pipe(Flag.atMost(64)),
		serializedNames: Flag.String("serialized-name").pipe(Flag.atMost(64))
	},
	({ exactClasses, classPrefixes, classNameSuffixes, serializedNames, ...value }) =>
		runProjectIndexCount({
			_tag: "ProjectIndexCount",
			...targetFields(value),
			exactClasses,
			classPrefixes,
			classNameSuffixes,
			serializedNames
		})
).pipe(
	Command.withDescription(
		"Count distinct packages matching any supplied selector. No selectors returns zero."
	)
);

export const projectIndexCommand = Command.make("project-index").pipe(
	Command.withDescription("Refresh and query the headless Project Index."),
	Command.withSubcommands([status, refresh, rebuild, maps, query, count])
);
