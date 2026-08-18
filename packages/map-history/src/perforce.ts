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

export interface PerforceMapLocation {
	readonly depotPath: string;
	readonly localPath: string;
}

export interface PerforceMapMove {
	readonly change: number;
	readonly fromDepotPath: string;
	readonly toDepotPath: string;
}

export interface PerforceMapLineage {
	readonly locations: readonly PerforceMapLocation[];
	readonly moves: readonly PerforceMapMove[];
}

export interface PerforceMapLineageOptions {
	readonly depotPath: string;
	readonly maxMoves: number;
	readonly maxRevisionRecords: number;
}

export interface PerforceHistorySourceApi {
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
	/** Optional for narrow test sources; the live adapter always provides this capability. */
	readonly resolveMapLineage?: (
		options: PerforceMapLineageOptions
	) => Effect.Effect<PerforceMapLineage, MapHistoryError>;
}

export class PerforceHistorySource extends Context.Service<
	PerforceHistorySource,
	PerforceHistorySourceApi
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
	path: Schema.optionalKey(Schema.String),
	unmap: Schema.optionalKey(Schema.String)
});
const decodeP4WhereRecords = Schema.decodeUnknownEffect(Schema.Array(P4WhereRecord));
const decodeP4TaggedRecords = Schema.decodeUnknownEffect(
	Schema.Array(Schema.Record(Schema.String, Schema.Json))
);

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
		...(description.value === undefined ? undefined : { description: description.value }),
		...(submittedAt.value === undefined ? undefined : { submittedAt: submittedAt.value }),
		...(user.value === undefined ? undefined : { user: user.value })
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
	const tag = cause instanceof Object && "_tag" in cause ? cause._tag : undefined;
	const category = cause instanceof Object && "category" in cause ? cause.category : undefined;
	const message = cause instanceof Object && "message" in cause ? cause.message : undefined;
	const reason = cause instanceof Object && "reason" in cause ? cause.reason : undefined;
	const kind =
		tag === "P4MaterializationError"
			? reason === "limit_exceeded"
				? "resource_limit"
				: "materialization"
			: tag === "P4CommandError" && category === "authentication"
				? "perforce_authentication"
				: tag === "P4CommandError" &&
					  (category === "server_config" || category === "client")
					? "perforce_configuration"
					: "perforce_command";
	return new MapHistoryError({
		cause,
		kind,
		message: Schema.is(Schema.String)(message) ? message : `${operation} failed.`,
		recovery:
			kind === "perforce_authentication"
				? "Authenticate with Perforce and retry."
				: kind === "perforce_configuration"
					? "Check the active Perforce server and client configuration."
					: kind === "resource_limit"
						? "Narrow the history range or raise the explicit operation limit."
						: "Inspect the Perforce diagnostic and retry when it is safe.",
		retrySafe:
			tag === "P4TimeoutError" || (tag === "P4CommandError" && category === "connection")
	});
}

function mapLineageError(
	kind: "ambiguous_map_lineage" | "map_lineage_limit",
	message: string
): MapHistoryError {
	return new MapHistoryError({
		kind,
		message,
		recovery:
			kind === "map_lineage_limit"
				? "Choose a range with fewer direct map relocations."
				: "Inspect the map's direct Perforce move records and resolve the ambiguity before retrying.",
		retrySafe: false
	});
}

function taggedString(record: Schema.JsonObject, key: string): string | undefined {
	const value = record[key];
	return Schema.is(Schema.String)(value) ? value : undefined;
}

function positiveTaggedInt(record: Schema.JsonObject, key: string): number | undefined {
	const value = taggedString(record, key);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function directMovesFromFilelog(records: readonly Schema.JsonObject[]): readonly PerforceMapMove[] {
	const moves: PerforceMapMove[] = [];
	for (const record of records) {
		const depotPath = taggedString(record, "depotFile");
		if (depotPath === undefined) continue;
		for (const key of Object.keys(record)) {
			const match = /^action(\d+)$/u.exec(key);
			if (match === null) continue;
			const revisionIndex = match[1];
			const action = taggedString(record, key);
			const change = positiveTaggedInt(record, `change${revisionIndex}`);
			if (action === undefined || change === undefined) continue;
			if (action === "move/add") {
				for (const integrationKey of Object.keys(record)) {
					const integration = new RegExp(`^how${revisionIndex},(\\d+)$`, "u").exec(
						integrationKey
					);
					if (
						integration === null ||
						taggedString(record, integrationKey) !== "moved from"
					)
						continue;
					const fromDepotPath = taggedString(
						record,
						`file${revisionIndex},${integration[1]}`
					);
					if (fromDepotPath !== undefined) {
						moves.push({ change, fromDepotPath, toDepotPath: depotPath });
					}
				}
				continue;
			}
			if (action !== "move/delete") continue;
			for (const integrationKey of Object.keys(record)) {
				const integration = /^how(\d+),(\d+)$/u.exec(integrationKey);
				if (integration === null || taggedString(record, integrationKey) !== "moved into")
					continue;
				const toDepotPath = taggedString(record, `file${integration[1]},${integration[2]}`);
				if (toDepotPath !== undefined) {
					moves.push({ change, fromDepotPath: depotPath, toDepotPath });
				}
			}
		}
	}
	const unique = new Map<string, PerforceMapMove>();
	for (const move of moves) {
		unique.set(`${move.change}\u0000${move.fromDepotPath}\u0000${move.toDepotPath}`, move);
	}
	return [...unique.values()];
}

function orderedDirectLineage(options: {
	readonly moves: readonly PerforceMapMove[];
	readonly selectedDepotPath: string;
}) {
	const outgoing = new Map<string, PerforceMapMove>();
	const incoming = new Map<string, PerforceMapMove>();
	for (const move of options.moves) {
		const previousOutgoing = outgoing.get(move.fromDepotPath);
		const previousIncoming = incoming.get(move.toDepotPath);
		if (
			(previousOutgoing !== undefined &&
				(previousOutgoing.toDepotPath !== move.toDepotPath ||
					previousOutgoing.change !== move.change)) ||
			(previousIncoming !== undefined &&
				(previousIncoming.fromDepotPath !== move.fromDepotPath ||
					previousIncoming.change !== move.change))
		) {
			throw mapLineageError(
				"ambiguous_map_lineage",
				`Perforce reported multiple direct move paths for ${options.selectedDepotPath}.`
			);
		}
		outgoing.set(move.fromDepotPath, move);
		incoming.set(move.toDepotPath, move);
	}

	let oldest = options.selectedDepotPath;
	const visitedBackwards = new Set([oldest]);
	while (incoming.has(oldest)) {
		const prior = incoming.get(oldest);
		if (prior === undefined) break;
		oldest = prior.fromDepotPath;
		if (visitedBackwards.has(oldest)) {
			throw mapLineageError(
				"ambiguous_map_lineage",
				`Perforce reported a direct-move cycle for ${options.selectedDepotPath}.`
			);
		}
		visitedBackwards.add(oldest);
	}

	const depotPaths = [oldest];
	const orderedMoves: PerforceMapMove[] = [];
	const visitedForwards = new Set([oldest]);
	while (outgoing.has(depotPaths.at(-1) ?? "")) {
		const move = outgoing.get(depotPaths.at(-1) ?? "");
		if (move === undefined) break;
		if (visitedForwards.has(move.toDepotPath)) {
			throw mapLineageError(
				"ambiguous_map_lineage",
				`Perforce reported a direct-move cycle for ${options.selectedDepotPath}.`
			);
		}
		orderedMoves.push(move);
		depotPaths.push(move.toDepotPath);
		visitedForwards.add(move.toDepotPath);
	}
	return { depotPaths, moves: orderedMoves };
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
		if (!(backend instanceof Function)) return backend;
		return backend(yield* selectedProjectRoot());
	});
}

export function makePerforceHistorySource(
	backend: PerforceBackend | PerforceBackendResolver,
	resolveLocalPath: PerforceHistorySourceApi["resolveLocalPath"] = (localPath) =>
		Effect.fail(
			new MapHistoryError({
				kind: "perforce_configuration",
				message: `The Perforce test source does not resolve ${localPath}.`,
				recovery: "Provide a resolveLocalPath test implementation.",
				retrySafe: false
			})
		),
	resolveMapLineage?: NonNullable<PerforceHistorySourceApi["resolveMapLineage"]>
): PerforceHistorySourceApi {
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
		resolveLocalPath,
		...(resolveMapLineage === undefined ? undefined : { resolveMapLineage })
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
				? undefined
				: { P4PORT: localEnvironment.p4Port }),
			...(localEnvironment?.p4User === null || localEnvironment?.p4User === undefined
				? undefined
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
			const where = Effect.fn("PerforceHistorySource.where")(function* (path: string) {
				const projectRoot = yield* selectedProjectRoot();
				const context = yield* contextForProject(projectRoot).pipe(
					Effect.mapError((cause) => toMapHistoryError("resolve Perforce path", cause))
				);
				const raw = yield* Effect.tryPromise({
					try: () => context.client.runTaggedJson(["where", path]),
					catch: (cause) => toMapHistoryError("resolve Perforce path", cause)
				});
				const records = yield* decodeP4WhereRecords(raw).pipe(
					Effect.mapError(
						() =>
							new MapHistoryError({
								kind: "ambiguous_depot_mapping",
								message: `Perforce returned an invalid mapping for ${path}.`,
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
							message: `Perforce could not map ${path} to exactly one depot file.`,
							recovery:
								"Use a project path covered by one unambiguous Perforce client mapping.",
							retrySafe: false
						})
					);
				}
				return records[0];
			});
			const resolveLocalPath = Effect.fn("PerforceHistorySource.resolveLocalPath")(function* (
				localPath: string
			) {
				const mapping = yield* where(localPath);
				if (mapping.depotFile === undefined) {
					return yield* Effect.fail(
						new MapHistoryError({
							kind: "ambiguous_depot_mapping",
							message: `Perforce did not return a depot path for ${localPath}.`,
							recovery: "Check the Perforce client mapping and retry.",
							retrySafe: false
						})
					);
				}
				return { depotPath: mapping.depotFile };
			});
			const resolveMapLineage = Effect.fn("PerforceHistorySource.resolveMapLineage")(
				function* (request: PerforceMapLineageOptions) {
					const projectRoot = yield* selectedProjectRoot();
					const context = yield* contextForProject(projectRoot).pipe(
						Effect.mapError((cause) => toMapHistoryError("resolve map lineage", cause))
					);
					const pending = [request.depotPath];
					const queried = new Set<string>();
					const discovered = new Map<string, PerforceMapMove>();
					while (pending.length > 0) {
						const depotPath = pending.shift();
						if (depotPath === undefined || queried.has(depotPath)) continue;
						queried.add(depotPath);
						const raw = yield* Effect.tryPromise({
							try: () =>
								context.client.runTaggedJson([
									"filelog",
									"-i",
									"-m",
									String(request.maxRevisionRecords),
									depotPath
								]),
							catch: (cause) => toMapHistoryError("resolve map lineage", cause)
						});
						const records = yield* decodeP4TaggedRecords(raw).pipe(
							Effect.mapError(() =>
								mapLineageError(
									"ambiguous_map_lineage",
									`Perforce returned invalid filelog records for ${depotPath}.`
								)
							)
						);
						for (const move of directMovesFromFilelog(records)) {
							discovered.set(
								`${move.change}\u0000${move.fromDepotPath}\u0000${move.toDepotPath}`,
								move
							);
							if (!queried.has(move.fromDepotPath)) pending.push(move.fromDepotPath);
							if (!queried.has(move.toDepotPath)) pending.push(move.toDepotPath);
						}
						if (discovered.size > request.maxMoves) {
							return yield* Effect.fail(
								mapLineageError(
									"map_lineage_limit",
									`Map lineage exceeds the direct-move limit of ${request.maxMoves}.`
								)
							);
						}
					}
					const ordered = yield* Effect.try({
						try: () =>
							orderedDirectLineage({
								moves: [...discovered.values()],
								selectedDepotPath: request.depotPath
							}),
						catch: (cause) =>
							cause instanceof MapHistoryError
								? cause
								: mapLineageError(
										"ambiguous_map_lineage",
										`Could not order the direct move lineage for ${request.depotPath}.`
									)
					});
					const locations: PerforceMapLocation[] = [];
					for (const depotPath of ordered.depotPaths) {
						const mapping = yield* where(depotPath);
						if (mapping.path === undefined) {
							return yield* Effect.fail(
								new MapHistoryError({
									kind: "ambiguous_depot_mapping",
									message: `Perforce did not return a workspace path for ${depotPath}.`,
									recovery: "Check the Perforce client mapping and retry.",
									retrySafe: false
								})
							);
						}
						locations.push({ depotPath, localPath: mapping.path });
					}
					return { locations, moves: ordered.moves };
				}
			);
			return makePerforceHistorySource(
				backendForProject,
				resolveLocalPath,
				resolveMapLineage
			);
		})
	);
}

export function makePerforceHistorySourceTestLayer(
	source: PerforceHistorySourceApi
): Layer.Layer<PerforceHistorySource> {
	return Layer.succeed(PerforceHistorySource, PerforceHistorySource.of(source));
}
