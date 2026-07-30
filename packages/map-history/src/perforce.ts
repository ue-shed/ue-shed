import { Context, Effect, Layer, Schema } from "effect";
import {
	P4Client,
	createP4Service,
	type ListDepotFilesAtChangeOptions,
	type ListDepotFilesAtChangeResult,
	type ListSubmittedChangelistsOptions,
	type ListSubmittedChangelistsResult,
	type MaterializeDepotFilesOptions,
	type P4ChangelistDescription,
	type P4ClientOptions,
	type P4MaterializeResult
} from "p4client-ts";
import { MapHistoryError } from "./errors.js";

export interface PerforceChangedFile {
	readonly action: string;
	readonly depotPath: string;
	readonly revision: number | null;
	readonly type: string | null;
}

export interface PerforceSubmittedChange {
	readonly change: number;
	readonly description?: string;
	readonly submittedAt?: string;
	readonly user?: string;
}

export interface PerforceChangeDescription extends PerforceSubmittedChange {
	readonly files: readonly PerforceChangedFile[];
	readonly status: "pending" | "submitted";
}

export interface PerforceDepotFile {
	readonly action: string;
	readonly changelist: number;
	readonly depotPath: string;
	readonly revision: number;
	readonly type: string;
}

export interface PerforceDepotSnapshot {
	readonly files: readonly PerforceDepotFile[];
	readonly hasMore: boolean;
}

export interface PerforceMaterializedFile {
	readonly file: PerforceDepotFile;
	readonly localPath: string;
}

export interface PerforceMaterialization {
	readonly directory: string;
	readonly files: readonly PerforceMaterializedFile[];
	readonly totalCount: number;
}

export interface PerforceMaterializationOptions {
	readonly concurrency?: number;
	readonly directory: string;
	readonly files: readonly PerforceDepotFile[];
	readonly maxFiles: number;
}

export interface PerforceLocalMapping {
	readonly depotPath: string;
}

export interface PerforceHistorySourceShape {
	readonly describeChangelist: (
		change: number
	) => Effect.Effect<PerforceChangeDescription, MapHistoryError>;
	readonly listDepotFilesAtChange: (
		options: ListDepotFilesAtChangeOptions
	) => Effect.Effect<PerforceDepotSnapshot, MapHistoryError>;
	readonly listSubmittedChangelists: (options: ListSubmittedChangelistsOptions) => Effect.Effect<
		{
			readonly hasMore: boolean;
			readonly items: readonly PerforceSubmittedChange[];
			readonly nextBeforeChange: number | null;
		},
		MapHistoryError
	>;
	readonly materializeDepotFiles: (
		options: PerforceMaterializationOptions
	) => Effect.Effect<PerforceMaterialization, MapHistoryError>;
	readonly resolveLocalPath: (
		localPath: string
	) => Effect.Effect<PerforceLocalMapping, MapHistoryError>;
}

export class PerforceHistorySource extends Context.Service<
	PerforceHistorySource,
	PerforceHistorySourceShape
>()("@ue-shed/map-history/PerforceHistorySource") {}

interface PerforceBackend {
	readonly describeChangelist: (
		change: number
	) => Effect.Effect<P4ChangelistDescription, unknown>;
	readonly listDepotFilesAtChange: (
		options: ListDepotFilesAtChangeOptions
	) => Effect.Effect<ListDepotFilesAtChangeResult, unknown>;
	readonly listSubmittedChangelists: (
		options: ListSubmittedChangelistsOptions
	) => Effect.Effect<ListSubmittedChangelistsResult, unknown>;
	readonly materializeDepotFiles: (
		options: MaterializeDepotFilesOptions
	) => Effect.Effect<P4MaterializeResult, unknown>;
}

const P4WhereRecord = Schema.Struct({
	depotFile: Schema.optionalKey(Schema.String),
	unmap: Schema.optionalKey(Schema.String)
});
const decodeP4WhereRecords = Schema.decodeUnknownEffect(Schema.Array(P4WhereRecord));

const P4MaterializationFile = Schema.Struct({
	action: Schema.NonEmptyString.pipe(Schema.brand("P4FileAction")),
	changelist: Schema.Int.check(Schema.isGreaterThan(0)),
	depotFile: Schema.NonEmptyString.pipe(Schema.brand("P4DepotPath")),
	revision: Schema.Int.check(Schema.isGreaterThan(0)),
	type: Schema.NonEmptyString
});
const decodeP4MaterializationFiles = Schema.decodeUnknownEffect(
	Schema.Array(P4MaterializationFile)
);

function optionalString(value: string | null): { readonly value?: string } {
	return value === null ? {} : { value };
}

function toSubmittedChange(change: {
	readonly change: number;
	readonly createdAtIso: string | null;
	readonly description: string | null;
	readonly user: string | null;
}): PerforceSubmittedChange {
	const description = optionalString(change.description);
	const submittedAt = optionalString(change.createdAtIso);
	const user = optionalString(change.user);
	return {
		change: change.change,
		...(description.value === undefined ? {} : { description: description.value }),
		...(submittedAt.value === undefined ? {} : { submittedAt: submittedAt.value }),
		...(user.value === undefined ? {} : { user: user.value })
	};
}

function toDepotFile(file: ListDepotFilesAtChangeResult["items"][number]): PerforceDepotFile {
	return {
		action: file.action,
		changelist: file.changelist,
		depotPath: file.depotFile,
		revision: file.revision,
		type: file.type
	};
}

function toMapHistoryError(operation: string, cause: unknown): MapHistoryError {
	const tagged = cause as {
		readonly _tag?: string;
		readonly category?: string;
		readonly message?: string;
		readonly reason?: string;
	};
	const kind =
		tagged._tag === "P4MaterializationError"
			? tagged.reason === "limit_exceeded"
				? "resource_limit"
				: "materialization"
			: tagged._tag === "P4CommandError" && tagged.category === "authentication"
				? "perforce_authentication"
				: tagged._tag === "P4CommandError" &&
					  (tagged.category === "server_config" || tagged.category === "client")
					? "perforce_configuration"
					: "perforce_command";
	return new MapHistoryError({
		cause,
		kind,
		message: tagged.message ?? `${operation} failed.`,
		recovery:
			kind === "perforce_authentication"
				? "Authenticate with Perforce and retry."
				: kind === "perforce_configuration"
					? "Check the active Perforce server and client configuration."
					: kind === "resource_limit"
						? "Narrow the history range or raise the explicit operation limit."
						: "Inspect the Perforce diagnostic and retry when it is safe.",
		retrySafe:
			tagged._tag === "P4TimeoutError" ||
			(tagged._tag === "P4CommandError" && tagged.category === "connection")
	});
}

export function makePerforceHistorySource(
	backend: PerforceBackend,
	resolveLocalPath: PerforceHistorySourceShape["resolveLocalPath"] = (localPath) =>
		Effect.fail(
			new MapHistoryError({
				kind: "perforce_configuration",
				message: `The Perforce test source does not resolve ${localPath}.`,
				recovery: "Provide a resolveLocalPath test implementation.",
				retrySafe: false
			})
		)
): PerforceHistorySourceShape {
	return PerforceHistorySource.of({
		describeChangelist: Effect.fn("PerforceHistorySource.describeChangelist")(function* (
			change: number
		) {
			const result = yield* backend
				.describeChangelist(change)
				.pipe(Effect.mapError((cause) => toMapHistoryError("describe changelist", cause)));
			return {
				...toSubmittedChange({ ...result, change }),
				files: result.files.map((file) => ({
					action: file.action,
					depotPath: file.depotFile,
					revision: file.revision,
					type: file.type
				})),
				status: result.status
			};
		}),
		listDepotFilesAtChange: Effect.fn("PerforceHistorySource.listDepotFilesAtChange")(
			function* (options: ListDepotFilesAtChangeOptions) {
				const result = yield* backend
					.listDepotFilesAtChange(options)
					.pipe(Effect.mapError((cause) => toMapHistoryError("list depot files", cause)));
				return { files: result.items.map(toDepotFile), hasMore: result.hasMore };
			}
		),
		listSubmittedChangelists: Effect.fn("PerforceHistorySource.listSubmittedChangelists")(
			function* (options: ListSubmittedChangelistsOptions) {
				const result = yield* backend
					.listSubmittedChangelists(options)
					.pipe(
						Effect.mapError((cause) =>
							toMapHistoryError("list submitted changelists", cause)
						)
					);
				return {
					hasMore: result.hasMore,
					items: result.items.map(toSubmittedChange),
					nextBeforeChange: result.nextBeforeChange
				};
			}
		),
		materializeDepotFiles: Effect.fn("PerforceHistorySource.materializeDepotFiles")(function* (
			options: PerforceMaterializationOptions
		) {
			const files = yield* decodeP4MaterializationFiles(
				options.files.map((file) => ({
					action: file.action,
					changelist: file.changelist,
					depotFile: file.depotPath,
					revision: file.revision,
					type: file.type
				}))
			).pipe(
				Effect.mapError(
					() =>
						new MapHistoryError({
							kind: "materialization",
							message:
								"Map History received invalid exact Perforce revision metadata.",
							recovery: "Resolve valid depot revisions before materializing history.",
							retrySafe: false
						})
				)
			);
			const result = yield* backend
				.materializeDepotFiles({ ...options, files })
				.pipe(
					Effect.mapError((cause) => toMapHistoryError("materialize depot files", cause))
				);
			return {
				directory: result.directory,
				files: result.items.map((item) => ({
					file: toDepotFile(item.file),
					localPath: item.localPath
				})),
				totalCount: result.totalCount
			};
		}),
		resolveLocalPath
	});
}

export function perforceHistorySourceLayer(
	options: P4ClientOptions = {}
): Layer.Layer<PerforceHistorySource> {
	const client = new P4Client(options);
	const resolveLocalPath = Effect.fn("PerforceHistorySource.resolveLocalPath")(function* (
		localPath: string
	) {
		const raw = yield* Effect.tryPromise({
			try: () => client.runTaggedJson(["where", localPath]),
			catch: (cause) => toMapHistoryError("resolve local Perforce path", cause)
		});
		const records = yield* decodeP4WhereRecords(raw).pipe(
			Effect.mapError(
				() =>
					new MapHistoryError({
						kind: "ambiguous_depot_mapping",
						message: `Perforce returned an invalid mapping for ${localPath}.`,
						recovery: "Check the Perforce client mapping and retry.",
						retrySafe: false
					})
			)
		);
		if (
			records.length !== 1 ||
			records[0]?.depotFile === undefined ||
			records[0].unmap !== undefined
		) {
			return yield* Effect.fail(
				new MapHistoryError({
					kind: "ambiguous_depot_mapping",
					message: `Perforce could not map ${localPath} to exactly one depot file.`,
					recovery:
						"Use a project path covered by one unambiguous Perforce client mapping.",
					retrySafe: false
				})
			);
		}
		return { depotPath: records[0].depotFile };
	});
	return Layer.succeed(
		PerforceHistorySource,
		makePerforceHistorySource(createP4Service(options), resolveLocalPath)
	);
}

export function makePerforceHistorySourceTestLayer(
	source: PerforceHistorySourceShape
): Layer.Layer<PerforceHistorySource> {
	return Layer.succeed(PerforceHistorySource, PerforceHistorySource.of(source));
}
