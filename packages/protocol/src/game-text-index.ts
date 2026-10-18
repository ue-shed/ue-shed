import { Schema } from "effect";

const Text = Schema.NonEmptyString.check(Schema.isMaxLength(32767));
const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Id = Natural.check(Schema.isLessThanOrEqualTo(0xffffffff));
const ConfigurationIdentity = { cacheRoot: Text, projectKey: Text, targetKey: Text };
/** Persistent index identity; shared projects may isolate target joins with a validated prefix. */
export const GameTextIndexConfiguration = Schema.Union([
	Schema.Struct({ ...ConfigurationIdentity, sharedProject: Schema.Literal(false) }),
	Schema.Struct({
		...ConfigurationIdentity,
		sharedProject: Schema.Literal(true),
		viewPrefix: Schema.optionalKey(
			Schema.String.check(Schema.isPattern(/^target-join\.[a-f0-9]{64}\.$/u))
		)
	})
]);
export type GameTextIndexConfiguration = typeof GameTextIndexConfiguration.Type;
const Configuration = { configuration: GameTextIndexConfiguration };
const Name = Schema.NonEmptyString.check(Schema.isMaxLength(1024));
const Names = Schema.Array(Name).check(Schema.isMaxLength(2560));
/** One native index operation; begin/end own its session, and publish/join mutate cached state. */
export const GameTextIndexPreviousBuildRequest = Schema.Union([
	Schema.Struct({ action: Schema.Literal("capabilities") }),
	...(["begin", "end", "status"] as const).map((action) =>
		Schema.Struct({ action: Schema.Literal(action), ...Configuration })
	),
	Schema.Struct({
		action: Schema.Literal("publish"),
		...Configuration,
		inputs: Schema.Array(Schema.Struct({ name: Name, key: Name, file: Text })).check(
			Schema.isMaxLength(2560)
		),
		cold: Schema.optionalKey(Schema.Boolean),
		removedNames: Schema.optionalKey(Names)
	}),
	Schema.Struct({
		action: Schema.Literal("publish_ids"),
		...Configuration,
		name: Name,
		key: Name,
		file: Text,
		generation: Name,
		stringColumns: Schema.Record(Name, Name),
		retained: Schema.optionalKey(Schema.Record(Name, Name)),
		removed: Schema.optionalKey(Names)
	}),
	Schema.Struct({
		action: Schema.Literal("intern"),
		...Configuration,
		domain: Schema.NonEmptyString.check(Schema.isMaxLength(23)),
		file: Text
	}),
	Schema.Struct({
		action: Schema.Literal("strings"),
		...Configuration,
		ids: Schema.Array(Id).check(Schema.isMaxLength(8192)),
		output: Text
	}),
	Schema.Struct({ action: Schema.Literal("join"), ...Configuration, file: Text }),
	Schema.Struct({
		action: Schema.Literal("compact"),
		...Configuration,
		force: Schema.optionalKey(Schema.Boolean)
	})
]);
const PackageLayerName = Name.check(Schema.isPattern(/^package-text\./u));
/** Added in uasset-io 1.16; input snapshots contain only changed authored records. */
export const GameTextIndexPackageReplacement = Schema.Struct({
	action: Schema.Literal("publish_packages"),
	...Configuration,
	inputs: Schema.Array(
		Schema.Struct({
			name: PackageLayerName,
			key: Name,
			previousKey: Name,
			file: Text,
			rows: Schema.Array(
				Schema.Int.check(Schema.isGreaterThanOrEqualTo(-64000000)).check(
					Schema.isLessThanOrEqualTo(63999999)
				)
			).check(Schema.isMaxLength(64000000))
		})
	).check(Schema.isMaxLength(256)),
	removedNames: Schema.optionalKey(Schema.Array(PackageLayerName).check(Schema.isMaxLength(256)))
});
/** Validated builder commands; package replacements require protocol minor 16 or later. */
export const GameTextIndexBuildRequest = Schema.Union([
	...GameTextIndexPreviousBuildRequest.members,
	GameTextIndexPackageReplacement
]).annotate({ identifier: "GameTextIndexBuildRequest" });
export type GameTextIndexBuildRequest = typeof GameTextIndexBuildRequest.Type;

/** Join result sizes and counts; null metrics are unavailable, rather than zero work. */
export const GameTextIndexJoinOutcome = Schema.Struct({
	rebuilt: Schema.Boolean,
	strategy: Schema.NullOr(Schema.Literals(["full", "incremental"])),
	key: Name,
	bytes: Natural,
	count: Schema.NullOr(Natural),
	keyChanges: Schema.NullOr(Natural),
	affectedLines: Schema.NullOr(Natural)
});

/** Snapshot contents stay private to the paired builder/reader; their domain decoder verifies them. */
export const GameTextIndexBuildOutcome = Schema.Struct({
	action: Schema.Literals([
		"capabilities",
		"begin",
		"end",
		"status",
		"publish",
		"publish_packages",
		"publish_ids",
		"intern",
		"strings",
		"join",
		"compact"
	]),
	capabilities: Schema.Array(Schema.Literal("game_text_index_v1")),
	root: Schema.NullOr(Schema.Json),
	records: Schema.Array(Schema.Json),
	ids: Schema.Array(Id),
	join: Schema.NullOr(GameTextIndexJoinOutcome),
	compaction: Schema.NullOr(
		Schema.Struct({ compacted: Schema.Boolean, deadBytes: Natural, totalBytes: Natural })
	),
	stringCount: Schema.NullOr(Natural),
	io: Schema.Struct({
		opens: Natural,
		sectionLoads: Natural,
		storedBytes: Natural,
		rawBytes: Natural,
		fullVerifies: Natural,
		indexBytes: Natural,
		writtenBytes: Natural
	}),
	stageSeconds: Schema.Record(
		Schema.String,
		Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
	)
}).annotate({ identifier: "GameTextIndexBuildOutcome" });
export type GameTextIndexBuildOutcome = typeof GameTextIndexBuildOutcome.Type;

/** Keep lone UTF-16 code units out of serde_json's scalar-only string decoder. */
export function encodeGameTextJoinInput(serialized: string) {
	const input = Schema.decodeUnknownSync(
		Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
	)(serialized);
	let prefix = "__ue_shed_join_utf16_";
	while (serialized.includes(prefix)) prefix += "_";
	const stringCodeUnits: Record<string, readonly number[]> = {};
	const encode = (text: string): string => {
		let malformed = false;
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = text.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) i++;
				else malformed = true;
			} else if (code >= 0xdc00 && code <= 0xdfff) malformed = true;
		}
		if (!malformed) return text;
		const key = `${prefix}${Object.keys(stringCodeUnits).length}__`;
		stringCodeUnits[key] = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
		return key;
	};
	const visit = (value: typeof Schema.Json.Type): typeof Schema.Json.Type => {
		// This traverses already-decoded JSON primitives to encode code units, not domain validation.
		// oxlint-disable-next-line anti-slop/no-runtime-typeof
		if (typeof value === "string") return encode(value);
		if (Array.isArray(value)) return value.map(visit);
		// oxlint-disable-next-line anti-slop/no-runtime-typeof
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([key, value]) => [encode(key), visit(value)])
			);
		return value;
	};
	const result = Object.fromEntries(
		Object.entries(input).map(([key, value]) => [key, visit(value)])
	);
	return Object.keys(stringCodeUnits).length ? { ...result, stringCodeUnits } : result;
}
