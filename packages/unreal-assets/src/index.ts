import { execFile, spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { decodeAuthoringTableSnapshot, type AuthoringTableSnapshot } from "@ue-shed/protocol";
import { Config, Context, Duration, Effect, Layer, Option, Schema, Tuple } from "effect";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CATALOG_TIMEOUT_MS = 5 * 60_000;

export class AssetReaderError extends Schema.TaggedErrorClass<AssetReaderError>()(
	"AssetReaderError",
	{
		kind: Schema.Literals(["timeout", "process", "contract", "discovery"]),
		operation: Schema.Literals(["authoring", "catalog", "inspect", "discovery"]),
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
	readonly source: () => Effect.Effect<"configured" | "path">;
}

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

const idleCatalogProgress = (): SavedTableCatalogProgress => ({
	cacheHits: 0,
	phase: "idle",
	processedAssets: 0,
	tablesFound: 0,
	totalAssets: 0
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

function decodeOutput<A>(options: {
	readonly assetPath: string;
	readonly operation: "authoring" | "catalog" | "inspect";
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
	progress: CatalogProgressStore
): AssetReaderShape {
	const catalogProgress = Effect.fn("AssetReader.catalogProgress")(() =>
		Effect.sync(() => progress.current)
	);
	const discoverAssets = Effect.fn("AssetReader.discoverAssets")(function* (projectRoot: string) {
		return yield* discoverSavedAssetsWith(projectRoot);
	});
	const readAsset = Effect.fn("AssetReader.readAsset")(function* (assetPath: string) {
		return yield* readSavedAssetWith(configuration, assetPath);
	});
	const readTable = Effect.fn("AssetReader.readTable")(function* (assetPath: string) {
		return yield* readSavedTableWith(configuration, assetPath);
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
		readTable,
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
			{ current: idleCatalogProgress() }
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
			{ current: idleCatalogProgress() }
		);
	})
);

export function makeAssetReaderTestLayer(service: AssetReaderShape): Layer.Layer<AssetReader> {
	return Layer.succeed(
		AssetReader,
		AssetReader.of({
			catalogProgress:
				service.catalogProgress ?? (() => Effect.succeed(idleCatalogProgress())),
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

export function getAssetReaderSource(): Effect.Effect<"configured" | "path", never, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.source());
}
