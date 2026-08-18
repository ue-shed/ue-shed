import { AuthoringFieldDescriptor, type AuthoringTableSnapshot } from "@ue-shed/protocol";
import {
	AssetReader,
	type AssetReaderApi,
	type SavedTableCatalog,
	type SavedTableDescriptor
} from "@ue-shed/unreal-assets";
import type { UnrealAuthoringConnection } from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, Option, Result, Schema } from "effect";

const SchemaEvidence = Schema.Union([
	Schema.Struct({
		fields: Schema.Array(AuthoringFieldDescriptor),
		source: Schema.Literals(["saved_package", "live_reflection"]),
		status: Schema.Literal("available")
	}),
	Schema.Struct({ reason: Schema.String, status: Schema.Literal("unavailable") })
]);

export const AuthoringCatalogAuthority = Schema.Struct({
	authority: Schema.Literals(["saved", "live"]),
	completeness: Schema.Literals(["complete", "partial"]),
	fingerprint: Schema.optional(
		Schema.Union([
			Schema.Struct({
				algorithm: Schema.Literal("sha256"),
				status: Schema.Literal("available"),
				value: Schema.String,
				version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
			}),
			Schema.Struct({ reason: Schema.String, status: Schema.Literal("unavailable") })
		])
	),
	schema: SchemaEvidence
});
export type AuthoringCatalogAuthority = Schema.Schema.Type<typeof AuthoringCatalogAuthority>;

export const AuthoringTableCatalogEntry = Schema.Struct({
	authorities: Schema.Array(AuthoringCatalogAuthority),
	divergence: Schema.Union([
		Schema.Struct({ status: Schema.Literal("none") }),
		Schema.Struct({ fields: Schema.Array(Schema.String), status: Schema.Literal("detected") })
	]),
	kind: Schema.Literals(["data_table", "composite_data_table"]),
	objectPath: Schema.String,
	packageName: Schema.String,
	parentTables: Schema.Array(Schema.String),
	rowStruct: Schema.String
});
export type AuthoringTableCatalogEntry = Schema.Schema.Type<typeof AuthoringTableCatalogEntry>;

export const AuthoringProjectCatalog = Schema.Struct({
	diagnostics: Schema.Array(
		Schema.Struct({
			authority: Schema.Literals(["saved", "live"]),
			code: Schema.String,
			message: Schema.String,
			path: Schema.optional(Schema.String),
			retrySafe: Schema.Boolean
		})
	),
	scannedSavedAssets: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	tables: Schema.Array(AuthoringTableCatalogEntry)
});
export type AuthoringProjectCatalog = Schema.Schema.Type<typeof AuthoringProjectCatalog>;

interface CatalogCandidate {
	readonly authority: AuthoringCatalogAuthority;
	readonly kind: AuthoringTableCatalogEntry["kind"];
	readonly objectPath: string;
	readonly packageName: string;
	readonly parentTables: readonly string[];
	readonly rowStruct: string;
}

function savedCandidate(table: SavedTableDescriptor): CatalogCandidate {
	return {
		authority: {
			authority: "saved",
			completeness: table.completeness,
			schema: table.schema
		},
		kind: table.kind,
		objectPath: table.objectPath,
		packageName: table.authority.packageName,
		parentTables: table.parentTables,
		rowStruct: table.rowStruct
	};
}

function liveCandidate(snapshot: AuthoringTableSnapshot): CatalogCandidate {
	const v2 = "producer" in snapshot ? snapshot : undefined;
	return {
		authority: {
			authority: "live",
			completeness: snapshot.completeness,
			...(v2 ? { fingerprint: v2.fingerprint } : undefined),
			schema: v2?.table.schema ?? {
				reason: "The connected editor returned a legacy snapshot without schema evidence.",
				status: "unavailable"
			}
		},
		kind: snapshot.table.kind,
		objectPath: snapshot.table.objectPath,
		packageName: v2
			? v2.table.packageName
			: snapshot.authority.kind === "project_files"
				? snapshot.authority.packageName
				: (snapshot.table.objectPath.split(".")[0] ?? snapshot.table.objectPath),
		parentTables: snapshot.table.parentTables,
		rowStruct: snapshot.table.rowStruct
	};
}

function differentFields(candidates: readonly CatalogCandidate[]): readonly string[] {
	const [first, ...rest] = candidates;
	if (!first) return [];
	const fields: string[] = [];
	if (rest.some((candidate) => candidate.kind !== first.kind)) fields.push("kind");
	if (rest.some((candidate) => candidate.packageName !== first.packageName))
		fields.push("packageName");
	if (rest.some((candidate) => candidate.rowStruct !== first.rowStruct)) fields.push("rowStruct");
	if (
		rest.some(
			(candidate) =>
				JSON.stringify(candidate.parentTables) !== JSON.stringify(first.parentTables)
		)
	)
		fields.push("parentTables");
	return fields;
}

export function mergeAuthoringTableCatalogs(args: {
	readonly live: readonly AuthoringTableSnapshot[];
	readonly saved: SavedTableCatalog | undefined;
}): readonly AuthoringTableCatalogEntry[] {
	const groups = new Map<string, CatalogCandidate[]>();
	for (const candidate of [
		...(args.saved?.tables.map(savedCandidate) ?? []),
		...args.live.map(liveCandidate)
	]) {
		const group = groups.get(candidate.objectPath) ?? [];
		group.push(candidate);
		groups.set(candidate.objectPath, group);
	}
	return [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([objectPath, candidates]) => {
			const preferred =
				candidates.find((candidate) => candidate.authority.authority === "live") ??
				candidates[0];
			if (!preferred) throw new Error(`Catalog group ${objectPath} has no candidates`);
			const fields = differentFields(candidates);
			return {
				authorities: candidates.map((candidate) => candidate.authority),
				divergence:
					fields.length === 0
						? { status: "none" as const }
						: { fields, status: "detected" as const },
				kind: preferred.kind,
				objectPath,
				packageName: preferred.packageName,
				parentTables: preferred.parentTables,
				rowStruct: preferred.rowStruct
			};
		});
}

export interface AuthoringCatalogDiscoverArgs {
	readonly concurrency?: number;
	readonly projectRoot?: string;
	readonly savedCatalog?: SavedTableCatalog;
}

export class AuthoringLiveConnection extends Context.Service<
	AuthoringLiveConnection,
	UnrealAuthoringConnection
>()("@ue-shed/authoring-catalog/AuthoringLiveConnection") {}

export function authoringLiveConnectionLayer(
	connection: UnrealAuthoringConnection
): Layer.Layer<AuthoringLiveConnection> {
	return Layer.succeed(AuthoringLiveConnection, AuthoringLiveConnection.of(connection));
}

function discoverAuthoringProjectCatalogWith(
	reader: AssetReaderApi,
	options: AuthoringCatalogDiscoverArgs,
	liveConnection: Option.Option<UnrealAuthoringConnection>
): Effect.Effect<AuthoringProjectCatalog> {
	const saved = options.savedCatalog
		? Effect.succeed(Result.succeed(options.savedCatalog))
		: options.projectRoot
			? reader
					.discoverTables({
						...(options.concurrency ? { concurrency: options.concurrency } : undefined),
						projectRoot: options.projectRoot
					})
					.pipe(Effect.result)
			: Effect.succeed(undefined);
	const live = Option.match(liveConnection, {
		onNone: () => Effect.succeed(undefined),
		onSome: (connection) =>
			connection.listTableObjectPaths().pipe(
				Effect.flatMap((objectPaths) =>
					Effect.forEach(
						objectPaths,
						(objectPath) => connection.getTableSnapshot(objectPath).pipe(Effect.result),
						{ concurrency: options.concurrency ?? 4 }
					)
				),
				Effect.result
			)
	});

	return Effect.all({ live, saved }).pipe(
		Effect.map(({ live, saved }) => {
			const savedCatalog = saved && saved._tag === "Success" ? saved.success : undefined;
			const liveResults = live && live._tag === "Success" ? live.success : [];
			const liveSnapshots = liveResults.flatMap((result) =>
				result._tag === "Success" ? [result.success] : []
			);
			const diagnostics: AuthoringProjectCatalog["diagnostics"][number][] = [];
			if (saved?._tag === "Failure") {
				diagnostics.push({
					authority: "saved",
					code: saved.failure.kind,
					message: saved.failure.message,
					...(saved.failure.path ? { path: saved.failure.path } : undefined),
					retrySafe: saved.failure.retrySafe
				});
			}
			for (const diagnostic of savedCatalog?.diagnostics ?? []) {
				diagnostics.push({ authority: "saved", ...diagnostic });
			}
			if (live?._tag === "Failure") {
				diagnostics.push({
					authority: "live",
					code: "table_list_failed",
					message: live.failure.message,
					retrySafe: live.failure.retrySafe
				});
			}
			for (const result of liveResults) {
				if (result._tag === "Failure") {
					diagnostics.push({
						authority: "live",
						code: "snapshot_failed",
						message: result.failure.message,
						retrySafe: result.failure.retrySafe
					});
				}
			}
			return {
				diagnostics,
				scannedSavedAssets: savedCatalog?.scannedAssets ?? 0,
				tables: mergeAuthoringTableCatalogs({ live: liveSnapshots, saved: savedCatalog })
			};
		}),
		Effect.withSpan("authoring.catalog.discover", {
			attributes: {
				"authoring.catalog.live_configured": Option.isSome(liveConnection),
				"authoring.catalog.saved_configured": options.projectRoot !== undefined
			}
		})
	);
}

export interface AuthoringCatalogApi {
	readonly discover: (
		options: AuthoringCatalogDiscoverArgs
	) => Effect.Effect<AuthoringProjectCatalog>;
}

export class AuthoringCatalog extends Context.Service<AuthoringCatalog, AuthoringCatalogApi>()(
	"@ue-shed/authoring-catalog/AuthoringCatalog"
) {}

export const AuthoringCatalogLive = Layer.effect(
	AuthoringCatalog,
	Effect.gen(function* () {
		const reader = yield* AssetReader;
		const discover = Effect.fn("AuthoringCatalog.discover")(function* (
			options: AuthoringCatalogDiscoverArgs
		) {
			const liveConnection = yield* Effect.serviceOption(AuthoringLiveConnection);
			return yield* discoverAuthoringProjectCatalogWith(reader, options, liveConnection);
		});
		return AuthoringCatalog.of({ discover });
	})
);

export function makeAuthoringCatalogTestLayer(
	service: AuthoringCatalogApi
): Layer.Layer<AuthoringCatalog> {
	return Layer.succeed(AuthoringCatalog, AuthoringCatalog.of(service));
}

/** Compatibility accessor until Plans 012–014 compose AuthoringCatalog layers directly. */
export function discoverAuthoringProjectCatalog(options: {
	readonly concurrency?: number;
	readonly live?: UnrealAuthoringConnection;
	readonly projectRoot?: string;
	readonly savedCatalog?: SavedTableCatalog;
}): Effect.Effect<AuthoringProjectCatalog, never, AssetReader> {
	const { live, ...discoverOptions } = options;
	const program = Effect.flatMap(AuthoringCatalog, (service) =>
		service.discover(discoverOptions)
	).pipe(Effect.provide(AuthoringCatalogLive));
	return live === undefined
		? program
		: program.pipe(Effect.provide(authoringLiveConnectionLayer(live)));
}
