import { execFile, spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	decodeAuthoringTableSnapshot,
	decodeSavedWorld,
	SavedWorld,
	SavedWorldProgress,
	type AuthoringTableSnapshot
} from "@ue-shed/protocol";
import { Config, Context, Duration, Effect, Layer, Option, Schema, Tuple } from "effect";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CATALOG_TIMEOUT_MS = 5 * 60_000;

export { decodeSavedWorld, SavedWorld, SavedWorldProgress } from "@ue-shed/protocol";

export class AssetReaderError extends Schema.TaggedErrorClass<AssetReaderError>()(
	"AssetReaderError",
	{
		kind: Schema.Literals(["timeout", "process", "contract", "discovery", "resource_limit"]),
		operation: Schema.Literals([
			"authoring",
			"catalog",
			"inspect",
			"discovery",
			"scan",
			"saved_world"
		]),
		message: Schema.String,
		retrySafe: Schema.Boolean,
		path: Schema.optional(Schema.String),
		exitCode: Schema.optional(Schema.Number)
	}
) {}

export interface AssetReaderOptions {
	readonly assetPath: string;
}

export interface SavedTableCatalogOptions {
	readonly cachePath?: string;
	readonly projectRoot: string;
	readonly concurrency?: number;
}

/**
 * One batched project scan. `classes`, `classPrefixes`, and `names` are header-only selection
 * rules evaluated inside the reader, so unselected packages are never fully read or decoded. A
 * package is selected when it matches any rule; with no rules every package is selected.
 */
export interface SavedAssetScanOptions {
	/** Select packages exporting a class under this path prefix, e.g. `/Script/EnhancedInput.`. */
	readonly classPrefixes?: readonly string[];
	/** Select packages exporting this class, as a full path or a bare class name. */
	readonly classes?: readonly string[];
	readonly concurrency?: number;
	/** Refuse the scan when enumeration finds more packages than this, before any decode. */
	readonly maximumAssets?: number;
	/** Select packages whose name table contains this entry, e.g. the `TextProperty` type name. */
	readonly names?: readonly string[];
	/** Roots to enumerate, relative to the project root or absolute. Defaults to `Content`. */
	readonly paths?: readonly string[];
	readonly projectRoot: string;
}

/** Reads saved actors belonging to exactly one conventional or World Partition map. */
export interface SavedWorldReadOptions {
	readonly concurrency?: number;
	/** Refuse the map before decode when it has more selected packages than this. */
	readonly maximumAssets?: number;
	/** A `.umap` path inside `projectRoot`, relative to it or absolute. */
	readonly mapPath: string;
	readonly projectRoot: string;
}

export interface AssetReaderConfiguration {
	readonly catalogTimeoutMs: number;
	readonly executable: string;
	readonly timeoutMs: number;
}

export interface AssetReaderShape {
	readonly catalogProgress?: () => Effect.Effect<SavedTableCatalogProgress>;
	readonly discoverAssets: (
		projectRoot: string
	) => Effect.Effect<readonly string[], AssetReaderError>;
	readonly discoverTables: (
		options: SavedTableCatalogOptions
	) => Effect.Effect<SavedTableCatalog, AssetReaderError>;
	readonly readAsset: (
		assetPath: string
	) => Effect.Effect<SavedAssetInspection, AssetReaderError>;
	readonly readTable: (
		assetPath: string
	) => Effect.Effect<AuthoringTableSnapshot, AssetReaderError>;
	/** Reads one saved map's actors without requiring a live Unreal connection. */
	readonly readSavedWorld: (
		options: SavedWorldReadOptions
	) => Effect.Effect<SavedWorld, AssetReaderError>;
	/**
	 * Inspects every selected package under one project in a single reader process. Prefer this
	 * over `discoverAssets` plus `readAsset` per path for any project-wide scan.
	 */
	readonly scanProject: (
		options: SavedAssetScanOptions
	) => Effect.Effect<SavedAssetScan, AssetReaderError>;
	readonly scanProgress: () => Effect.Effect<SavedAssetScanProgress>;
	readonly savedWorldProgress: () => Effect.Effect<SavedWorldProgress>;
	readonly source: () => Effect.Effect<"configured" | "path">;
}

/** Optional members a test layer may omit; `makeAssetReaderTestLayer` supplies the defaults. */
type AssetReaderTestDefaults =
	| "catalogProgress"
	| "readSavedWorld"
	| "savedWorldProgress"
	| "scanProgress"
	| "scanProject";

export type AssetReaderTestShape = Omit<AssetReaderShape, AssetReaderTestDefaults> &
	Partial<Pick<AssetReaderShape, AssetReaderTestDefaults>>;

export class AssetReader extends Context.Service<AssetReader, AssetReaderShape>()(
	"@ue-shed/unreal-assets/AssetReader"
) {}

interface ProcessFailure {
	readonly code?: number | string;
	readonly killed?: boolean;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly message?: string;
}

export type SavedPropertyValue =
	| { readonly value_kind: "bool"; readonly value: boolean }
	| { readonly value_kind: "int" | "uint"; readonly value: number }
	| { readonly value_kind: "float" | "double"; readonly value: number }
	| {
			readonly value_kind: "name" | "enum" | "string" | "guid" | "soft_object_path";
			readonly value: string;
	  }
	| {
			readonly value_kind: "text";
			readonly value: string;
			readonly history: "none";
	  }
	| {
			readonly value_kind: "text";
			readonly value: string;
			readonly history: "base";
			readonly namespace: string;
			readonly key: string;
	  }
	| { readonly value_kind: "object_ref"; readonly value: string | null }
	| {
			readonly value_kind: "data_table_row_handle";
			readonly table_object_path: string | null;
			readonly row_name: string;
	  }
	| { readonly value_kind: "vector"; readonly x: number; readonly y: number; readonly z: number }
	| { readonly value_kind: "int_point"; readonly x: number; readonly y: number }
	| {
			readonly value_kind: "rotator";
			readonly pitch: number;
			readonly yaw: number;
			readonly roll: number;
	  }
	| {
			readonly value_kind: "color" | "linear_color";
			readonly r: number;
			readonly g: number;
			readonly b: number;
			readonly a: number;
	  }
	| { readonly value_kind: "array" | "set"; readonly values: readonly SavedPropertyValue[] }
	| {
			readonly value_kind: "map";
			readonly entries: readonly {
				readonly key: SavedPropertyValue;
				readonly value: SavedPropertyValue;
			}[];
	  }
	| { readonly value_kind: "struct"; readonly properties: readonly SavedProperty[] }
	| { readonly value_kind: "raw"; readonly reason: string; readonly size: number };

export type SavedProperty = SavedPropertyValue & {
	readonly name: string;
	readonly type: string;
};

const SavedPropertyValue: Schema.Codec<SavedPropertyValue> = Schema.suspend(
	() => SavedPropertyValueUnion
).annotate({ identifier: "SavedPropertyValue" });

const SavedProperty: Schema.Codec<SavedProperty> = Schema.suspend(() =>
	SavedPropertyValueUnion.mapMembers(
		Tuple.map(Schema.fieldsAssign({ name: Schema.String, type: Schema.String }))
	)
).annotate({ identifier: "SavedProperty" });

const stringKinds = ["name", "enum", "string", "guid", "soft_object_path"] as const;

const SavedPropertyValueUnion = Schema.Union([
	Schema.Struct({ value_kind: Schema.Literal("bool"), value: Schema.Boolean }),
	Schema.Struct({ value_kind: Schema.Literals(["int", "uint"]), value: Schema.Number }),
	Schema.Struct({ value_kind: Schema.Literals(["float", "double"]), value: Schema.Number }),
	Schema.Struct({ value_kind: Schema.Literals(stringKinds), value: Schema.String }),
	Schema.Struct({
		value_kind: Schema.Literal("text"),
		value: Schema.String,
		history: Schema.Literal("none")
	}),
	Schema.Struct({
		value_kind: Schema.Literal("text"),
		value: Schema.String,
		history: Schema.Literal("base"),
		namespace: Schema.String,
		key: Schema.String
	}),
	Schema.Struct({
		value_kind: Schema.Literal("object_ref"),
		value: Schema.NullOr(Schema.String)
	}),
	Schema.Struct({
		row_name: Schema.String,
		table_object_path: Schema.NullOr(Schema.String),
		value_kind: Schema.Literal("data_table_row_handle")
	}),
	Schema.Struct({
		value_kind: Schema.Literal("vector"),
		x: Schema.Number,
		y: Schema.Number,
		z: Schema.Number
	}),
	Schema.Struct({
		value_kind: Schema.Literal("int_point"),
		x: Schema.Number,
		y: Schema.Number
	}),
	Schema.Struct({
		value_kind: Schema.Literal("rotator"),
		pitch: Schema.Number,
		yaw: Schema.Number,
		roll: Schema.Number
	}),
	Schema.Struct({
		value_kind: Schema.Literals(["color", "linear_color"]),
		r: Schema.Number,
		g: Schema.Number,
		b: Schema.Number,
		a: Schema.Number
	}),
	Schema.Struct({
		value_kind: Schema.Literals(["array", "set"]),
		values: Schema.Array(SavedPropertyValue)
	}),
	Schema.Struct({
		value_kind: Schema.Literal("map"),
		entries: Schema.Array(Schema.Struct({ key: SavedPropertyValue, value: SavedPropertyValue }))
	}),
	Schema.Struct({
		value_kind: Schema.Literal("struct"),
		properties: Schema.Array(SavedProperty)
	}),
	Schema.Struct({
		value_kind: Schema.Literal("raw"),
		reason: Schema.String,
		size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	})
]);

export const SavedAssetDecodeError = Schema.Struct({
	object_path: Schema.String,
	class_path: Schema.optional(Schema.String),
	kind: Schema.Literals([
		"malformed_data",
		"resource_limit",
		"unsupported_format",
		"unsupported_version",
		"unsupported_capability"
	]),
	message: Schema.String
});
export type SavedAssetDecodeError = Schema.Schema.Type<typeof SavedAssetDecodeError>;

export const SavedAssetInspection = Schema.Struct({
	schema_version: Schema.Literal(7),
	status: Schema.Literals(["ok", "partial"]),
	path: Schema.String,
	package: Schema.Struct({
		name: Schema.String,
		version: Schema.Struct({
			legacy_file: Schema.Number,
			legacy_ue3: Schema.Number,
			ue4: Schema.Number,
			ue5: Schema.Number,
			licensee: Schema.Number
		}),
		package_flags: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		summary_size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		total_header_size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	}),
	assets: Schema.Array(
		Schema.Union([
			Schema.Struct({
				kind: Schema.Literal("StringTable"),
				object_path: Schema.String,
				string_table_namespace: Schema.String,
				string_table_entries: Schema.Array(
					Schema.Struct({ key: Schema.String, source: Schema.String })
				)
			}),
			Schema.Struct({
				kind: Schema.Literal("UObject"),
				object_path: Schema.String,
				class_path: Schema.String,
				properties: Schema.Array(SavedProperty).pipe(
					Schema.withDecodingDefaultKey(Effect.succeed([]))
				),
				tail_bytes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
			}),
			Schema.Struct({
				kind: Schema.Literals(["DataTable", "CompositeDataTable"]),
				object_path: Schema.String,
				row_struct: Schema.String,
				parent_tables: Schema.optional(Schema.Array(Schema.String)),
				row_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
				rows: Schema.Array(
					Schema.Struct({
						name: Schema.String,
						properties: Schema.Array(SavedProperty)
					})
				)
			})
		])
	),
	decode_errors: Schema.Array(SavedAssetDecodeError).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed([]))
	)
}).annotate({ identifier: "SavedAssetInspection" });
export type SavedAssetInspection = Schema.Schema.Type<typeof SavedAssetInspection>;

const decodeInspection = Schema.decodeUnknownEffect(SavedAssetInspection);

export const SavedAssetCatalogInspection = Schema.Struct({
	assets: Schema.Array(
		Schema.Struct({
			kind: Schema.String,
			object_path: Schema.String,
			parent_tables: Schema.Array(Schema.String).pipe(
				Schema.withDecodingDefaultKey(Effect.succeed([]))
			),
			row_struct: Schema.optional(Schema.String)
		})
	),
	decode_errors: Schema.Array(SavedAssetDecodeError).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed([]))
	),
	package: Schema.Struct({ name: Schema.String }),
	path: Schema.String,
	schema_version: Schema.Literal(7),
	status: Schema.Literals(["ok", "partial"])
});
export type SavedAssetCatalogInspection = Schema.Schema.Type<typeof SavedAssetCatalogInspection>;

export const SavedTableDescriptor = Schema.Struct({
	assetPath: Schema.String,
	authority: Schema.Struct({ kind: Schema.Literal("project_files"), packageName: Schema.String }),
	completeness: Schema.Literals(["complete", "partial"]),
	kind: Schema.Literals(["data_table", "composite_data_table"]),
	objectPath: Schema.String,
	parentTables: Schema.Array(Schema.String),
	rowStruct: Schema.String,
	schema: Schema.Struct({ reason: Schema.String, status: Schema.Literal("unavailable") })
});
export type SavedTableDescriptor = Schema.Schema.Type<typeof SavedTableDescriptor>;

export const SavedTableCatalog = Schema.Struct({
	diagnostics: Schema.Array(
		Schema.Struct({
			code: Schema.String,
			message: Schema.String,
			path: Schema.String,
			retrySafe: Schema.Boolean
		})
	),
	projectRoot: Schema.String,
	scannedAssets: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	tables: Schema.Array(SavedTableDescriptor)
});
export type SavedTableCatalog = Schema.Schema.Type<typeof SavedTableCatalog>;

export const SavedTableCatalogProgress = Schema.Struct({
	cacheHits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	phase: Schema.Literals(["idle", "enumerating", "scanning", "writing_cache", "ready", "failed"]),
	processedAssets: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	tablesFound: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	totalAssets: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export type SavedTableCatalogProgress = Schema.Schema.Type<typeof SavedTableCatalogProgress>;

interface CatalogProgressStore {
	current: SavedTableCatalogProgress;
}

const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const savedAssetScanEntryFields = {
	fileBytes: nonNegativeInt,
	inspection: SavedAssetInspection
};

/** One selected package from a batched scan, with the package file size the reader already stat-ed. */
export const SavedAssetScanEntry = Schema.Struct(savedAssetScanEntryFields);
export type SavedAssetScanEntry = Schema.Schema.Type<typeof SavedAssetScanEntry>;

const savedAssetScanFailureFields = {
	code: Schema.String,
	message: Schema.String,
	path: Schema.String,
	retrySafe: Schema.Boolean
};

/** One package the reader could not inspect. The scan continues past it. */
export const SavedAssetScanFailure = Schema.Struct(savedAssetScanFailureFields);
export type SavedAssetScanFailure = Schema.Schema.Type<typeof SavedAssetScanFailure>;

const savedAssetScanSummaryFields = {
	diagnostics: Schema.Array(
		Schema.Struct({
			code: Schema.String,
			message: Schema.String,
			path: Schema.String,
			retrySafe: Schema.Boolean
		})
	),
	emittedAssets: nonNegativeInt,
	failedAssets: nonNegativeInt,
	partialAssets: nonNegativeInt,
	projectRoot: Schema.String,
	roots: Schema.Array(Schema.String),
	scannedAssets: nonNegativeInt,
	schema_version: Schema.Literal(7),
	skippedAssets: nonNegativeInt
};

export const SavedAssetScanSummary = Schema.Struct(savedAssetScanSummaryFields);
export type SavedAssetScanSummary = Schema.Schema.Type<typeof SavedAssetScanSummary>;

export const SavedAssetScanProgress = Schema.Struct({
	emittedAssets: nonNegativeInt,
	phase: Schema.Literals(["idle", "enumerating", "scanning", "ready", "failed"]),
	processedAssets: nonNegativeInt,
	totalAssets: nonNegativeInt
});
export type SavedAssetScanProgress = Schema.Schema.Type<typeof SavedAssetScanProgress>;

export interface SavedAssetScan {
	readonly assets: readonly SavedAssetScanEntry[];
	readonly failures: readonly SavedAssetScanFailure[];
	readonly summary: SavedAssetScanSummary;
}

const decodeSavedWorldProgressLine = Schema.decodeUnknownOption(
	Schema.Struct({ event: Schema.Literal("saved_world_progress"), ...SavedWorldProgress.fields })
);

const ScanAssetLine = Schema.Struct({
	event: Schema.Literal("asset"),
	...savedAssetScanEntryFields
});

const ScanFailureLine = Schema.Struct({
	event: Schema.Literal("error"),
	...savedAssetScanFailureFields
});

const ScanSummaryLine = Schema.Struct({
	event: Schema.Literal("summary"),
	...savedAssetScanSummaryFields
});

const decodeScanAssetLine = Schema.decodeUnknownResult(ScanAssetLine);
const decodeScanFailureLine = Schema.decodeUnknownResult(ScanFailureLine);
const decodeScanSummaryLine = Schema.decodeUnknownResult(ScanSummaryLine);
const decodeScanProgressLine = Schema.decodeUnknownOption(
	Schema.Struct({
		event: Schema.Literal("scan_progress"),
		...SavedAssetScanProgress.fields
	})
);

interface ScanProgressStore {
	current: SavedAssetScanProgress;
}

interface SavedWorldProgressStore {
	current: SavedWorldProgress;
}

const idleScanProgress = (): SavedAssetScanProgress => ({
	emittedAssets: 0,
	phase: "idle",
	processedAssets: 0,
	totalAssets: 0
});

const idleCatalogProgress = (): SavedTableCatalogProgress => ({
	cacheHits: 0,
	phase: "idle",
	processedAssets: 0,
	tablesFound: 0,
	totalAssets: 0
});

const idleSavedWorldProgress = (): SavedWorldProgress => ({
	actorsFound: 0,
	phase: "idle",
	processedPackages: 0,
	totalPackages: 0
});

export const decodeSavedAssetCatalogInspection = Schema.decodeUnknownEffect(
	SavedAssetCatalogInspection
);

export function savedTableDescriptorsFromInspection(
	inspection: SavedAssetCatalogInspection
): readonly SavedTableDescriptor[] {
	return inspection.assets.flatMap((asset): SavedTableDescriptor[] => {
		if (asset.kind !== "DataTable" && asset.kind !== "CompositeDataTable") return [];
		return [
			{
				assetPath: inspection.path,
				authority: { kind: "project_files", packageName: inspection.package.name },
				completeness: inspection.status === "partial" ? "partial" : "complete",
				kind: asset.kind === "DataTable" ? "data_table" : "composite_data_table",
				objectPath: asset.object_path,
				parentTables: asset.parent_tables,
				rowStruct: asset.row_struct ?? "",
				schema: {
					reason: "Saved row-structure schema has not been resolved for this table.",
					status: "unavailable"
				}
			}
		];
	});
}

export function decodeSavedAssetInspection(input: unknown) {
	return decodeInspection(input);
}

function invokeReader(
	configuration: AssetReaderConfiguration,
	assetPath: string,
	operation: "authoring" | "inspect"
): Effect.Effect<string, AssetReaderError> {
	const args = [operation, assetPath, "--format", "json"];
	return Effect.tryPromise({
		try: async (signal) => {
			try {
				const result = await execFileAsync(configuration.executable, args, {
					encoding: "utf8",
					maxBuffer: MAX_OUTPUT_BYTES,
					signal,
					timeout: configuration.timeoutMs,
					windowsHide: true
				});
				return result.stdout;
			} catch (cause) {
				const failure = cause as ProcessFailure;
				if (failure.code === 6 && failure.stdout) return failure.stdout;
				throw cause;
			}
		},
		catch: (cause) => {
			const failure = cause as ProcessFailure;
			const timedOut = failure.killed === true || failure.code === "ETIMEDOUT";
			return new AssetReaderError({
				kind: timedOut ? "timeout" : "process",
				operation,
				message: timedOut
					? `Asset reader timed out after ${configuration.timeoutMs}ms`
					: failure.stderr?.trim() || failure.message || "Asset reader failed",
				path: assetPath,
				retrySafe: timedOut,
				...(typeof failure.code === "number" ? { exitCode: failure.code } : {})
			});
		}
	});
}

function invokeCatalogReader(
	configuration: AssetReaderConfiguration,
	options: SavedTableCatalogOptions,
	progress: CatalogProgressStore
): Effect.Effect<string, AssetReaderError> {
	const concurrency = Math.max(1, options.concurrency ?? 8);
	const args = [
		"catalog",
		options.projectRoot,
		"--format",
		"json",
		"--concurrency",
		String(concurrency)
	];
	if (options.cachePath !== undefined) args.push("--cache", options.cachePath);
	return Effect.tryPromise({
		try: (signal) =>
			new Promise<string>((resolvePromise, rejectPromise) => {
				progress.current = { ...idleCatalogProgress(), phase: "enumerating" };
				const child = spawn(configuration.executable, args, {
					signal,
					timeout: configuration.catalogTimeoutMs,
					windowsHide: true
				});
				let stdout = "";
				let stderr = "";
				let stderrLine = "";
				let settled = false;
				const rejectOnce = (failure: ProcessFailure) => {
					if (settled) return;
					settled = true;
					progress.current = { ...progress.current, phase: "failed" };
					rejectPromise(failure);
				};
				const consumeProgressLine = (line: string) => {
					if (line.trim().length === 0) return;
					try {
						const input = JSON.parse(line) as unknown;
						const decoded =
							Schema.decodeUnknownOption(SavedTableCatalogProgress)(input);
						if (Option.isSome(decoded)) {
							progress.current = decoded.value;
							return;
						}
					} catch {
						// Preserve non-progress stderr below as the process diagnostic.
					}
					stderr += `${line}\n`;
				};
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => {
					stdout += chunk;
					if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
						child.kill();
						rejectOnce({ message: "Asset catalog output exceeded 64 MiB" });
					}
				});
				child.stderr.on("data", (chunk: string) => {
					stderrLine += chunk;
					const lines = stderrLine.split(/\r?\n/);
					stderrLine = lines.pop() ?? "";
					for (const line of lines) consumeProgressLine(line);
				});
				child.once("error", (cause) => rejectOnce({ message: cause.message }));
				child.once("close", (code, childSignal) => {
					if (stderrLine.length > 0) consumeProgressLine(stderrLine);
					if (settled) return;
					settled = true;
					if (code === 0) {
						progress.current = { ...progress.current, phase: "ready" };
						resolvePromise(stdout);
					} else {
						progress.current = { ...progress.current, phase: "failed" };
						rejectPromise({
							...(typeof code === "number" ? { code } : {}),
							killed: childSignal !== null,
							message: `Asset catalog exited ${code ?? childSignal ?? "without a status"}`,
							stderr
						});
					}
				});
			}),
		catch: (cause) => {
			const failure = cause as ProcessFailure;
			const timedOut = failure.killed === true || failure.code === "ETIMEDOUT";
			return new AssetReaderError({
				kind: timedOut ? "timeout" : "process",
				operation: "catalog",
				message: timedOut
					? `Asset catalog timed out after ${configuration.catalogTimeoutMs}ms`
					: failure.stderr?.trim() || failure.message || "Asset catalog failed",
				path: options.projectRoot,
				retrySafe: timedOut,
				...(typeof failure.code === "number" ? { exitCode: failure.code } : {})
			});
		}
	});
}

function scanArguments(options: SavedAssetScanOptions): string[] {
	const args = [
		"scan",
		options.projectRoot,
		"--format",
		"json",
		"--concurrency",
		String(Math.max(1, options.concurrency ?? 8))
	];
	if (options.maximumAssets !== undefined) {
		args.push("--maximum-assets", String(options.maximumAssets));
	}
	for (const path of options.paths ?? []) args.push("--path", path);
	for (const value of options.classes ?? []) args.push("--class", value);
	for (const value of options.classPrefixes ?? []) args.push("--class-prefix", value);
	for (const value of options.names ?? []) args.push("--name", value);
	return args;
}

function savedWorldArguments(options: SavedWorldReadOptions): string[] {
	const args = [
		"saved-world",
		options.projectRoot,
		options.mapPath,
		"--format",
		"json",
		"--concurrency",
		String(Math.max(1, options.concurrency ?? 8))
	];
	if (options.maximumAssets !== undefined) {
		args.push("--maximum-assets", String(options.maximumAssets));
	}
	return args;
}

interface SavedWorldFailure extends ProcessFailure {
	readonly contract?: string;
	readonly discovery?: boolean;
	readonly resourceLimit?: boolean;
}

function invokeSavedWorldReader(
	configuration: AssetReaderConfiguration,
	options: SavedWorldReadOptions,
	progress: SavedWorldProgressStore
): Effect.Effect<SavedWorld, AssetReaderError> {
	return Effect.tryPromise({
		try: (signal) =>
			new Promise<string>((resolvePromise, rejectPromise) => {
				progress.current = { ...idleSavedWorldProgress(), phase: "enumerating" };
				const child = spawn(configuration.executable, savedWorldArguments(options), {
					signal,
					timeout: configuration.catalogTimeoutMs,
					windowsHide: true
				});
				let stdout = "";
				let stderr = "";
				let stderrLine = "";
				let settled = false;
				const rejectOnce = (failure: SavedWorldFailure) => {
					if (settled) return;
					settled = true;
					progress.current = { ...progress.current, phase: "failed" };
					child.kill();
					rejectPromise(failure);
				};
				const consumeStderrLine = (line: string) => {
					if (line.trim().length === 0) return;
					try {
						const decoded = decodeSavedWorldProgressLine(JSON.parse(line) as unknown);
						if (Option.isSome(decoded)) {
							const { event: _event, ...current } = decoded.value;
							progress.current = current;
							return;
						}
					} catch {
						// Preserve non-progress stderr below as the process diagnostic.
					}
					stderr += `${line}\n`;
				};
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => {
					stdout += chunk;
					if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
						rejectOnce({ message: "Saved world output exceeded 64 MiB" });
					}
				});
				child.stderr.on("data", (chunk: string) => {
					stderrLine += chunk;
					const lines = stderrLine.split(/\r?\n/);
					stderrLine = lines.pop() ?? "";
					for (const line of lines) consumeStderrLine(line);
				});
				child.once("error", (cause) => rejectOnce({ message: cause.message }));
				child.once("close", (code, childSignal) => {
					if (stderrLine.length > 0) consumeStderrLine(stderrLine);
					if (settled) return;
					settled = true;
					if (code === 0 || code === 6) {
						progress.current = { ...progress.current, phase: "ready" };
						resolvePromise(stdout);
						return;
					}
					progress.current = { ...progress.current, phase: "failed" };
					rejectPromise({
						...(typeof code === "number" ? { code } : {}),
						discovery: code === 4,
						killed: childSignal !== null,
						message: `Saved world reader exited ${code ?? childSignal ?? "without a status"}`,
						resourceLimit: code === 7,
						stderr
					});
				});
			}),
		catch: (cause) => {
			const failure = cause as SavedWorldFailure;
			if (failure.contract !== undefined) {
				return new AssetReaderError({
					kind: "contract",
					operation: "saved_world",
					message: failure.contract,
					path: options.mapPath,
					retrySafe: false
				});
			}
			if (failure.resourceLimit === true) {
				return new AssetReaderError({
					kind: "resource_limit",
					operation: "saved_world",
					message:
						failure.message ?? "Saved world exceeded the maximum external actor limit",
					path: options.mapPath,
					retrySafe: false,
					exitCode: 7
				});
			}
			if (failure.discovery === true) {
				return new AssetReaderError({
					kind: "discovery",
					operation: "saved_world",
					message:
						failure.stderr?.trim() ||
						failure.message ||
						"Saved world could not be read",
					path: options.mapPath,
					retrySafe: true,
					exitCode: 4
				});
			}
			const timedOut = failure.killed === true || failure.code === "ETIMEDOUT";
			return new AssetReaderError({
				kind: timedOut ? "timeout" : "process",
				operation: "saved_world",
				message: timedOut
					? `Saved world reader timed out after ${configuration.catalogTimeoutMs}ms`
					: failure.stderr?.trim() || failure.message || "Saved world reader failed",
				path: options.mapPath,
				retrySafe: timedOut,
				...(typeof failure.code === "number" ? { exitCode: failure.code } : {})
			});
		}
	}).pipe(
		Effect.flatMap((stdout) =>
			decodeOutput({
				assetPath: options.mapPath,
				operation: "saved_world",
				stdout,
				decode: decodeSavedWorld
			})
		),
		Effect.withSpan("unreal_assets.read_saved_world", {
			attributes: { "unreal.project_root": options.projectRoot }
		})
	);
}

interface ScanFailure extends ProcessFailure {
	readonly contract?: string;
	readonly discovery?: boolean;
	readonly resourceLimit?: boolean;
}

/** Pulls a structured reader error of one kind out of accumulated stderr. */
function structuredErrorMessage(stderr: string, kind: string): string | undefined {
	for (const line of stderr.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as { kind?: string; message?: string; status?: string };
			if (parsed.status === "error" && parsed.kind === kind) return parsed.message;
		} catch {
			// Non-JSON stderr is reported verbatim by the caller instead.
		}
	}
	return undefined;
}

/**
 * Runs one batched scan in a single reader process, decoding newline-delimited JSON as it
 * arrives. Replaces one process per package with one process per scan.
 */
function invokeScanReader(
	configuration: AssetReaderConfiguration,
	options: SavedAssetScanOptions,
	progress: ScanProgressStore
): Effect.Effect<SavedAssetScan, AssetReaderError> {
	return Effect.tryPromise({
		try: (signal) =>
			new Promise<SavedAssetScan>((resolvePromise, rejectPromise) => {
				progress.current = { ...idleScanProgress(), phase: "enumerating" };
				const child = spawn(configuration.executable, scanArguments(options), {
					signal,
					timeout: configuration.catalogTimeoutMs,
					windowsHide: true
				});
				const assets: SavedAssetScanEntry[] = [];
				const failures: SavedAssetScanFailure[] = [];
				let summary: SavedAssetScanSummary | undefined;
				let stdoutLine = "";
				let stderrLine = "";
				let stderr = "";
				let settled = false;
				const rejectOnce = (failure: ScanFailure) => {
					if (settled) return;
					settled = true;
					progress.current = { ...progress.current, phase: "failed" };
					child.kill();
					rejectPromise(failure);
				};
				const consumeAssetLine = (line: string) => {
					if (settled || line.trim().length === 0) return;
					let parsed: unknown;
					try {
						parsed = JSON.parse(line) as unknown;
					} catch (cause) {
						rejectOnce({ contract: `Invalid scan output line: ${String(cause)}` });
						return;
					}
					const event = (parsed as { event?: unknown }).event;
					if (event === "asset") {
						const decoded = decodeScanAssetLine(parsed);
						if (decoded._tag === "Failure") {
							rejectOnce({ contract: `Invalid scan asset: ${decoded.failure}` });
							return;
						}
						assets.push({
							fileBytes: decoded.success.fileBytes,
							inspection: decoded.success.inspection
						});
						return;
					}
					if (event === "error") {
						const decoded = decodeScanFailureLine(parsed);
						if (decoded._tag === "Failure") {
							rejectOnce({ contract: `Invalid scan error: ${decoded.failure}` });
							return;
						}
						const { event: _event, ...failure } = decoded.success;
						failures.push(failure);
						return;
					}
					if (event === "summary") {
						const decoded = decodeScanSummaryLine(parsed);
						if (decoded._tag === "Failure") {
							rejectOnce({ contract: `Invalid scan summary: ${decoded.failure}` });
							return;
						}
						const { event: _event, ...decodedSummary } = decoded.success;
						summary = decodedSummary;
						return;
					}
					rejectOnce({ contract: `Unknown scan event ${JSON.stringify(event)}` });
				};
				const consumeStderrLine = (line: string) => {
					if (line.trim().length === 0) return;
					try {
						const decoded = decodeScanProgressLine(JSON.parse(line) as unknown);
						if (Option.isSome(decoded)) {
							const { event: _event, ...current } = decoded.value;
							progress.current = current;
							return;
						}
					} catch {
						// Preserve non-progress stderr below as the process diagnostic.
					}
					stderr += `${line}\n`;
				};
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => {
					stdoutLine += chunk;
					if (Buffer.byteLength(stdoutLine, "utf8") > MAX_OUTPUT_BYTES) {
						rejectOnce({ message: "A single scan output line exceeded 64 MiB" });
						return;
					}
					const lines = stdoutLine.split(/\r?\n/);
					stdoutLine = lines.pop() ?? "";
					for (const line of lines) consumeAssetLine(line);
				});
				child.stderr.on("data", (chunk: string) => {
					stderrLine += chunk;
					const lines = stderrLine.split(/\r?\n/);
					stderrLine = lines.pop() ?? "";
					for (const line of lines) consumeStderrLine(line);
				});
				child.once("error", (cause) => rejectOnce({ message: cause.message }));
				child.once("close", (code, childSignal) => {
					if (stdoutLine.length > 0) consumeAssetLine(stdoutLine);
					if (stderrLine.length > 0) consumeStderrLine(stderrLine);
					if (settled) return;
					settled = true;
					if (code === 7) {
						progress.current = { ...progress.current, phase: "failed" };
						rejectPromise({
							code,
							message:
								structuredErrorMessage(stderr, "resource_limit") ??
								"Scan exceeded the maximum asset limit",
							resourceLimit: true
						});
						return;
					}
					// The reader exits 4 when a scan root cannot be enumerated, which is a
					// misconfigured project rather than a reader fault.
					if (code === 4) {
						progress.current = { ...progress.current, phase: "failed" };
						rejectPromise({
							code,
							discovery: true,
							message:
								structuredErrorMessage(stderr, "io") ??
								"Scan could not enumerate the project"
						});
						return;
					}
					// The reader exits 6 when some package was partial or unreadable. The scan
					// still produced every package it could read, so that is a partial success.
					if (code !== 0 && code !== 6) {
						progress.current = { ...progress.current, phase: "failed" };
						rejectPromise({
							...(typeof code === "number" ? { code } : {}),
							killed: childSignal !== null,
							message: `Asset scan exited ${code ?? childSignal ?? "without a status"}`,
							stderr
						});
						return;
					}
					if (summary === undefined) {
						progress.current = { ...progress.current, phase: "failed" };
						rejectPromise({ contract: "Scan output ended without a summary line" });
						return;
					}
					progress.current = { ...progress.current, phase: "ready" };
					resolvePromise({ assets, failures, summary });
				});
			}),
		catch: (cause) => {
			const failure = cause as ScanFailure;
			if (failure.contract !== undefined) {
				return new AssetReaderError({
					kind: "contract",
					operation: "scan",
					message: failure.contract,
					path: options.projectRoot,
					retrySafe: false
				});
			}
			if (failure.resourceLimit === true) {
				return new AssetReaderError({
					kind: "resource_limit",
					operation: "scan",
					message: failure.message ?? "Scan exceeded the maximum asset limit",
					path: options.projectRoot,
					retrySafe: false,
					exitCode: 7
				});
			}
			if (failure.discovery === true) {
				return new AssetReaderError({
					kind: "discovery",
					operation: "scan",
					message: failure.message ?? "Scan could not enumerate the project",
					path: options.projectRoot,
					retrySafe: true,
					exitCode: 4
				});
			}
			const timedOut = failure.killed === true || failure.code === "ETIMEDOUT";
			return new AssetReaderError({
				kind: timedOut ? "timeout" : "process",
				operation: "scan",
				message: timedOut
					? `Asset scan timed out after ${configuration.catalogTimeoutMs}ms`
					: failure.stderr?.trim() || failure.message || "Asset scan failed",
				path: options.projectRoot,
				retrySafe: timedOut,
				...(typeof failure.code === "number" ? { exitCode: failure.code } : {})
			});
		}
	});
}

function decodeOutput<A>(options: {
	readonly assetPath: string;
	readonly operation: "authoring" | "catalog" | "inspect" | "saved_world";
	readonly stdout: string;
	readonly decode: (input: unknown) => Effect.Effect<A, unknown>;
}): Effect.Effect<A, AssetReaderError> {
	return Effect.try({
		try: () => JSON.parse(options.stdout) as unknown,
		catch: (cause) =>
			new AssetReaderError({
				kind: "contract",
				operation: options.operation,
				message: `Invalid ${options.operation} output: ${String(cause)}`,
				path: options.assetPath,
				retrySafe: false
			})
	}).pipe(
		Effect.flatMap((input) =>
			options.decode(input).pipe(
				Effect.mapError(
					(cause) =>
						new AssetReaderError({
							kind: "contract",
							operation: options.operation,
							message: `Invalid ${options.operation} output: ${String(cause)}`,
							path: options.assetPath,
							retrySafe: false
						})
				)
			)
		)
	);
}

function readSavedTableWith(
	configuration: AssetReaderConfiguration,
	assetPath: string
): Effect.Effect<AuthoringTableSnapshot, AssetReaderError> {
	return invokeReader(configuration, assetPath, "authoring").pipe(
		Effect.flatMap((stdout) =>
			decodeOutput({
				assetPath,
				operation: "authoring",
				stdout,
				decode: decodeAuthoringTableSnapshot
			})
		)
	);
}

function readSavedAssetWith(
	configuration: AssetReaderConfiguration,
	assetPath: string
): Effect.Effect<SavedAssetInspection, AssetReaderError> {
	return invokeReader(configuration, assetPath, "inspect").pipe(
		Effect.flatMap((stdout) =>
			decodeOutput({
				assetPath,
				operation: "inspect",
				stdout,
				decode: decodeSavedAssetInspection
			})
		)
	);
}

function discoverSavedAssetsWith(projectRoot: string): Effect.Effect<string[], AssetReaderError> {
	const contentRoot = join(projectRoot, "Content");
	return Effect.tryPromise({
		try: async () => {
			const found: string[] = [];
			const visit = async (directory: string): Promise<void> => {
				const entries = await readdir(directory, { withFileTypes: true });
				entries.sort((left, right) => left.name.localeCompare(right.name));
				for (const entry of entries) {
					const path = join(directory, entry.name);
					if (entry.isDirectory()) await visit(path);
					else if (entry.isFile() && entry.name.endsWith(".uasset")) found.push(path);
				}
			};
			await visit(contentRoot);
			return found;
		},
		catch: (cause) =>
			new AssetReaderError({
				kind: "discovery",
				operation: "discovery",
				message: `Could not discover saved assets: ${String(cause)}`,
				path: contentRoot,
				retrySafe: true
			})
	});
}

function discoverSavedTablesWith(
	configuration: AssetReaderConfiguration,
	options: SavedTableCatalogOptions,
	progress: CatalogProgressStore
): Effect.Effect<SavedTableCatalog, AssetReaderError> {
	return invokeCatalogReader(configuration, options, progress).pipe(
		Effect.flatMap((stdout) =>
			decodeOutput({
				assetPath: options.projectRoot,
				operation: "catalog",
				stdout,
				decode: Schema.decodeUnknownEffect(SavedTableCatalog)
			})
		),
		Effect.withSpan("unreal_assets.discover_saved_tables", {
			attributes: { "unreal.project_root": options.projectRoot }
		})
	);
}

function makeAssetReader(
	configuration: AssetReaderConfiguration & { readonly source: "configured" | "path" },
	progress: CatalogProgressStore,
	scanStore: ScanProgressStore,
	savedWorldStore: SavedWorldProgressStore
): AssetReaderShape {
	const catalogProgress = Effect.fn("AssetReader.catalogProgress")(() =>
		Effect.sync(() => progress.current)
	);
	const scanProgress = Effect.fn("AssetReader.scanProgress")(() =>
		Effect.sync(() => scanStore.current)
	);
	const savedWorldProgress = Effect.fn("AssetReader.savedWorldProgress")(() =>
		Effect.sync(() => savedWorldStore.current)
	);
	const scanProject = Effect.fn("AssetReader.scanProject")(function* (
		options: SavedAssetScanOptions
	) {
		return yield* invokeScanReader(configuration, options, scanStore).pipe(
			Effect.withSpan("unreal_assets.scan_project", {
				attributes: { "unreal.project_root": options.projectRoot }
			})
		);
	});
	const discoverAssets = Effect.fn("AssetReader.discoverAssets")(function* (projectRoot: string) {
		return yield* discoverSavedAssetsWith(projectRoot);
	});
	const readAsset = Effect.fn("AssetReader.readAsset")(function* (assetPath: string) {
		return yield* readSavedAssetWith(configuration, assetPath);
	});
	const readTable = Effect.fn("AssetReader.readTable")(function* (assetPath: string) {
		return yield* readSavedTableWith(configuration, assetPath);
	});
	const readSavedWorld = Effect.fn("AssetReader.readSavedWorld")(function* (
		options: SavedWorldReadOptions
	) {
		return yield* invokeSavedWorldReader(configuration, options, savedWorldStore);
	});
	const discoverTables = Effect.fn("AssetReader.discoverTables")(function* (
		options: SavedTableCatalogOptions
	) {
		return yield* discoverSavedTablesWith(configuration, options, progress);
	});
	const source = Effect.fn("AssetReader.source")(() => Effect.succeed(configuration.source));
	return AssetReader.of({
		catalogProgress,
		discoverAssets,
		discoverTables,
		readAsset,
		readSavedWorld,
		readTable,
		scanProgress,
		scanProject,
		savedWorldProgress,
		source
	});
}

export function assetReaderLayer(
	configuration: Partial<AssetReaderConfiguration> = {}
): Layer.Layer<AssetReader> {
	return Layer.sync(AssetReader, () =>
		makeAssetReader(
			{
				catalogTimeoutMs: configuration.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS,
				executable: configuration.executable ?? "uasset",
				source: configuration.executable === undefined ? "path" : "configured",
				timeoutMs: configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS
			},
			{ current: idleCatalogProgress() },
			{ current: idleScanProgress() },
			{ current: idleSavedWorldProgress() }
		)
	);
}

const readerExecutable = Config.option(Config.string("UE_SHED_UASSET_EXECUTABLE"));
const readerTimeout = Config.duration("UE_SHED_UASSET_TIMEOUT").pipe(
	Config.withDefault(Duration.millis(DEFAULT_TIMEOUT_MS))
);
const readerCatalogTimeout = Config.duration("UE_SHED_UASSET_CATALOG_TIMEOUT").pipe(
	Config.withDefault(Duration.millis(DEFAULT_CATALOG_TIMEOUT_MS))
);

export const AssetReaderLive = Layer.effect(
	AssetReader,
	Effect.gen(function* () {
		const executable = yield* readerExecutable;
		return makeAssetReader(
			{
				catalogTimeoutMs: Duration.toMillis(yield* readerCatalogTimeout),
				executable: Option.getOrElse(executable, () => "uasset"),
				source: Option.isSome(executable) ? "configured" : "path",
				timeoutMs: Duration.toMillis(yield* readerTimeout)
			},
			{ current: idleCatalogProgress() },
			{ current: idleScanProgress() },
			{ current: idleSavedWorldProgress() }
		);
	})
);

export function makeAssetReaderTestLayer(service: AssetReaderTestShape): Layer.Layer<AssetReader> {
	return Layer.succeed(
		AssetReader,
		AssetReader.of({
			catalogProgress:
				service.catalogProgress ?? (() => Effect.succeed(idleCatalogProgress())),
			savedWorldProgress:
				service.savedWorldProgress ?? (() => Effect.succeed(idleSavedWorldProgress())),
			scanProgress: service.scanProgress ?? (() => Effect.succeed(idleScanProgress())),
			readSavedWorld:
				service.readSavedWorld ??
				((options) =>
					new AssetReaderError({
						kind: "process",
						operation: "saved_world",
						message: "This test asset reader does not stub readSavedWorld.",
						path: options.mapPath,
						retrySafe: false
					})),
			scanProject:
				service.scanProject ??
				((options) =>
					new AssetReaderError({
						kind: "process",
						operation: "scan",
						message: "This test asset reader does not stub scanProject.",
						path: options.projectRoot,
						retrySafe: false
					})),
			...service
		})
	);
}

export function readSavedTable(
	options: AssetReaderOptions
): Effect.Effect<AuthoringTableSnapshot, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readTable(options.assetPath));
}

export function readSavedAsset(
	options: AssetReaderOptions
): Effect.Effect<SavedAssetInspection, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readAsset(options.assetPath));
}

export function discoverSavedAssets(
	projectRoot: string
): Effect.Effect<readonly string[], AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.discoverAssets(projectRoot));
}

export function discoverSavedTables(
	options: SavedTableCatalogOptions
): Effect.Effect<SavedTableCatalog, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.discoverTables(options));
}

export function scanSavedProject(
	options: SavedAssetScanOptions
): Effect.Effect<SavedAssetScan, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.scanProject(options));
}

export function readSavedWorld(
	options: SavedWorldReadOptions
): Effect.Effect<SavedWorld, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readSavedWorld(options));
}

export function getAssetReaderSource(): Effect.Effect<"configured" | "path", never, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.source());
}
