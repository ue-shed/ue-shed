import { Cache, Context, Effect, Layer, Option, Schema } from "effect";
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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/** The selected project root used to resolve local Perforce configuration and workspace context. */
export const PerforceProjectContext = Context.Service<string>(
	"@ue-shed/map-history/PerforceProjectContext"
);

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

type PerforceBackendResolver = (projectRoot: string | undefined) => PerforceBackend;

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

function selectedProjectRoot(): Effect.Effect<string | undefined> {
	return Effect.map(Effect.serviceOption(PerforceProjectContext), (root) =>
		Option.isSome(root) ? root.value : undefined
	);
}

function resolveBackend(
	backend: PerforceBackend | PerforceBackendResolver
): Effect.Effect<PerforceBackend> {
	return Effect.gen(function* () {
		if (typeof backend !== "function") return backend;
		return backend(yield* selectedProjectRoot());
	});
}

export function makePerforceHistorySource(
	backend: PerforceBackend | PerforceBackendResolver,
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
			const result = yield* (yield* resolveBackend(backend))
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
				const result = yield* (yield* resolveBackend(backend))
					.listDepotFilesAtChange(options)
					.pipe(Effect.mapError((cause) => toMapHistoryError("list depot files", cause)));
				return { files: result.items.map(toDepotFile), hasMore: result.hasMore };
			}
		),
		listSubmittedChangelists: Effect.fn("PerforceHistorySource.listSubmittedChangelists")(
			function* (options: ListSubmittedChangelistsOptions) {
				const result = yield* (yield* resolveBackend(backend))
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
			const result = yield* (yield* resolveBackend(backend))
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

function localRootKey(root: string): string {
	return resolve(root)
		.replace(/[\\/]+$/u, "")
		.toLocaleLowerCase("en-US");
}

const p4ConfigBypassPath = join(tmpdir(), "ue-shed-no-p4config");

/** Selects the client whose local workspace root is the selected project root. */
export function selectPerforceWorkspace(options: {
	readonly configuredClient: string | null;
	readonly projectRoot: string;
	readonly workspaces: readonly { readonly client: string; readonly root: string }[];
}): string | undefined {
	const matching = options.workspaces.filter(
		(workspace) => localRootKey(workspace.root) === localRootKey(options.projectRoot)
	);
	if (matching.length === 1) return matching[0]?.client;
	return matching.some((workspace) => workspace.client === options.configuredClient)
		? (options.configuredClient ?? undefined)
		: undefined;
}

async function optionsForProject(options: P4ClientOptions, projectRoot: string | undefined) {
	if (projectRoot === undefined) return options;

	const projectOptions: P4ClientOptions = { ...options, cwd: projectRoot };
	const probe = new P4Client(projectOptions);
	const localEnvironment = await probe
		.getEnvironment({ mode: "local", refresh: true })
		.catch(() => undefined);
	const environment = await probe.getEnvironment({ refresh: true }).catch(() => undefined);
	const configuredClient = localEnvironment?.p4Client ?? environment?.p4Client ?? null;
	const user = environment?.p4User ?? localEnvironment?.p4User;
	const workspaces =
		user === null || user === undefined
			? []
			: await probe
					.listWorkspaces({
						includeNonLocal: true,
						refresh: true,
						user
					})
					.catch(() => []);
	const selectedClient = selectPerforceWorkspace({
		configuredClient,
		projectRoot,
		workspaces
	});
	if (selectedClient === undefined) return projectOptions;
	return {
		...projectOptions,
		env: {
			...(localEnvironment?.p4Port === null || localEnvironment?.p4Port === undefined
				? {}
				: { P4PORT: localEnvironment.p4Port }),
			...(localEnvironment?.p4User === null || localEnvironment?.p4User === undefined
				? {}
				: { P4USER: localEnvironment.p4User }),
			...options.env,
			P4CONFIG: p4ConfigBypassPath,
			P4CLIENT: selectedClient
		}
	};
}

export function perforceHistorySourceLayer(
	options: P4ClientOptions = {}
): Layer.Layer<PerforceHistorySource> {
	return Layer.effect(
		PerforceHistorySource,
		Effect.gen(function* () {
			const contexts = yield* Cache.makeWith(
				(projectRoot: string | undefined) =>
					Effect.tryPromise({
						try: () => optionsForProject(options, projectRoot),
						catch: (cause) => cause
					}).pipe(
						Effect.map((resolvedOptions) => ({
							client: new P4Client(resolvedOptions),
							service: createP4Service(resolvedOptions)
						}))
					),
				{ capacity: 4 }
			);
			const contextForProject = (projectRoot: string | undefined) =>
				Cache.get(contexts, projectRoot);
			const backendForProject: PerforceBackendResolver = (projectRoot) => {
				const service = contextForProject(projectRoot);
				return {
					describeChangelist: (change) =>
						service.pipe(
							Effect.flatMap((current) => current.service.describeChangelist(change))
						),
					listDepotFilesAtChange: (request) =>
						service.pipe(
							Effect.flatMap((current) =>
								current.service.listDepotFilesAtChange(request)
							)
						),
					listSubmittedChangelists: (request) =>
						service.pipe(
							Effect.flatMap((current) =>
								current.service.listSubmittedChangelists(request)
							)
						),
					materializeDepotFiles: (request) =>
						service.pipe(
							Effect.flatMap((current) =>
								current.service.materializeDepotFiles(request)
							)
						)
				};
			};
			const resolveLocalPath = Effect.fn("PerforceHistorySource.resolveLocalPath")(function* (
				localPath: string
			) {
				const projectRoot = yield* selectedProjectRoot();
				const context = yield* contextForProject(projectRoot).pipe(
					Effect.mapError((cause) =>
						toMapHistoryError("resolve local Perforce path", cause)
					)
				);
				const raw = yield* Effect.tryPromise({
					try: () => context.client.runTaggedJson(["where", localPath]),
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
			return makePerforceHistorySource(backendForProject, resolveLocalPath);
		})
	);
}

export function makePerforceHistorySourceTestLayer(
	source: PerforceHistorySourceShape
): Layer.Layer<PerforceHistorySource> {
	return Layer.succeed(PerforceHistorySource, PerforceHistorySource.of(source));
}
