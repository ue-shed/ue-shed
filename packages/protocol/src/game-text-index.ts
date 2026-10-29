import { Schema } from "effect";
import type { GameTextContract } from "./game-text-contract.generated.js";

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
const Positive = Natural.check(Schema.isGreaterThan(0));
const LocalizationFormat = Schema.Literals(["manifest", "archive", "po"]);
const LocalizationOptions = Schema.Struct({
	format: LocalizationFormat,
	poFormat: Schema.optionalKey(Schema.String),
	collapseMode: Schema.optionalKey(Schema.String)
});
const LocalizationLimits = Schema.Struct({
	maxFileBytes: Positive,
	maxEntries: Positive,
	maxDepth: Positive,
	maxFiles: Positive,
	maxRecordBytes: Positive,
	maxIdentityBytes: Positive
});
const LocalizationImport: Schema.Codec<GameTextContract.LocalizationImportRequest> = Schema.Struct({
	files: Schema.Array(
		Schema.Struct({
			projectRoot: Text,
			chunkBytes: Schema.optionalKey(Positive),
			file: Text,
			relativePath: Name,
			options: LocalizationOptions,
			limits: LocalizationLimits
		})
	),
	maximumInFlightBytes: Positive,
	cold: Schema.Boolean
});
/** One native index operation; begin/end own its session, and publish/join mutate cached state. */
export const GameTextIndexPreviousBuildRequest = Schema.Union([
	Schema.Struct({
		action: Schema.Literal("import_localization"),
		...Configuration,
		request: LocalizationImport
	}),
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
/**
 * The reader plans a package-text refresh from a Project Index Catalog generation and writes the
 * changed shards' entries to `planFile`; the request names no packages.
 */
export const GameTextIndexPackagePlan = Schema.Struct({
	action: Schema.Literal("plan_packages"),
	...Configuration,
	request: Schema.Struct({
		cacheRoot: Text,
		projectId: Text,
		generation: Natural,
		format: Text,
		policyJson: Schema.String,
		changedFiles: Schema.optionalKey(Schema.Array(Text)),
		planFile: Text
	})
});
const PackageTextAudienceMatch = Schema.Union([
	Schema.Struct({
		kind: Schema.Literals(["namespace", "folder", "location", "macro"]),
		value: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("object"),
		value: Schema.String,
		position: Schema.Literals(["prefix", "suffix", "equals"])
	}),
	Schema.Struct({
		kind: Schema.Literal("module"),
		value: Schema.String,
		suffix: Schema.optionalKey(Schema.Boolean)
	}),
	Schema.Struct({
		kind: Schema.Literal("property"),
		value: Schema.String,
		anywhere: Schema.optionalKey(Schema.Boolean)
	})
]);
/** One audience policy row as the reader classifies with it: its stored code and conditions. */
export const PackageTextAudienceRule = Schema.Struct({
	code: Natural,
	when: Schema.Array(PackageTextAudienceMatch)
});
/** One project's code scan, as `unreal-code` runs it (`CodeTextRequest`). */
export const CodeTextRequest = Schema.Struct({
	projectRoot: Text,
	engineRoot: Schema.NullOr(Text),
	engine: Schema.Literals(["4.27", "5.7", "5.8"]),
	targets: Schema.Array(
		Schema.Struct({
			name: Name,
			steps: Schema.Array(
				Schema.Struct({
					searchDirectoryPaths: Schema.Array(Schema.String),
					excludePathFilters: Schema.Array(Schema.String),
					fileNameFilters: Schema.Array(Schema.String),
					gatherEditorOnly: Schema.Boolean
				})
			)
		})
	),
	cacheRoot: Schema.NullOr(Text),
	refreshEngineWrappers: Schema.Boolean
});
/**
 * The reader scans one target's code and publishes its code layer, `code-text:<target>`, when the
 * layer's content changed; without `scan` it removes the layer.
 */
export const GameTextIndexCodeLayer = Schema.Struct({
	action: Schema.Literal("publish_code"),
	...Configuration,
	request: Schema.Struct({
		target: Name,
		format: Text,
		policyJson: Schema.String,
		rules: Schema.Array(PackageTextAudienceRule),
		stagingFile: Text,
		scan: Schema.optionalKey(CodeTextRequest)
	})
});
/** A point's id: `local`, `depot@<CL>`, `shelved:<CL>` or another short name. */
const PointId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9@:._-]{1,128}$/u));
/**
 * The reader reads a set of files at one revision into per-file records keyed by content, reusing
 * any the cache holds, and writes the point's manifest.
 */
export const GameTextIndexReadPoint = Schema.Struct({
	action: Schema.Literal("read_point"),
	...Configuration,
	request: Schema.Struct({
		point: PointId,
		base: Schema.optionalKey(PointId),
		format: Text,
		policyJson: Schema.String,
		rules: Schema.Array(PackageTextAudienceRule),
		files: Schema.Array(Schema.Struct({ path: Text, file: Schema.optionalKey(Text) })),
		code: Schema.optionalKey(
			Schema.Struct({ policyJson: Schema.String, scan: CodeTextRequest })
		)
	})
});
/** Validated builder commands; package replacements require protocol minor 16 or later. */
export const GameTextIndexBuildRequest = Schema.Union([
	...GameTextIndexPreviousBuildRequest.members,
	GameTextIndexPackageReplacement,
	GameTextIndexPackagePlan,
	GameTextIndexCodeLayer,
	GameTextIndexReadPoint
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

const CodeDiagnostic = Schema.Struct({
	file: Schema.String,
	line: Schema.NullOr(Natural),
	code: Schema.Literals([
		"argument-count",
		"argument-parse",
		"unexpected-bracket",
		"end-of-file",
		"missing-bracket",
		"missing-quotes",
		"empty-identifier",
		"empty-source",
		"whitespace-only",
		"no-namespace",
		"namespace-redefined",
		"namespace-not-defined",
		"namespace-not-closed",
		"region-redefined",
		"region-not-defined",
		"unterminated-string",
		"unterminated-raw-string",
		"table-redefined",
		"table-entry-redefined",
		"table-metadata-redefined",
		"table-not-registered",
		"table-import-failed",
		"wrapper-unsupported",
		"wrapper-duplicate",
		"crashes-unreal427",
		"unreadable"
	]),
	message: Schema.String
});
/** What a `read_point` request did: each file's record, and how many were read or reused. */
export const PointOutcome = Schema.Struct({
	point: Schema.String,
	read: Natural,
	reused: Natural,
	bytes: Natural,
	entries: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			record: Schema.optionalKey(Schema.String),
			status: Schema.Literals([
				"complete",
				"partial",
				"not_gatherable",
				"failed",
				"removed",
				"unread"
			])
		})
	)
});
/** What a `publish_code` request did: the layer's key, whether it changed, and the scan's counts. */
export const CodeLayerOutcome = Schema.Struct({
	name: Name,
	key: Schema.optionalKey(Name),
	published: Schema.Boolean,
	places: Natural,
	leftOut: Natural,
	files: Natural,
	counts: Schema.optionalKey(
		Schema.Struct({
			listed: Natural,
			excluded: Natural,
			scanned: Natural,
			skipped: Natural,
			bytesRead: Natural
		})
	),
	diagnosticCount: Natural,
	diagnostics: Schema.Array(CodeDiagnostic),
	engineWrappers: Schema.optionalKey(
		Schema.Literals(["not-used", "no-engine-root", "read", "cached"])
	),
	profile: Schema.optionalKey(
		Schema.Struct({
			engineWrappersMicros: Natural,
			projectWrappersMicros: Natural,
			listMicros: Natural,
			scanMicros: Natural
		})
	)
});

/** Snapshot contents stay private to the paired builder/reader; their domain decoder verifies them. */
export const GameTextIndexBuildOutcome = Schema.Struct({
	action: Schema.Literals([
		"import_localization",
		"capabilities",
		"begin",
		"end",
		"status",
		"publish",
		"publish_packages",
		"plan_packages",
		"publish_code",
		"read_point",
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
	),
	code: Schema.optionalKey(CodeLayerOutcome),
	point: Schema.optionalKey(PointOutcome),
	plan: Schema.optionalKey(
		Schema.Struct({
			changed: Schema.Array(
				Schema.Struct({ group: Natural, key: Name, packages: Natural, selected: Natural })
			),
			removed: Schema.Array(Name),
			packages: Natural,
			firstKey: Name
		})
	),
	localization: Schema.optionalKey(
		Schema.Struct({
			lookupStrings: Natural,
			reusedStrings: Natural,
			files: Schema.Array(
				Schema.Struct({
					file: Schema.NullOr(
						Schema.Struct({
							key: Schema.String,
							contentHash: Schema.String,
							provenance: Schema.Struct({
								relativePath: Schema.String,
								size: Natural,
								modifiedTime: Schema.String,
								contentHash: Schema.String
							}),
							relativePath: Schema.String,
							format: LocalizationFormat,
							inputBytes: Natural,
							parsed: Schema.Boolean,
							snapshotBytes: Natural
						})
					),
					error: Schema.NullOr(
						Schema.Struct({
							code: Schema.String,
							message: Schema.String,
							recovery: Schema.String,
							retrySafe: Schema.Boolean,
							nextStep: Schema.String
						})
					)
				})
			),
			workerCount: Natural,
			parseMs: Schema.Number,
			parseCpuMs: Schema.Number,
			publishMs: Schema.Number
		})
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
