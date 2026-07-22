import {
	authoringSessionLivePortLayer,
	authoringSessionServiceLayer,
	AuthoringSessionLiveError,
	AuthoringSessions,
	fingerprintTable,
	reviewAuthoringSession,
	workingTable,
	type AuthoringSessionDocument
} from "@ue-shed/authoring";
import { AuthoringCatalog, AuthoringLiveConnection } from "@ue-shed/authoring-catalog";
import {
	AuthoringClient,
	AuthoringClientError,
	type AuthoringClientShape,
	type AuthoringAuthority,
	type AuthoringCatalogResult,
	type AuthoringCatalogProgress,
	type AuthoringLoadResult,
	type AuthoringSessionResult,
	type AuthoringSessionFailure,
	type AuthoringSessionListResult,
	type AuthoringSessionReviewResult,
	type AuthoringSessionView,
	type AuthoringSessionIntent
} from "@ue-shed/authoring-sdk";
import type { AuthoringTableSnapshot } from "@ue-shed/protocol";
import { AssetReader } from "@ue-shed/unreal-assets";
import {
	connectUnrealAuthoring,
	RemoteControlClient,
	type UnrealAuthoringConnection,
	type UnrealCapabilityError,
	type UnrealConnectionError
} from "@ue-shed/unreal-connection";
import { Cache, Context, Duration, Effect, Exit, Layer, Option, Ref, Result } from "effect";
import { ShedHostConfiguration } from "./configuration.js";
import { AuthoringFilePicker } from "./file-picker.js";

interface CatalogIndex {
	readonly assetPaths: ReadonlyMap<string, string>;
	readonly liveObjectPaths: ReadonlySet<string>;
}

const emptyCatalogIndex: CatalogIndex = { assetPaths: new Map(), liveObjectPaths: new Set() };

export interface ShedAuthoringShape {
	readonly catalogProgress?: () => Effect.Effect<AuthoringCatalogProgress>;
	readonly applySession: (sessionId: string) => Effect.Effect<AuthoringSessionResult>;
	readonly beginSession: (objectPath: string) => Effect.Effect<AuthoringSessionResult>;
	readonly discardSession: (sessionId: string) => Effect.Effect<AuthoringSessionListResult>;
	readonly listSessions: () => Effect.Effect<AuthoringSessionListResult>;
	readonly openSession: (sessionId: string) => Effect.Effect<AuthoringSessionResult>;
	readonly chooseTable: () => Effect.Effect<AuthoringLoadResult, AuthoringClientError>;
	readonly configuredCatalog: () => Effect.Effect<AuthoringCatalogResult>;
	readonly configuredTable: () => Effect.Effect<AuthoringLoadResult>;
	readonly editSession: (intent: AuthoringSessionIntent) => Effect.Effect<AuthoringSessionResult>;
	readonly openCatalogTable: (
		objectPath: string,
		authority: AuthoringAuthority
	) => Effect.Effect<AuthoringLoadResult>;
	readonly reconcileSession: (sessionId: string) => Effect.Effect<AuthoringSessionResult>;
	readonly redoSession: (sessionId: string) => Effect.Effect<AuthoringSessionResult>;
	readonly reviewSession: (sessionId: string) => Effect.Effect<AuthoringSessionReviewResult>;
	readonly saveSession: (sessionId: string) => Effect.Effect<AuthoringSessionResult>;
	readonly undoSession: (sessionId: string) => Effect.Effect<AuthoringSessionResult>;
}

export class ShedAuthoring extends Context.Service<ShedAuthoring, ShedAuthoringShape>()(
	"@ue-shed/host/ShedAuthoring"
) {}

/** Supplies the headless session service only when project persistence is configured. */
export const ShedAuthoringSessionsLive = Layer.unwrap(
	Effect.flatMap(ShedHostConfiguration, (configuration) =>
		Effect.map(configuration.project(), (project) =>
			project.status === "configured"
				? authoringSessionServiceLayer({
						projectRoot: project.projectRoot,
						...(project.sessionStorageRoot === undefined
							? {}
							: { storageRoot: project.sessionStorageRoot })
					})
				: Layer.empty
		)
	)
);

/** Pure host projection of a session document; exhaustively covers every pipeline variant. */
export function sessionView(
	document: AuthoringSessionDocument,
	objectPath: string
): AuthoringSessionView {
	const review = reviewAuthoringSession(document);
	const lastApply = document.draft.applyReceipts.at(-1);
	return {
		canRedo: review.canRedo,
		canUndo: review.canUndo,
		commandCount: review.activeCommandCount,
		dirty: review.activeCommandCount > 0,
		lifecycle: document.lifecycle,
		...(lastApply === undefined
			? {}
			: {
					lastApply: {
						errors: lastApply.errors ?? [],
						operationId: lastApply.operationId,
						status: lastApply.status
					}
				}),
		pipeline: review.pipeline,
		review,
		sessionId: document.draft.id,
		snapshot: workingTable(document.draft, objectPath),
		updatedAt: document.updatedAt
	};
}

function documentView(document: AuthoringSessionDocument): AuthoringSessionResult {
	const objectPath = Object.keys(document.draft.base)[0];
	if (!objectPath) {
		return sessionFailure({ message: `Session ${document.draft.id} has no table` });
	}
	return { status: "ready", view: sessionView(document, objectPath) };
}

function sessionFailure(cause: {
	readonly _tag?: string;
	readonly message: string;
	readonly recovery?: string;
}): AuthoringSessionFailure {
	return {
		error: {
			code: cause._tag ?? "authoring_session_failure",
			message: cause.message,
			recovery: cause.recovery ?? "Retry the operation or create a new draft session.",
			retrySafe: cause._tag === "AuthoringSessionStorageError"
		},
		status: "failed"
	};
}

function readerFailure(message: string, recovery: string, retrySafe = true): AuthoringLoadResult {
	return {
		error: { code: "reader_failure", message, recovery, retrySafe },
		status: "failed"
	};
}

function catalogReaderFailure(message: string): AuthoringCatalogResult {
	return {
		error: {
			code: "reader_failure",
			message,
			recovery: "Verify the configured Unreal project and saved-asset reader.",
			retrySafe: true
		},
		status: "failed"
	};
}

export const ShedAuthoringLive = Layer.effect(
	ShedAuthoring,
	Effect.gen(function* () {
		const configurationService = yield* ShedHostConfiguration;
		const configuration = yield* Effect.all({
			authoringAsset: configurationService.authoringAsset(),
			project: configurationService.project(),
			remoteControlEndpoint: configurationService.remoteControlEndpoint()
		});
		const filePicker = yield* AuthoringFilePicker;
		const assetReader = yield* AssetReader;
		const catalog = yield* AuthoringCatalog;
		const remoteControl = yield* RemoteControlClient;

		const catalogIndex = yield* Ref.make<CatalogIndex>(emptyCatalogIndex);
		const snapshots = yield* Ref.make<ReadonlyMap<string, AuthoringTableSnapshot>>(new Map());

		const connectionCache = yield* Cache.makeWith(
			(endpoint: string) =>
				connectUnrealAuthoring(endpoint).pipe(
					Effect.provideService(RemoteControlClient, remoteControl)
				),
			{
				capacity: 4,
				timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(30) : Duration.zero)
			}
		);

		const sessions = yield* Effect.serviceOption(AuthoringSessions);

		const getConnectionResult = Effect.fn("ShedAuthoring.getConnectionResult")(function* () {
			return yield* Cache.get(connectionCache, configuration.remoteControlEndpoint).pipe(
				Effect.result
			);
		});

		const invalidateConnectionOnLiveFailure = (cause: unknown) =>
			cause instanceof AuthoringSessionLiveError
				? Cache.invalidate(connectionCache, configuration.remoteControlEndpoint)
				: Effect.void;

		const loadSavedTable = Effect.fn("ShedAuthoring.loadSavedTable")(function* (
			assetPath: string
		) {
			return yield* assetReader.readTable(assetPath).pipe(
				Effect.flatMap((snapshot) =>
					Ref.update(snapshots, (current) =>
						new Map(current).set(snapshot.table.objectPath, snapshot)
					).pipe(Effect.as({ snapshot, status: "ready" as const }))
				),
				Effect.catch((error) =>
					Effect.succeed(
						readerFailure(
							`Could not read the saved DataTable: ${error.message}`,
							"Choose a DataTable .uasset from a supported Unreal project and verify the saved-asset reader is available."
						)
					)
				)
			);
		});

		const loadLiveTable = Effect.fn("ShedAuthoring.loadLiveTable")(function* (
			objectPath: string
		) {
			const connectionResult = yield* getConnectionResult();
			if (Result.isFailure(connectionResult)) {
				return readerFailure(
					"The live authoring connection is unavailable",
					"Verify Unreal is connected, then refresh the project catalog."
				);
			}
			return yield* connectionResult.success.getTableSnapshot(objectPath).pipe(
				Effect.flatMap((snapshot) =>
					Ref.update(snapshots, (current) =>
						new Map(current).set(objectPath, snapshot)
					).pipe(Effect.as({ snapshot, status: "ready" as const }))
				),
				Effect.catch((error) =>
					Cache.invalidate(connectionCache, configuration.remoteControlEndpoint).pipe(
						Effect.as(
							readerFailure(
								`Could not read the live DataTable: ${error.message}`,
								"Verify Unreal is connected, then refresh the project catalog."
							)
						)
					)
				)
			);
		});

		const refreshCatalog = Effect.fn("ShedAuthoring.refreshCatalog")(function* (
			project: Extract<typeof configuration.project, { readonly status: "configured" }>
		) {
			const savedCatalogResult = yield* assetReader
				.discoverTables({
					...(project.catalogCachePath === undefined
						? {}
						: { cachePath: project.catalogCachePath }),
					projectRoot: project.projectRoot
				})
				.pipe(Effect.result);
			if (Result.isFailure(savedCatalogResult)) {
				return catalogReaderFailure(
					`Could not discover saved DataTables: ${savedCatalogResult.failure.message}`
				);
			}
			const savedCatalog = savedCatalogResult.success;
			const connectionResult = yield* getConnectionResult();
			const liveConnection = Result.isSuccess(connectionResult)
				? Option.some(connectionResult.success)
				: Option.none<UnrealAuthoringConnection>();

			const discovered = yield* Option.match(liveConnection, {
				onNone: () => catalog.discover({ projectRoot: project.projectRoot, savedCatalog }),
				onSome: (connection) =>
					catalog
						.discover({ projectRoot: project.projectRoot, savedCatalog })
						.pipe(Effect.provideService(AuthoringLiveConnection, connection))
			});
			if (discovered.diagnostics.some((diagnostic) => diagnostic.authority === "live")) {
				yield* Cache.invalidate(connectionCache, configuration.remoteControlEndpoint);
			}

			const assetPaths = new Map<string, string>();
			for (const table of savedCatalog.tables)
				assetPaths.set(table.objectPath, table.assetPath);
			const liveObjectPaths = new Set<string>();
			for (const table of discovered.tables) {
				if (table.authorities.some((authority) => authority.authority === "live")) {
					liveObjectPaths.add(table.objectPath);
				}
			}
			yield* Ref.set(catalogIndex, { assetPaths, liveObjectPaths });

			return {
				diagnostics: [
					...(Result.isFailure(connectionResult)
						? [
								{
									code: "live_connection_unavailable",
									message: connectionResult.failure.message
								}
							]
						: []),
					...discovered.diagnostics.map(({ code, message, path }) => ({
						code,
						message,
						...(path ? { path } : {})
					}))
				],
				status: "ready" as const,
				tables: discovered.tables.map(
					({ authorities, divergence, kind, objectPath, parentTables, rowStruct }) => ({
						authorities: authorities.map((authority) => authority.authority),
						completeness:
							(
								authorities.find((authority) => authority.authority === "live") ??
								authorities[0]
							)?.completeness ?? "partial",
						divergence: divergence.status === "detected" ? divergence.fields : [],
						kind,
						objectPath,
						parentTables,
						rowStruct
					})
				)
			};
		});

		const configuredTable = Effect.fn("ShedAuthoring.configuredTable")(function* () {
			if (configuration.authoringAsset.status !== "configured") {
				return { status: "not_configured" as const };
			}
			return yield* loadSavedTable(configuration.authoringAsset.path);
		});

		const configuredCatalog = Effect.fn("ShedAuthoring.configuredCatalog")(function* () {
			if (configuration.project.status !== "configured") {
				return { status: "not_configured" as const };
			}
			return yield* refreshCatalog(configuration.project);
		});

		const catalogProgress = Effect.fn("ShedAuthoring.catalogProgress")(() =>
			assetReader.catalogProgress === undefined
				? Effect.succeed({
						cacheHits: 0,
						phase: "idle" as const,
						processedAssets: 0,
						tablesFound: 0,
						totalAssets: 0
					})
				: assetReader.catalogProgress()
		);

		const chooseTable = Effect.fn("ShedAuthoring.chooseTable")(function* () {
			const choice = yield* filePicker
				.chooseFile({
					extensions: ["uasset"],
					title: "Open a saved Unreal DataTable"
				})
				.pipe(
					Effect.mapError(
						(error) =>
							new AuthoringClientError({
								cause: error,
								operation: "authoring.chooseTable",
								recovery: error.recovery
							})
					)
				);
			if (choice.status === "cancelled") return { status: "cancelled" as const };
			return yield* loadSavedTable(choice.path);
		});

		const openCatalogTable = Effect.fn("ShedAuthoring.openCatalogTable")(function* (
			objectPath: string,
			authority: AuthoringAuthority
		) {
			let index = yield* Ref.get(catalogIndex);
			let assetPath = index.assetPaths.get(objectPath);
			if (
				!assetPath &&
				!index.liveObjectPaths.has(objectPath) &&
				configuration.project.status === "configured"
			) {
				yield* refreshCatalog(configuration.project);
				index = yield* Ref.get(catalogIndex);
				assetPath = index.assetPaths.get(objectPath);
			}
			if (authority === "live") {
				return index.liveObjectPaths.has(objectPath)
					? yield* loadLiveTable(objectPath)
					: readerFailure(
							`The live editor does not expose ${objectPath}.`,
							"Refresh the catalog, reconnect Unreal, or select Saved package."
						);
			}
			if (assetPath) return yield* loadSavedTable(assetPath);
			return readerFailure(
				`The saved project no longer contains ${objectPath}.`,
				"Refresh the catalog or choose another saved DataTable."
			);
		});

		const beginSession = Effect.fn("ShedAuthoring.beginSession")(function* (
			objectPath: string
		) {
			if (Option.isNone(sessions)) {
				return sessionFailure({ message: "UE_SHED_PROJECT_ROOT is not configured" });
			}
			const service = sessions.value;
			return yield* Effect.gen(function* () {
				const loaded = yield* Ref.get(snapshots);
				const snapshot = loaded.get(objectPath);
				if (!snapshot) {
					return sessionFailure({
						message: `No loaded snapshot exists for ${objectPath}`
					});
				}
				const listed = yield* service.list();
				const existingSessions = listed.sessions.filter((candidate) =>
					candidate.tableObjectPaths.includes(objectPath)
				);
				for (const existing of existingSessions) {
					const existingDocument = yield* service.open(existing.id);
					const isInert =
						existingDocument.draft.undoPointer === 0 &&
						existingDocument.draft.awaitingSave.length === 0 &&
						existingDocument.pendingOperation.kind === "none";
					if (isInert) {
						yield* service.discard(existing.id);
						continue;
					}
					const existingSnapshot = existingDocument.draft.base[objectPath];
					if (
						existingSnapshot?.authority.kind !== snapshot.authority.kind ||
						fingerprintTable(existingSnapshot) !== fingerprintTable(snapshot)
					)
						continue;
					const document =
						existing.lifecycle === "closed"
							? yield* service.resume(existing.id)
							: existingDocument;
					return { status: "ready" as const, view: sessionView(document, objectPath) };
				}
				const document = yield* service.create([snapshot]);
				return { status: "ready" as const, view: sessionView(document, objectPath) };
			}).pipe(Effect.catch((cause) => Effect.succeed(sessionFailure(cause))));
		});

		const listSessions = Effect.fn("ShedAuthoring.listSessions")(function* () {
			if (Option.isNone(sessions)) {
				return sessionFailure({ message: "UE_SHED_PROJECT_ROOT is not configured" });
			}
			return yield* sessions.value.list().pipe(
				Effect.map((result) => ({
					diagnostics: result.diagnostics.map(({ code, message }) => ({ code, message })),
					sessions: result.sessions.filter(
						(session) => session.commandCount > 0 || session.needsSave
					),
					status: "ready" as const
				})),
				Effect.catch((cause) => Effect.succeed(sessionFailure(cause)))
			);
		});

		const openSession = Effect.fn("ShedAuthoring.openSession")(function* (sessionId: string) {
			if (Option.isNone(sessions)) {
				return sessionFailure({ message: "UE_SHED_PROJECT_ROOT is not configured" });
			}
			const service = sessions.value;
			return yield* service.open(sessionId).pipe(
				Effect.flatMap((document) =>
					document.lifecycle === "closed"
						? service.resume(sessionId)
						: Effect.succeed(document)
				),
				Effect.map(documentView),
				Effect.catch((cause) => Effect.succeed(sessionFailure(cause)))
			);
		});

		const discardSession = Effect.fn("ShedAuthoring.discardSession")(function* (
			sessionId: string
		) {
			if (Option.isNone(sessions)) {
				return sessionFailure({ message: "UE_SHED_PROJECT_ROOT is not configured" });
			}
			return yield* sessions.value.discard(sessionId).pipe(
				Effect.flatMap(() => listSessions()),
				Effect.catch((cause) => Effect.succeed(sessionFailure(cause)))
			);
		});

		const editSession = Effect.fn("ShedAuthoring.editSession")(function* (
			intent: AuthoringSessionIntent
		) {
			if (Option.isNone(sessions)) {
				return sessionFailure({ message: "UE_SHED_PROJECT_ROOT is not configured" });
			}
			const service = sessions.value;
			const transition =
				intent.kind === "set_cells"
					? service.setCells({
							edits: intent.edits,
							sessionId: intent.sessionId,
							tableObjectPath: intent.tableObjectPath
						})
					: intent.kind === "add_row"
						? service.addRow({
								sessionId: intent.sessionId,
								tableObjectPath: intent.tableObjectPath,
								rowName: intent.rowName,
								...(intent.atIndex === undefined ? {} : { atIndex: intent.atIndex })
							})
						: intent.kind === "duplicate_row"
							? service.duplicateRow({
									sessionId: intent.sessionId,
									tableObjectPath: intent.tableObjectPath,
									rowName: intent.rowName,
									sourceRowId: intent.sourceRowId,
									...(intent.atIndex === undefined
										? {}
										: { atIndex: intent.atIndex })
								})
							: intent.kind === "remove_row"
								? service.removeRow({
										sessionId: intent.sessionId,
										tableObjectPath: intent.tableObjectPath,
										rowId: intent.rowId
									})
								: intent.kind === "rename_row"
									? service.renameRow({
											sessionId: intent.sessionId,
											tableObjectPath: intent.tableObjectPath,
											rowId: intent.rowId,
											rowName: intent.rowName
										})
									: service.reorderRows({
											sessionId: intent.sessionId,
											tableObjectPath: intent.tableObjectPath,
											rowIds: intent.rowIds
										});
			return yield* transition.pipe(
				Effect.map((document) => ({
					status: "ready" as const,
					view: sessionView(document, intent.tableObjectPath)
				})),
				Effect.catch((cause) => Effect.succeed(sessionFailure(cause)))
			);
		});

		const reviewSession = Effect.fn("ShedAuthoring.reviewSession")(function* (
			sessionId: string
		) {
			if (Option.isNone(sessions)) {
				return { ...sessionFailure({ message: "UE_SHED_PROJECT_ROOT is not configured" }) };
			}
			return yield* sessions.value.review(sessionId).pipe(
				Effect.map((review) => ({ review, status: "ready" as const })),
				Effect.catch((cause) => Effect.succeed(sessionFailure(cause)))
			);
		});

		const undoSession = Effect.fn("ShedAuthoring.undoSession")(function* (sessionId: string) {
			if (Option.isNone(sessions)) {
				return sessionFailure({ message: "UE_SHED_PROJECT_ROOT is not configured" });
			}
			return yield* sessions.value.undo(sessionId).pipe(
				Effect.map(documentView),
				Effect.catch((cause) => Effect.succeed(sessionFailure(cause)))
			);
		});

		const redoSession = Effect.fn("ShedAuthoring.redoSession")(function* (sessionId: string) {
			if (Option.isNone(sessions)) {
				return sessionFailure({ message: "UE_SHED_PROJECT_ROOT is not configured" });
			}
			return yield* sessions.value.redo(sessionId).pipe(
				Effect.map(documentView),
				Effect.catch((cause) => Effect.succeed(sessionFailure(cause)))
			);
		});

		const requireLiveConnection = (): Effect.Effect<
			UnrealAuthoringConnection,
			UnrealConnectionError | UnrealCapabilityError
		> => Cache.get(connectionCache, configuration.remoteControlEndpoint);

		const applySession = Effect.fn("ShedAuthoring.applySession")(function* (sessionId: string) {
			if (Option.isNone(sessions)) {
				return sessionFailure({ message: "UE_SHED_PROJECT_ROOT is not configured" });
			}
			const service = sessions.value;
			return yield* Effect.gen(function* () {
				const connection = yield* requireLiveConnection();
				const limits = connection.manifest.authoringLimits;
				if (!limits) {
					return sessionFailure({
						message: "The editor did not negotiate authoring mutation limits"
					});
				}
				return yield* service
					.apply(sessionId, limits)
					.pipe(
						Effect.provide(authoringSessionLivePortLayer(connection)),
						Effect.map(documentView)
					);
			}).pipe(
				Effect.catch((cause) =>
					invalidateConnectionOnLiveFailure(cause).pipe(Effect.as(sessionFailure(cause)))
				)
			);
		});

		const reconcileSession = Effect.fn("ShedAuthoring.reconcileSession")(function* (
			sessionId: string
		) {
			if (Option.isNone(sessions)) {
				return sessionFailure({ message: "UE_SHED_PROJECT_ROOT is not configured" });
			}
			const service = sessions.value;
			return yield* Effect.gen(function* () {
				const connection = yield* requireLiveConnection();
				return yield* service
					.reconcileApply(sessionId)
					.pipe(
						Effect.provide(authoringSessionLivePortLayer(connection)),
						Effect.map(documentView)
					);
			}).pipe(
				Effect.catch((cause) =>
					invalidateConnectionOnLiveFailure(cause).pipe(Effect.as(sessionFailure(cause)))
				)
			);
		});

		const saveSession = Effect.fn("ShedAuthoring.saveSession")(function* (sessionId: string) {
			if (Option.isNone(sessions)) {
				return sessionFailure({ message: "UE_SHED_PROJECT_ROOT is not configured" });
			}
			const service = sessions.value;
			return yield* Effect.gen(function* () {
				const connection = yield* requireLiveConnection();
				return yield* service
					.save(sessionId)
					.pipe(
						Effect.provide(authoringSessionLivePortLayer(connection)),
						Effect.map(documentView)
					);
			}).pipe(
				Effect.catch((cause) =>
					invalidateConnectionOnLiveFailure(cause).pipe(Effect.as(sessionFailure(cause)))
				)
			);
		});

		return ShedAuthoring.of({
			applySession,
			beginSession,
			catalogProgress,
			chooseTable,
			configuredCatalog,
			configuredTable,
			discardSession,
			editSession,
			listSessions,
			openCatalogTable,
			openSession,
			reconcileSession,
			redoSession,
			reviewSession,
			saveSession,
			undoSession
		});
	})
);

export function makeShedAuthoringTestLayer(
	service: Omit<ShedAuthoringShape, "catalogProgress"> &
		Partial<Pick<ShedAuthoringShape, "catalogProgress">>
): Layer.Layer<ShedAuthoring> {
	return Layer.succeed(
		ShedAuthoring,
		ShedAuthoring.of({
			catalogProgress:
				service.catalogProgress ??
				(() =>
					Effect.succeed({
						cacheHits: 0,
						phase: "idle",
						processedAssets: 0,
						tablesFound: 0,
						totalAssets: 0
					})),
			...service
		})
	);
}

export const AuthoringClientLive = Layer.effect(
	AuthoringClient,
	Effect.map(
		ShedAuthoring,
		(authoring): AuthoringClientShape =>
			AuthoringClient.of({
				applySession: authoring.applySession,
				beginSession: authoring.beginSession,
				chooseTable: authoring.chooseTable,
				discardSession: authoring.discardSession,
				editSession: authoring.editSession,
				getCatalogProgress:
					authoring.catalogProgress ??
					(() =>
						Effect.succeed({
							cacheHits: 0,
							phase: "idle" as const,
							processedAssets: 0,
							tablesFound: 0,
							totalAssets: 0
						})),
				listSessions: authoring.listSessions,
				loadConfiguredCatalog: authoring.configuredCatalog,
				loadConfiguredTable: authoring.configuredTable,
				openCatalogTable: authoring.openCatalogTable,
				openSession: authoring.openSession,
				reconcileSession: authoring.reconcileSession,
				redoSession: authoring.redoSession,
				reviewSession: authoring.reviewSession,
				saveSession: authoring.saveSession,
				undoSession: authoring.undoSession
			})
	)
);
