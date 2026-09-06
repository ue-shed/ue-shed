import { Argument, Command, Flag } from "effect/unstable/cli";
import { Option } from "effect";
import {
	runProjectIndexCount,
	runProjectIndexMaps,
	runProjectIndexQuery,
	runProjectIndexRebuild,
	runProjectIndexRefresh,
	runProjectIndexStatus
} from "../workflows/project-index.js";
import { optionalFlag, optionalValue, positiveIntegerFlag, readerFields } from "./options.js";

const target = {
	projectRoot: Argument.string("project-root"),
	cacheRoot: Argument.string("cache-root"),
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
		kind: Argument.choice("kind", [
			"exact-class",
			"class-prefix",
			"class-name-suffix",
			"serialized-name"
		]),
		values: Argument.string("value").pipe(Argument.variadic({ min: 1 }))
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
		exactClasses: Flag.string("exact-class").pipe(Flag.atMost(64)),
		classPrefixes: Flag.string("class-prefix").pipe(Flag.atMost(64)),
		classNameSuffixes: Flag.string("class-name-suffix").pipe(Flag.atMost(64)),
		serializedNames: Flag.string("serialized-name").pipe(Flag.atMost(64))
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
