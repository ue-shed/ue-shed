import { stat } from "node:fs/promises";
import { EnhancedInputService, EnhancedInputServiceLive } from "@ue-shed/enhanced-input";
import { CURRENT_PROTOCOL_VERSION } from "@ue-shed/protocol";
import {
	aggregateHealth,
	defaultHealthInput,
	observeOperation,
	RuntimeHealthService
} from "@ue-shed/observability";
import { assetReaderLayer, AssetReader, AssetReaderLive } from "@ue-shed/unreal-assets";
import { Context, Effect, Layer, Schema } from "effect";
import { type CliCommand, help } from "./command.js";

// Command-specific feature packages are imported lazily inside their command handlers so
// lightweight invocations (input inspect, help, version, doctor) do not pay module-evaluation
// costs for services they never use. Type checking still covers every dynamic import.

export class CliCommandError extends Schema.TaggedErrorClass<CliCommandError>()("CliCommandError", {
	message: Schema.String
}) {}

export interface CliRuntimeShape {
	readonly print: (value: string) => Effect.Effect<void>;
	readonly setExitCode: (code: number) => Effect.Effect<void>;
}

export class CliRuntime extends Context.Service<CliRuntime, CliRuntimeShape>()(
	"@ue-shed/cli/CliRuntime"
) {}

export const CliRuntimeLive = Layer.succeed(
	CliRuntime,
	CliRuntime.of({
		print: Effect.fn("CliRuntime.print")((value) =>
			Effect.sync(() => process.stdout.write(value)).pipe(Effect.asVoid)
		),
		setExitCode: Effect.fn("CliRuntime.setExitCode")((code) =>
			Effect.sync(() => {
				process.exitCode = code;
			})
		)
	})
);

function messageOf(cause: unknown): string {
	if (typeof cause === "object" && cause !== null && "message" in cause) {
		return String(cause.message);
	}
	return String(cause);
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function readerLayer(reader?: string) {
	return reader === undefined ? AssetReaderLive : assetReaderLayer({ executable: reader });
}

function printJson(value: unknown): Effect.Effect<void, never, CliRuntime> {
	return Effect.flatMap(CliRuntime, (runtime) => runtime.print(json(value)));
}

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

function sessionsProgram(command: CliCommand) {
	if (!("projectRoot" in command)) return Effect.die("Missing session project root");
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
											? {}
											: { atIndex: command.atIndex })
									})
								: command._tag === "SessionsDuplicateRow"
									? yield* sessions.duplicateRow({
											...common,
											rowName: command.rowName,
											sourceRowId: command.sourceRowId,
											...(command.atIndex === undefined
												? {}
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
					default:
						return yield* Effect.die(`Unexpected sessions command: ${command._tag}`);
				}
			}).pipe(
				Effect.provide(authoringSessionServiceLayer({ projectRoot: command.projectRoot })),
				Effect.provide(readerLayer("reader" in command ? command.reader : undefined)),
				Effect.provide(RemoteControlClientLive)
			);
		}
	);
}

export function executeCommand(
	command: CliCommand
): Effect.Effect<void, CliCommandError, CliRuntime> {
	const program = Effect.gen(function* () {
		const runtime = yield* CliRuntime;
		switch (command._tag) {
			case "Doctor": {
				const health = yield* Effect.serviceOption(RuntimeHealthService);
				return yield* printJson(
					health._tag === "Some"
						? yield* health.value.snapshot()
						: aggregateHealth(defaultHealthInput)
				);
			}
			case "Help":
				return yield* runtime.print(`${help}\n`);
			case "Version":
				return yield* runtime.print(
					`ue-shed 0.0.0 (protocol ${CURRENT_PROTOCOL_VERSION.major}.${CURRENT_PROTOCOL_VERSION.minor})\n`
				);
			case "PluginsList": {
				const { listPluginManifest } = yield* Effect.promise(
					() => import("./plugin-installer.js")
				);
				return yield* listPluginManifest(command.manifestPath).pipe(
					Effect.flatMap(printJson)
				);
			}
			case "PluginsVerify": {
				const { verifyPluginManifest } = yield* Effect.promise(
					() => import("./plugin-installer.js")
				);
				return yield* verifyPluginManifest(command).pipe(Effect.flatMap(printJson));
			}
			case "PluginsInstall": {
				const { installPluginBundle } = yield* Effect.promise(
					() => import("./plugin-installer.js")
				);
				return yield* installPluginBundle({
					...(command.artifactPath === undefined
						? {}
						: { artifactPath: command.artifactPath }),
					manifestPath: command.manifestPath,
					projectPath: command.projectRoot
				}).pipe(Effect.flatMap(printJson));
			}
			case "EditorPlaySession": {
				const { EditorPlaySession, EditorPlaySessionLive } = yield* Effect.promise(
					() => import("@ue-shed/engine-discovery")
				);
				const { RemoteControlClientLive } = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const program = Effect.gen(function* () {
					const session = yield* EditorPlaySession;
					if (command.action === "status") {
						return yield* session
							.status(command.endpoint)
							.pipe(Effect.flatMap(printJson));
					}
					const response =
						command.action === "start"
							? yield* session.start(command.endpoint, "play")
							: command.action === "simulate"
								? yield* session.start(command.endpoint, "simulate")
								: command.action === "pause"
									? yield* session.pause(command.endpoint)
									: command.action === "resume"
										? yield* session.resume(command.endpoint)
										: yield* session.stop(command.endpoint);
					yield* printJson(response);
					if (response.outcome === "rejected") yield* runtime.setExitCode(1);
				});
				return yield* program.pipe(
					Effect.provide(
						EditorPlaySessionLive.pipe(Layer.provide(RemoteControlClientLive))
					)
				);
			}
			case "AuditTextures": {
				const { TextureAudit, TextureAuditLive } = yield* Effect.promise(
					() => import("@ue-shed/asset-audits")
				);
				const report = yield* Effect.gen(function* () {
					const audit = yield* TextureAudit;
					return yield* audit.scan({
						projectRoot: command.projectRoot,
						ruleFile: command.ruleFile
					});
				}).pipe(
					Effect.provide(TextureAuditLive),
					Effect.provide(readerLayer(command.reader))
				);
				return yield* printJson(report);
			}
			case "AuthoringTables": {
				const reader = yield* AssetReader;
				return yield* reader
					.discoverTables({ projectRoot: command.projectRoot })
					.pipe(Effect.flatMap(printJson));
			}
			case "AuthoringRelationships": {
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
			}
			case "AuthoringJoin": {
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
			}
			case "AuthoringCatalog":
				return yield* (
					command.endpoint !== undefined
						? catalogWithLive({
								endpoint: command.endpoint,
								projectRoot: command.projectRoot,
								...(command.reader === undefined ? {} : { reader: command.reader })
							})
						: loadCatalog(command)
				).pipe(Effect.flatMap(printJson));
			case "AuthoringParity": {
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
					if (status === "nonconformant")
						return yield* Effect.fail(
							new CliCommandError({
								message: "Saved/live authoring parity did not pass"
							})
						);
				});
				return yield* program.pipe(Effect.provide(RemoteControlClientLive));
			}
			case "AuthoringInspect": {
				const { fingerprintTable } = yield* Effect.promise(
					() => import("@ue-shed/authoring")
				);
				const reader = yield* AssetReader;
				const snapshot = yield* reader.readTable(command.assetPath);
				return yield* printJson({ fingerprint: fingerprintTable(snapshot), snapshot });
			}
			case "AuthoringLiveTables":
				return yield* catalogWithLive(command).pipe(Effect.flatMap(printJson));
			case "AuthoringLiveInspect": {
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
			}
			case "SessionsList":
			case "SessionsCreate":
			case "SessionsShow":
			case "SessionsResume":
			case "SessionsClose":
			case "SessionsDiscard":
			case "SessionsUndo":
			case "SessionsRedo":
			case "SessionsSetCell":
			case "SessionsAddRow":
			case "SessionsDuplicateRow":
			case "SessionsRemoveRow":
			case "SessionsRenameRow":
			case "SessionsReorderRows":
			case "SessionsReview":
			case "SessionsValidate":
			case "SessionsDiff":
			case "SessionsApply":
			case "SessionsReconcile":
			case "SessionsSave":
				return yield* sessionsProgram(command);
			case "TextScan":
			case "TextSearch": {
				const { searchTextCorpus, TextCorpusService, TextCorpusServiceLive } =
					yield* Effect.promise(() => import("@ue-shed/game-text"));
				const corpus = yield* Effect.gen(function* () {
					const service = yield* TextCorpusService;
					return yield* service.scan({ projectRoot: command.projectRoot });
				}).pipe(
					Effect.provide(TextCorpusServiceLive),
					Effect.provide(readerLayer(command.reader))
				);
				return yield* printJson(
					command._tag === "TextScan"
						? corpus
						: {
								schemaVersion: corpus.schemaVersion,
								status: corpus.status,
								query: command.query,
								coverage: corpus.coverage,
								matches: searchTextCorpus(corpus, command.query),
								diagnostics: corpus.diagnostics
							}
				);
			}
			case "InputInspect": {
				const report = yield* Effect.gen(function* () {
					const service = yield* EnhancedInputService;
					const info = yield* Effect.tryPromise({
						try: () => stat(command.path),
						catch: (cause) =>
							new CliCommandError({
								message: `Could not read path ${command.path}: ${String(cause)}`
							})
					});
					if (info.isDirectory()) {
						return yield* service.scan({ projectRoot: command.path });
					}
					return yield* service.inspectPath(command.path);
				}).pipe(
					Effect.provide(EnhancedInputServiceLive),
					Effect.provide(readerLayer(command.reader)),
					Effect.mapError((error) =>
						error instanceof CliCommandError
							? error
							: new CliCommandError({
									message:
										typeof error === "object" &&
										error !== null &&
										"message" in error
											? String(error.message)
											: String(error)
								})
					)
				);
				return yield* printJson(report);
			}
			case "ReviewSetValidate": {
				const { ReviewRepository, ReviewRepositoryLive } = yield* Effect.promise(
					() => import("@ue-shed/cameras")
				);
				const program = Effect.gen(function* () {
					const repository = yield* ReviewRepository;
					const reviewSet = yield* repository.loadSet(command.reviewSetPath);
					return yield* printJson({
						contract: reviewSet.contract,
						id: reviewSet.id,
						profiles: reviewSet.captureProfiles.length,
						status: "valid",
						views: reviewSet.views.length
					});
				});
				return yield* program.pipe(Effect.provide(ReviewRepositoryLive));
			}
			case "ReviewFramingCandidates":
			case "ReviewFramingApprove": {
				const {
					approveFramingCandidate,
					FramingCandidateId,
					generateFramingCandidates,
					ReviewAuthoring,
					ReviewAuthoringLive,
					ReviewRepository,
					ReviewRepositoryLive,
					ReviewViewId
				} = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const { RemoteControlClientLive } = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const program = Effect.gen(function* () {
					const authoring = yield* ReviewAuthoring;
					const selection = yield* authoring.inspectSelection(command.endpoint);
					if (selection.status === "failed")
						return yield* Effect.fail(
							new CliCommandError({
								message: `${selection.message} ${selection.recovery}`
							})
						);
					const candidates = generateFramingCandidates(selection);
					if (command._tag === "ReviewFramingCandidates")
						return yield* printJson({ candidates, selection });
					const candidate = candidates.find(
						(item) => item.id === FramingCandidateId.make(command.candidateId)
					);
					if (!candidate)
						return yield* Effect.fail(
							new CliCommandError({
								message: `Unknown framing candidate: ${command.candidateId}`
							})
						);
					const repository = yield* ReviewRepository;
					const reviewSet = yield* repository.loadSet(command.reviewSetPath);
					const approved = approveFramingCandidate({
						candidate,
						reviewSet,
						subject: {
							actorPath: selection.actorPath,
							diagnosticLabel: selection.displayName,
							kind: "actor_path"
						},
						viewId: ReviewViewId.make(command.viewId)
					});
					if (approved.status === "view_not_found")
						return yield* Effect.fail(
							new CliCommandError({
								message: `Review View ${approved.viewId} was not found`
							})
						);
					yield* repository.saveSet({
						path: command.reviewSetPath,
						reviewSet: approved.reviewSet
					});
					return yield* printJson({
						candidateId: candidate.id,
						status: "approved",
						viewId: command.viewId
					});
				});
				return yield* program.pipe(
					Effect.provide(ReviewRepositoryLive),
					Effect.provide(ReviewAuthoringLive.pipe(Layer.provide(RemoteControlClientLive)))
				);
			}
			case "ReviewAuthoringStart":
			case "ReviewAuthoringBootstrap":
			case "ReviewAuthoringShow":
			case "ReviewAuthoringResume":
			case "ReviewAuthoringDiscard":
			case "ReviewAuthoringReframe":
			case "ReviewAuthoringApprove": {
				const {
					generateFramingCandidates,
					ReviewAuthoring,
					ReviewAuthoringLive,
					ReviewAuthoringSessions,
					ReviewAuthoringSessionsLive,
					ReviewRepositoryLive
				} = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const { RemoteControlClientLive } = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const reviewAuthoring = ReviewAuthoringLive.pipe(
					Layer.provide(RemoteControlClientLive)
				);
				const program = Effect.gen(function* () {
					const sessions = yield* ReviewAuthoringSessions;
					if (command._tag === "ReviewAuthoringShow") {
						return yield* sessions
							.load({
								projectRoot: command.projectRoot,
								sessionId: command.sessionId
							})
							.pipe(Effect.flatMap(printJson));
					}
					if (command._tag === "ReviewAuthoringDiscard") {
						return yield* sessions
							.discard({
								projectRoot: command.projectRoot,
								sessionId: command.sessionId
							})
							.pipe(Effect.flatMap(printJson));
					}
					if (command._tag === "ReviewAuthoringResume") {
						return yield* sessions
							.resume({
								endpoint: command.endpoint,
								projectRoot: command.projectRoot,
								sessionId: command.sessionId
							})
							.pipe(Effect.flatMap(printJson));
					}
					if (command._tag === "ReviewAuthoringApprove") {
						return yield* sessions
							.approve({
								endpoint: command.endpoint,
								projectRoot: command.projectRoot,
								sessionId: command.sessionId
							})
							.pipe(Effect.flatMap(printJson));
					}
					const authoring = yield* ReviewAuthoring;
					const selection = yield* authoring.inspectSelection(command.endpoint);
					if (selection.status === "failed") {
						return yield* Effect.fail(
							new CliCommandError({
								message: `${selection.message} ${selection.recovery}`
							})
						);
					}
					const candidates = generateFramingCandidates(selection);
					const session =
						command._tag === "ReviewAuthoringBootstrap"
							? yield* sessions.start({
									candidates,
									projectRoot: command.projectRoot,
									selection
								})
							: command._tag === "ReviewAuthoringStart"
								? yield* sessions.create({
										candidates,
										projectRoot: command.projectRoot,
										reviewSetPath: command.reviewSetPath,
										selection,
										viewId: command.viewId
									})
								: yield* sessions.reframe({
										candidates,
										projectRoot: command.projectRoot,
										selection,
										sessionId: command.sessionId
									});
					return yield* printJson(session);
				});
				return yield* program.pipe(
					Effect.provide(reviewAuthoring),
					Effect.provide(
						ReviewAuthoringSessionsLive.pipe(
							Layer.provide(Layer.mergeAll(ReviewRepositoryLive, reviewAuthoring))
						)
					)
				);
			}
			case "ReviewCapture": {
				const {
					ReviewCapture,
					ReviewCaptureLive,
					reviewCaptureRemotePortLayer,
					ReviewIdGeneratorLive,
					ReviewRepositoryLive
				} = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const { RemoteControlClientLive } = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const captureDependencies = Layer.mergeAll(
					ReviewRepositoryLive,
					ReviewIdGeneratorLive,
					reviewCaptureRemotePortLayer(command.endpoint).pipe(
						Layer.provide(RemoteControlClientLive)
					)
				);
				const program = Effect.gen(function* () {
					const capture = yield* ReviewCapture;
					const run = yield* capture.captureSet(command);
					yield* printJson(run);
					if (run.status !== "completed") yield* runtime.setExitCode(1);
				});
				return yield* program.pipe(
					Effect.provide(ReviewCaptureLive.pipe(Layer.provide(captureDependencies)))
				);
			}
			case "ReviewHistory": {
				const { ReviewRepository, ReviewRepositoryLive } = yield* Effect.promise(
					() => import("@ue-shed/cameras")
				);
				const program = Effect.gen(function* () {
					const repository = yield* ReviewRepository;
					return yield* repository
						.listRuns(command.projectRoot)
						.pipe(Effect.flatMap((runs) => printJson({ runs })));
				});
				return yield* program.pipe(Effect.provide(ReviewRepositoryLive));
			}
			case "ReviewShow": {
				const { ReviewRepository, ReviewRepositoryLive } = yield* Effect.promise(
					() => import("@ue-shed/cameras")
				);
				const program = Effect.gen(function* () {
					const repository = yield* ReviewRepository;
					return yield* repository
						.loadRun(command.runPath)
						.pipe(Effect.flatMap(printJson));
				});
				return yield* program.pipe(Effect.provide(ReviewRepositoryLive));
			}
		}
	});

	const reader = "reader" in command ? command.reader : undefined;
	return observeOperation(`Cli.${command._tag}`, program).pipe(
		Effect.provide(readerLayer(reader)),
		Effect.mapError((cause) =>
			cause instanceof CliCommandError
				? cause
				: new CliCommandError({ message: messageOf(cause) })
		)
	);
}
