import { AssetReader } from "@ue-shed/unreal-assets";
import { Effect } from "effect";
import { CliCommandError, printJson } from "../cli-runtime.js";
import { observeCliOperation, readerLayer } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type Command<Tag extends CliCommand["_tag"]> = Extract<CliCommand, { readonly _tag: Tag }>;
type SessionCommand = Command<
	| "SessionsList"
	| "SessionsCreate"
	| "SessionsShow"
	| "SessionsResume"
	| "SessionsClose"
	| "SessionsDiscard"
	| "SessionsUndo"
	| "SessionsRedo"
	| "SessionsSetCell"
	| "SessionsAddRow"
	| "SessionsDuplicateRow"
	| "SessionsRemoveRow"
	| "SessionsRenameRow"
	| "SessionsReorderRows"
	| "SessionsReview"
	| "SessionsValidate"
	| "SessionsDiff"
	| "SessionsApply"
	| "SessionsReconcile"
	| "SessionsSave"
>;

function loadCatalog(args: { readonly projectRoot?: string; readonly reader?: string }) {
	return Effect.gen(function* () {
		const { AuthoringCatalog, AuthoringCatalogLive } = yield* Effect.promise(
			() => import("@ue-shed/authoring-catalog")
		);
		const program = Effect.gen(function* () {
			const catalog = yield* AuthoringCatalog;
			return yield* catalog.discover(
				args.projectRoot === undefined ? {} : { projectRoot: args.projectRoot }
			);
		});
		return yield* program.pipe(Effect.provide(AuthoringCatalogLive));
	}).pipe(Effect.provide(readerLayer(args.reader)));
}

function catalogWithLive(args: {
	readonly endpoint: string;
	readonly projectRoot?: string;
	readonly reader?: string;
}) {
	return Effect.gen(function* () {
		const { authoringLiveConnectionLayer, AuthoringCatalog, AuthoringCatalogLive } =
			yield* Effect.promise(() => import("@ue-shed/authoring-catalog"));
		const { connectUnrealAuthoring, RemoteControlClientLive } = yield* Effect.promise(
			() => import("@ue-shed/unreal-connection")
		);
		const program = Effect.gen(function* () {
			const connection = yield* connectUnrealAuthoring(args.endpoint);
			const inner = Effect.gen(function* () {
				const catalog = yield* AuthoringCatalog;
				return yield* catalog.discover(
					args.projectRoot === undefined ? {} : { projectRoot: args.projectRoot }
				);
			});
			return yield* inner.pipe(
				Effect.provide(AuthoringCatalogLive),
				Effect.provide(authoringLiveConnectionLayer(connection))
			);
		});
		return yield* program.pipe(
			Effect.provide(RemoteControlClientLive),
			Effect.provide(readerLayer(args.reader))
		);
	});
}

export const runAuthoringTables = Effect.fn("Cli.workflow.authoring_tables")(
	(command: Command<"AuthoringTables">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const reader = yield* AssetReader;
				return yield* reader
					.discoverTables({ projectRoot: command.projectRoot })
					.pipe(Effect.flatMap(printJson));
			}).pipe(Effect.provide(readerLayer(command.reader)))
		)
);

export const runAuthoringRelationships = Effect.fn("Cli.workflow.authoring_relationships")(
	(command: Command<"AuthoringRelationships">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { makeRowReferenceReport } = yield* Effect.promise(
					() => import("@ue-shed/authoring")
				);
				const reader = yield* AssetReader;
				const catalog = yield* reader.discoverTables({ projectRoot: command.projectRoot });
				const snapshots = yield* Effect.forEach(
					catalog.tables,
					(table) => reader.readTable(table.assetPath),
					{ concurrency: 4 }
				);
				return yield* printJson(makeRowReferenceReport(snapshots));
			}).pipe(Effect.provide(readerLayer(command.reader)))
		)
);

export const runAuthoringJoin = Effect.fn("Cli.workflow.authoring_join")(
	(command: Command<"AuthoringJoin">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { buildJoinedView } = yield* Effect.promise(
					() => import("@ue-shed/authoring")
				);
				const reader = yield* AssetReader;
				const catalog = yield* reader.discoverTables({ projectRoot: command.projectRoot });
				const snapshots = yield* Effect.forEach(
					catalog.tables,
					(table) => reader.readTable(table.assetPath),
					{ concurrency: 4 }
				);
				return yield* printJson(
					buildJoinedView({
						query: {
							referenceFieldName: command.referenceFieldName,
							sourceTableObjectPath: command.sourceTableObjectPath
						},
						snapshots
					})
				);
			}).pipe(Effect.provide(readerLayer(command.reader)))
		)
);

export const runAuthoringAnalyze = Effect.fn("Cli.workflow.authoring_analyze")(
	(command: Command<"AuthoringAnalyze">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { buildAnalysisPlan } = yield* Effect.promise(
					() => import("@ue-shed/authoring")
				);
				const reader = yield* AssetReader;
				const catalog = yield* reader.discoverTables({ projectRoot: command.projectRoot });
				const matches = catalog.tables.filter(
					(table) => table.objectPath === command.tableObjectPath
				);
				if (matches.length === 0) {
					return yield* new CliCommandError({
						message: `No saved DataTable ${command.tableObjectPath} in ${command.projectRoot}.`
					});
				}
				if (matches.length > 1) {
					return yield* new CliCommandError({
						message: `Multiple saved DataTables share ${command.tableObjectPath}.`
					});
				}
				const snapshot = yield* reader.readTable(matches[0]!.assetPath);
				return yield* printJson(buildAnalysisPlan({ snapshot }));
			}).pipe(Effect.provide(readerLayer(command.reader)))
		)
);

export const runAuthoringCatalog = Effect.fn("Cli.workflow.authoring_catalog")(
	(command: Command<"AuthoringCatalog">) =>
		observeCliOperation(
			command._tag,
			(command.endpoint !== undefined
				? catalogWithLive({
						endpoint: command.endpoint,
						projectRoot: command.projectRoot,
						...(command.reader === undefined ? undefined : { reader: command.reader })
					})
				: loadCatalog(command)
			).pipe(Effect.flatMap(printJson))
		)
);

export const runAuthoringParity = Effect.fn("Cli.workflow.authoring_parity")(
	(command: Command<"AuthoringParity">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { fingerprintTable } = yield* Effect.promise(
					() => import("@ue-shed/authoring")
				);
				const { connectUnrealAuthoring, RemoteControlClientLive } = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const program = Effect.gen(function* () {
					const connection = yield* connectUnrealAuthoring(command.endpoint);
					const catalog = yield* catalogWithLive(command);
					const missingAuthorities = catalog.tables
						.filter(
							(table) =>
								!table.authorities.some(({ authority }) => authority === "saved") ||
								!table.authorities.some(({ authority }) => authority === "live")
						)
						.map(({ objectPath }) => objectPath);
					const diverged = catalog.tables.flatMap((table) =>
						table.divergence.status === "detected"
							? [{ fields: table.divergence.fields, objectPath: table.objectPath }]
							: []
					);
					const schemaGaps = catalog.tables.flatMap((table) => {
						const authorities = table.authorities
							.filter(({ schema }) => schema.status === "unavailable")
							.map(({ authority }) => authority);
						return authorities.length > 0
							? [{ authorities, objectPath: table.objectPath }]
							: [];
					});
					const reader = yield* AssetReader;
					const saved = yield* reader.discoverTables({
						projectRoot: command.projectRoot
					});
					const savedSnapshots = yield* Effect.forEach(
						saved.tables,
						(table) => reader.readTable(table.assetPath),
						{ concurrency: 4 }
					);
					const liveSnapshots = yield* connection.listTableObjectPaths().pipe(
						Effect.flatMap((paths) =>
							Effect.forEach(paths, connection.getTableSnapshot, {
								concurrency: 4
							})
						)
					);
					const liveByPath = new Map(
						liveSnapshots.map((snapshot) => [snapshot.table.objectPath, snapshot])
					);
					const semanticMismatches = savedSnapshots.flatMap((savedSnapshot) => {
						const live = liveByPath.get(savedSnapshot.table.objectPath);
						if (!live) return [];
						const savedFingerprint = fingerprintTable(savedSnapshot);
						const liveFingerprint = fingerprintTable(live);
						return savedFingerprint === liveFingerprint
							? []
							: [
									{
										liveFingerprint,
										objectPath: savedSnapshot.table.objectPath,
										savedFingerprint
									}
								];
					});
					const status =
						catalog.diagnostics.length === 0 &&
						missingAuthorities.length === 0 &&
						diverged.length === 0 &&
						semanticMismatches.length === 0
							? "conformant"
							: "nonconformant";
					yield* printJson({
						contract: {
							name: "unreal-authoring-parity",
							version: { major: 1, minor: 0 }
						},
						diagnostics: catalog.diagnostics,
						diverged,
						missingAuthorities,
						schemaGaps,
						semanticMismatches,
						status
					});
					if (status === "nonconformant") {
						return yield* Effect.fail(
							new CliCommandError({
								message: "Saved/live authoring parity did not pass"
							})
						);
					}
				});
				return yield* program.pipe(Effect.provide(RemoteControlClientLive));
			}).pipe(Effect.provide(readerLayer(command.reader)))
		)
);

export const runAuthoringInspect = Effect.fn("Cli.workflow.authoring_inspect")(
	(command: Command<"AuthoringInspect">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { fingerprintTable } = yield* Effect.promise(
					() => import("@ue-shed/authoring")
				);
				const reader = yield* AssetReader;
				const snapshot = yield* reader.readTable(command.assetPath);
				return yield* printJson({ fingerprint: fingerprintTable(snapshot), snapshot });
			}).pipe(Effect.provide(readerLayer(command.reader)))
		)
);

export const runAuthoringLiveTables = Effect.fn("Cli.workflow.authoring_live_tables")(
	(command: Command<"AuthoringLiveTables">) =>
		observeCliOperation(command._tag, catalogWithLive(command).pipe(Effect.flatMap(printJson)))
);

export const runAuthoringLiveInspect = Effect.fn("Cli.workflow.authoring_live_inspect")(
	(command: Command<"AuthoringLiveInspect">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { fingerprintTable } = yield* Effect.promise(
					() => import("@ue-shed/authoring")
				);
				const { connectUnrealAuthoring, RemoteControlClientLive } = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const program = Effect.gen(function* () {
					const connection = yield* connectUnrealAuthoring(command.endpoint);
					const snapshot = yield* connection.getTableSnapshot(command.tablePath);
					return yield* printJson({ fingerprint: fingerprintTable(snapshot), snapshot });
				});
				return yield* program.pipe(Effect.provide(RemoteControlClientLive));
			})
		)
);

function sessionProgram(command: SessionCommand) {
	return Effect.flatMap(
		Effect.all({
			authoring: Effect.promise(() => import("@ue-shed/authoring")),
			connection: Effect.promise(() => import("@ue-shed/unreal-connection"))
		}),
		({ authoring, connection }) => {
			const {
				authoringSessionLivePortLayer,
				authoringSessionServiceLayer,
				AuthoringSessions,
				workingTable
			} = authoring;
			const { connectUnrealAuthoring, RemoteControlClientLive } = connection;
			return Effect.gen(function* () {
				const sessions = yield* AuthoringSessions;
				switch (command._tag) {
					case "SessionsList":
						return yield* sessions.list().pipe(Effect.flatMap(printJson));
					case "SessionsCreate": {
						const reader = yield* AssetReader;
						const snapshot = yield* reader.readTable(command.assetPath);
						return yield* sessions
							.create([snapshot], command.id ? { id: command.id } : undefined)
							.pipe(Effect.flatMap(printJson));
					}
					case "SessionsShow":
						return yield* sessions
							.open(command.sessionId)
							.pipe(Effect.flatMap(printJson));
					case "SessionsResume":
						return yield* sessions
							.resume(command.sessionId)
							.pipe(Effect.flatMap(printJson));
					case "SessionsClose":
						return yield* sessions
							.close(command.sessionId)
							.pipe(Effect.flatMap(printJson));
					case "SessionsDiscard":
						yield* sessions.discard(command.sessionId);
						return yield* printJson({ id: command.sessionId, status: "discarded" });
					case "SessionsUndo":
						return yield* sessions
							.undo(command.sessionId)
							.pipe(Effect.flatMap(printJson));
					case "SessionsRedo":
						return yield* sessions
							.redo(command.sessionId)
							.pipe(Effect.flatMap(printJson));
					case "SessionsReview":
						return yield* sessions
							.review(command.sessionId)
							.pipe(Effect.flatMap(printJson));
					case "SessionsValidate":
						return yield* sessions
							.validate(command.sessionId)
							.pipe(Effect.flatMap(printJson));
					case "SessionsDiff":
						return yield* sessions
							.diff(command.sessionId)
							.pipe(Effect.flatMap(printJson));
					case "SessionsSetCell": {
						const next = yield* sessions.setCells({
							edits: [
								{
									fieldName: command.fieldName,
									rowId: command.rowId,
									value: command.value
								}
							],
							sessionId: command.sessionId,
							tableObjectPath: command.tablePath
						});
						return yield* printJson({
							session: next,
							working: workingTable(next.draft, command.tablePath)
						});
					}
					case "SessionsAddRow":
					case "SessionsDuplicateRow":
					case "SessionsRemoveRow":
					case "SessionsRenameRow":
					case "SessionsReorderRows": {
						const common = {
							sessionId: command.sessionId,
							tableObjectPath: command.tablePath
						};
						const next =
							command._tag === "SessionsAddRow"
								? yield* sessions.addRow({
										...common,
										rowName: command.rowName,
										...(command.atIndex === undefined
											? undefined
											: { atIndex: command.atIndex })
									})
								: command._tag === "SessionsDuplicateRow"
									? yield* sessions.duplicateRow({
											...common,
											rowName: command.rowName,
											sourceRowId: command.sourceRowId,
											...(command.atIndex === undefined
												? undefined
												: { atIndex: command.atIndex })
										})
									: command._tag === "SessionsRemoveRow"
										? yield* sessions.removeRow({
												...common,
												rowId: command.rowId
											})
										: command._tag === "SessionsRenameRow"
											? yield* sessions.renameRow({
													...common,
													rowId: command.rowId,
													rowName: command.rowName
												})
											: yield* sessions.reorderRows({
													...common,
													rowIds: command.rowIds
												});
						return yield* printJson({
							session: next,
							working: workingTable(next.draft, command.tablePath)
						});
					}
					case "SessionsApply":
					case "SessionsReconcile":
					case "SessionsSave": {
						const connection = yield* connectUnrealAuthoring(command.endpoint);
						const limits = connection.manifest.authoringLimits;
						if (command._tag === "SessionsApply" && limits === undefined) {
							return yield* Effect.fail(
								new CliCommandError({
									message: "Editor did not negotiate authoring mutation limits"
								})
							);
						}
						if (command._tag === "SessionsApply") {
							if (limits === undefined)
								return yield* Effect.die("Checked mutation limits missing");
							const session = yield* sessions
								.apply(command.sessionId, limits)
								.pipe(Effect.provide(authoringSessionLivePortLayer(connection)));
							return yield* printJson({ session });
						}
						const session =
							command._tag === "SessionsReconcile"
								? yield* sessions
										.reconcileApply(command.sessionId)
										.pipe(
											Effect.provide(
												authoringSessionLivePortLayer(connection)
											)
										)
								: yield* sessions
										.save(command.sessionId)
										.pipe(
											Effect.provide(
												authoringSessionLivePortLayer(connection)
											)
										);
						return yield* printJson({ session });
					}
				}
			}).pipe(
				Effect.provide(authoringSessionServiceLayer({ projectRoot: command.projectRoot })),
				Effect.provide(readerLayer("reader" in command ? command.reader : undefined)),
				Effect.provide(RemoteControlClientLive)
			);
		}
	);
}

export const runAuthoringSession = Effect.fn("Cli.workflow.authoring_session")(
	(command: SessionCommand) => observeCliOperation(command._tag, sessionProgram(command))
);
