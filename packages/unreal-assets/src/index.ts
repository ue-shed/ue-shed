import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { decodeAuthoringTableSnapshot, type AuthoringTableSnapshot } from "@ue-shed/protocol";
import { Data, Effect, Schema } from "effect";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export class AssetReaderError extends Data.TaggedError("AssetReaderError")<{
	readonly kind: "timeout" | "process" | "contract" | "discovery";
	readonly operation: "authoring" | "inspect" | "discovery";
	readonly message: string;
	readonly retrySafe: boolean;
	readonly path?: string;
	readonly exitCode?: number;
}> {}

export interface AssetReaderOptions {
	readonly assetPath: string;
	readonly executable?: string;
	readonly timeoutMs?: number;
}

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
			readonly value_kind: "name" | "enum" | "string" | "text" | "guid" | "soft_object_path";
			readonly value: string;
	  }
	| { readonly value_kind: "object_ref"; readonly value: string | null }
	| { readonly value_kind: "vector"; readonly x: number; readonly y: number; readonly z: number }
	| { readonly value_kind: "int_point"; readonly x: number; readonly y: number }
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

const SavedPropertyValue: Schema.Schema<SavedPropertyValue> = Schema.suspend(
	() => SavedPropertyValueUnion
).annotations({ identifier: "SavedPropertyValue" });

const SavedProperty: Schema.Schema<SavedProperty> = Schema.suspend(() =>
	Schema.extend(SavedPropertyValue, Schema.Struct({ name: Schema.String, type: Schema.String }))
).annotations({ identifier: "SavedProperty" });

const stringKinds = ["name", "enum", "string", "text", "guid", "soft_object_path"] as const;

const SavedPropertyValueUnion: Schema.Schema<SavedPropertyValue> = Schema.Union(
	Schema.Struct({ value_kind: Schema.Literal("bool"), value: Schema.Boolean }),
	Schema.Struct({ value_kind: Schema.Literal("int", "uint"), value: Schema.Number }),
	Schema.Struct({ value_kind: Schema.Literal("float", "double"), value: Schema.Number }),
	...stringKinds.map((kind) =>
		Schema.Struct({ value_kind: Schema.Literal(kind), value: Schema.String })
	),
	Schema.Struct({
		value_kind: Schema.Literal("object_ref"),
		value: Schema.NullOr(Schema.String)
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
		value_kind: Schema.Literal("array", "set"),
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
		size: Schema.NonNegativeInt
	})
);

export const SavedAssetInspection = Schema.Struct({
	schema_version: Schema.Literal(6),
	status: Schema.Literal("ok", "partial"),
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
		package_flags: Schema.NonNegativeInt,
		summary_size: Schema.NonNegativeInt,
		total_header_size: Schema.NonNegativeInt
	}),
	assets: Schema.Array(
		Schema.Union(
			Schema.Struct({
				kind: Schema.Literal("UObject"),
				object_path: Schema.String,
				class_path: Schema.String,
				properties: Schema.Array(SavedProperty),
				tail_bytes: Schema.optional(Schema.NonNegativeInt)
			}),
			Schema.Struct({
				kind: Schema.Literal("DataTable", "CompositeDataTable"),
				object_path: Schema.String,
				row_struct: Schema.String,
				parent_tables: Schema.optional(Schema.Array(Schema.String)),
				row_count: Schema.NonNegativeInt,
				rows: Schema.Array(
					Schema.Struct({
						name: Schema.String,
						properties: Schema.Array(SavedProperty)
					})
				)
			})
		)
	),
	decode_errors: Schema.optionalWith(
		Schema.Array(
			Schema.Struct({
				message: Schema.String,
				path: Schema.optional(Schema.String)
			})
		),
		{ default: () => [] }
	)
}).annotations({ identifier: "SavedAssetInspection" });
export type SavedAssetInspection = Schema.Schema.Type<typeof SavedAssetInspection>;

const decodeInspection = Schema.decodeUnknownSync(SavedAssetInspection);

export function decodeSavedAssetInspection(input: unknown): SavedAssetInspection {
	return decodeInspection(input);
}

function executableFrom(options: AssetReaderOptions): string {
	return options.executable ?? process.env.UE_SHED_UASSET_EXECUTABLE ?? "uasset";
}

function invokeReader(
	options: AssetReaderOptions,
	operation: "authoring" | "inspect"
): Effect.Effect<string, AssetReaderError> {
	const args = [operation, options.assetPath, "--format", "json"];
	return Effect.tryPromise({
		try: async () => {
			try {
				const result = await execFileAsync(executableFrom(options), args, {
					encoding: "utf8",
					maxBuffer: MAX_OUTPUT_BYTES,
					timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
					? `Asset reader timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
					: failure.stderr?.trim() || failure.message || "Asset reader failed",
				path: options.assetPath,
				retrySafe: timedOut,
				...(typeof failure.code === "number" ? { exitCode: failure.code } : {})
			});
		}
	});
}

function decodeOutput<A>(options: {
	readonly assetPath: string;
	readonly operation: "authoring" | "inspect";
	readonly stdout: string;
	readonly decode: (input: unknown) => A;
}): Effect.Effect<A, AssetReaderError> {
	return Effect.try({
		try: () => options.decode(JSON.parse(options.stdout)),
		catch: (cause) =>
			new AssetReaderError({
				kind: "contract",
				operation: options.operation,
				message: `Invalid ${options.operation} output: ${String(cause)}`,
				path: options.assetPath,
				retrySafe: false
			})
	});
}

export function readSavedTable(
	options: AssetReaderOptions
): Effect.Effect<AuthoringTableSnapshot, AssetReaderError> {
	return invokeReader(options, "authoring").pipe(
		Effect.flatMap((stdout) =>
			decodeOutput({
				assetPath: options.assetPath,
				operation: "authoring",
				stdout,
				decode: decodeAuthoringTableSnapshot
			})
		)
	);
}

export function readSavedAsset(
	options: AssetReaderOptions
): Effect.Effect<SavedAssetInspection, AssetReaderError> {
	return invokeReader(options, "inspect").pipe(
		Effect.flatMap((stdout) =>
			decodeOutput({
				assetPath: options.assetPath,
				operation: "inspect",
				stdout,
				decode: decodeSavedAssetInspection
			})
		)
	);
}

export function discoverSavedAssets(
	projectRoot: string
): Effect.Effect<string[], AssetReaderError> {
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
