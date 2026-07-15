import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Clock, Context, Effect, Layer, Schema, Semaphore } from "effect";
import {
	DraftSessionSchema,
	appendCommandGroup,
	buildSetCellCommandGroup,
	createDraftSession,
	redo,
	undo,
	workingTable,
	type CommandEnvelope,
	type DraftSession
} from "./draft.js";
import { fingerprintTable } from "./fingerprint.js";
import {
	AuthoringApplyRequest,
	AuthoringSaveRequest,
	type AuthoringApplyResult,
	type AuthoringSaveResult,
	type AuthoringTableSnapshot
} from "@ue-shed/protocol";
import {
	acceptApplyResult,
	acceptSaveResult,
	buildApplyRequest,
	buildSaveRequest,
	type AuthoringMutationLimits
} from "./live.js";

const SessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const PendingOperation = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("none") }),
	Schema.Struct({
		kind: Schema.Literal("apply"),
		lastError: Schema.optional(Schema.String),
		request: AuthoringApplyRequest,
		startedAt: Schema.String,
		status: Schema.Literals(["dispatching", "indeterminate"])
	}),
	Schema.Struct({
		kind: Schema.Literal("save"),
		lastError: Schema.optional(Schema.String),
		request: AuthoringSaveRequest,
		startedAt: Schema.String,
		status: Schema.Literals(["dispatching", "indeterminate"])
	})
]);

export const AuthoringSessionDocument = Schema.Struct({
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-authoring-session"),
		version: Schema.Struct({
			major: Schema.Literal(1),
			minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		})
	}),
	createdAt: Schema.String,
	draft: DraftSessionSchema,
	lifecycle: Schema.Literals(["open", "closed"]),
	pendingOperation: PendingOperation,
	project: Schema.Struct({ id: Schema.String, root: Schema.String }),
	updatedAt: Schema.String
});
export type AuthoringSessionDocument = Schema.Schema.Type<typeof AuthoringSessionDocument>;

const decodeDocument = Schema.decodeUnknownEffect(AuthoringSessionDocument);

export class InvalidSessionIdError extends Schema.TaggedErrorClass<InvalidSessionIdError>()(
	"InvalidSessionIdError",
	{ sessionId: Schema.String, message: Schema.String, recovery: Schema.String }
) {}

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
	"SessionNotFoundError",
	{ sessionId: Schema.String, message: Schema.String, recovery: Schema.String }
) {}

export class SessionCorruptError extends Schema.TaggedErrorClass<SessionCorruptError>()(
	"SessionCorruptError",
	{
		sessionId: Schema.String,
		quarantinePath: Schema.String,
		message: Schema.String,
		recovery: Schema.String
	}
) {}

export class AuthoringSessionStorageError extends Schema.TaggedErrorClass<AuthoringSessionStorageError>()(
	"AuthoringSessionStorageError",
	{
		operation: Schema.String,
		sessionId: Schema.optional(Schema.String),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

export class AuthoringSessionTransitionError extends Schema.TaggedErrorClass<AuthoringSessionTransitionError>()(
	"AuthoringSessionTransitionError",
	{ sessionId: Schema.String, message: Schema.String, recovery: Schema.String }
) {}

export type AuthoringSessionServiceError =
	| InvalidSessionIdError
	| SessionNotFoundError
	| SessionCorruptError
	| AuthoringSessionStorageError
	| AuthoringSessionTransitionError;

export interface AuthoringSessionSummary {
	readonly id: string;
	readonly lifecycle: "open" | "closed";
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly tableObjectPaths: readonly string[];
	readonly commandCount: number;
	readonly undoPointer: number;
}

export interface AuthoringSessionList {
	readonly sessions: readonly AuthoringSessionSummary[];
	readonly diagnostics: readonly {
		readonly code: "session_quarantined";
		readonly message: string;
		readonly quarantinePath: string;
	}[];
}

export interface AuthoringSessionService {
	readonly storageRoot: string;
	readonly create: (
		snapshots: readonly AuthoringTableSnapshot[],
		options?: { readonly id?: string; readonly author?: string }
	) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly open: (
		sessionId: string
	) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly resume: (
		sessionId: string
	) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly list: () => Effect.Effect<AuthoringSessionList, AuthoringSessionStorageError>;
	readonly append: (
		sessionId: string,
		commands: readonly CommandEnvelope[]
	) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly setCells: (args: {
		readonly sessionId: string;
		readonly tableObjectPath: string;
		readonly edits: readonly {
			readonly rowId: string;
			readonly fieldName: string;
			readonly value: import("@ue-shed/protocol").AuthoringValue;
		}[];
		readonly author?: string;
	}) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly undo: (
		sessionId: string
	) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly redo: (
		sessionId: string
	) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly prepareApply: (
		sessionId: string,
		limits: AuthoringMutationLimits,
		operationId?: string
	) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly markApplyIndeterminate: (
		sessionId: string,
		message: string
	) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly completeApply: (
		sessionId: string,
		result: AuthoringApplyResult
	) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly prepareSave: (
		sessionId: string,
		requestId?: string
	) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly markSaveIndeterminate: (
		sessionId: string,
		message: string
	) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly completeSave: (
		sessionId: string,
		result: AuthoringSaveResult
	) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly close: (
		sessionId: string
	) => Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError>;
	readonly discard: (sessionId: string) => Effect.Effect<void, AuthoringSessionServiceError>;
}

export interface AuthoringSessionServiceConfig {
	readonly projectRoot: string;
	readonly projectId?: string;
	readonly storageRoot?: string;
}

export interface AuthoringIdGeneratorShape {
	readonly generate: () => Effect.Effect<string>;
}

export class AuthoringIdGenerator extends Context.Service<
	AuthoringIdGenerator,
	AuthoringIdGeneratorShape
>()("@ue-shed/authoring/AuthoringIdGenerator") {}

export const AuthoringIdGeneratorLive = Layer.succeed(
	AuthoringIdGenerator,
	AuthoringIdGenerator.of({
		generate: Effect.fn("AuthoringIdGenerator.generate")(() => Effect.sync(randomUUID))
	})
);

export function authoringIdGeneratorLayer(makeId: () => string): Layer.Layer<AuthoringIdGenerator> {
	return Layer.succeed(
		AuthoringIdGenerator,
		AuthoringIdGenerator.of({
			generate: Effect.fn("AuthoringIdGenerator.Test.generate")(() => Effect.sync(makeId))
		})
	);
}

export interface AuthoringSessionRepositoryShape {
	readonly project: { readonly id: string; readonly root: string };
	readonly storageRoot: string;
	readonly discard: (sessionId: string) => Effect.Effect<void, AuthoringSessionServiceError>;
	readonly exists: (sessionId: string) => Effect.Effect<boolean, AuthoringSessionStorageError>;
	readonly listIds: () => Effect.Effect<readonly string[], AuthoringSessionStorageError>;
	readonly persist: (
		document: AuthoringSessionDocument
	) => Effect.Effect<void, AuthoringSessionStorageError>;
	readonly quarantine: (
		sessionId: string,
		cause: unknown
	) => Effect.Effect<never, SessionCorruptError | AuthoringSessionStorageError>;
	readonly read: (
		sessionId: string
	) => Effect.Effect<string, SessionNotFoundError | AuthoringSessionStorageError>;
}

export class AuthoringSessionRepository extends Context.Service<
	AuthoringSessionRepository,
	AuthoringSessionRepositoryShape
>()("@ue-shed/authoring/AuthoringSessionRepository") {}

export function authoringSessionRepositoryLayer(
	config: AuthoringSessionServiceConfig
): Layer.Layer<AuthoringSessionRepository, never, AuthoringIdGenerator> {
	return Layer.effect(
		AuthoringSessionRepository,
		Effect.gen(function* () {
			const ids = yield* AuthoringIdGenerator;
			const projectRoot = resolve(config.projectRoot);
			const storageRoot = resolve(
				config.storageRoot ?? join(projectRoot, ".ue-shed", "authoring", "sessions")
			);
			const project = { id: config.projectId ?? projectRoot, root: projectRoot };
			const pathFor = (sessionId: string) => join(storageRoot, `${sessionId}.json`);

			const persist = Effect.fn("AuthoringSessionRepository.persist")(function* (
				document: AuthoringSessionDocument
			) {
				const target = pathFor(document.draft.id);
				const temporary = `${target}.${yield* ids.generate()}.tmp`;
				yield* Effect.tryPromise({
					try: async () => {
						await mkdir(storageRoot, { recursive: true });
						try {
							const handle = await open(temporary, "wx");
							try {
								await handle.writeFile(
									`${JSON.stringify(document, null, "\t")}\n`,
									"utf8"
								);
								await handle.sync();
							} finally {
								await handle.close();
							}
							await rename(temporary, target);
						} catch (cause) {
							await rm(temporary, { force: true });
							throw cause;
						}
					},
					catch: (cause) =>
						new AuthoringSessionStorageError({
							message: String(cause),
							operation: "persist",
							recovery: "Check that the project session directory is writable.",
							sessionId: document.draft.id
						})
				});
			}, Effect.withSpan("authoring.session.persist"));

			const read = Effect.fn("AuthoringSessionRepository.read")(function* (
				sessionId: string
			) {
				return yield* Effect.tryPromise({
					try: () => readFile(pathFor(sessionId), "utf8"),
					catch: (cause) =>
						(cause as NodeJS.ErrnoException).code === "ENOENT"
							? new SessionNotFoundError({
									message: `Authoring session ${sessionId} does not exist`,
									recovery: "List project sessions or create a new one.",
									sessionId
								})
							: new AuthoringSessionStorageError({
									message: String(cause),
									operation: "read",
									recovery: "Check access to the project session directory.",
									sessionId
								})
				});
			});

			const exists = Effect.fn("AuthoringSessionRepository.exists")(function* (
				sessionId: string
			) {
				return yield* Effect.tryPromise({
					try: async () => {
						try {
							await stat(pathFor(sessionId));
							return true;
						} catch (cause) {
							if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
							throw cause;
						}
					},
					catch: (cause) =>
						new AuthoringSessionStorageError({
							message: String(cause),
							operation: "create",
							recovery: "Check access to the project session directory.",
							sessionId
						})
				});
			});

			const listIds = Effect.fn("AuthoringSessionRepository.listIds")(function* () {
				const names = yield* Effect.tryPromise({
					try: async () => {
						await mkdir(storageRoot, { recursive: true });
						return await readdir(storageRoot);
					},
					catch: (cause) =>
						new AuthoringSessionStorageError({
							message: String(cause),
							operation: "list",
							recovery: "Check access to the project session directory."
						})
				});
				return names
					.filter((name) => name.endsWith(".json"))
					.map((name) => basename(name, ".json"));
			});

			const quarantine = Effect.fn("AuthoringSessionRepository.quarantine")(function* (
				sessionId: string,
				cause: unknown
			) {
				const timestamp = yield* Clock.currentTimeMillis;
				const quarantinePath = `${pathFor(sessionId)}.corrupt-${timestamp}`;
				yield* Effect.tryPromise({
					try: () => rename(pathFor(sessionId), quarantinePath),
					catch: (renameCause) =>
						new AuthoringSessionStorageError({
							message: String(renameCause),
							operation: "quarantine",
							recovery: "Move the malformed session aside, then retry.",
							sessionId
						})
				});
				return yield* new SessionCorruptError({
					message: `Session ${sessionId} is malformed: ${String(cause)}`,
					quarantinePath,
					recovery: "Inspect the quarantined file or create a new session.",
					sessionId
				});
			});

			const discard = Effect.fn("AuthoringSessionRepository.discard")(function* (
				sessionId: string
			) {
				yield* Effect.tryPromise({
					try: () => rm(pathFor(sessionId)),
					catch: (cause) =>
						(cause as NodeJS.ErrnoException).code === "ENOENT"
							? new SessionNotFoundError({
									message: `Authoring session ${sessionId} does not exist`,
									recovery: "List project sessions or create a new one.",
									sessionId
								})
							: new AuthoringSessionStorageError({
									message: String(cause),
									operation: "discard",
									recovery: "Check access to the project session directory.",
									sessionId
								})
				});
			});

			return AuthoringSessionRepository.of({
				discard,
				exists,
				listIds,
				persist,
				project,
				quarantine,
				read,
				storageRoot
			});
		})
	);
}

function validateSessionId(sessionId: string): Effect.Effect<string, InvalidSessionIdError> {
	return SessionIdPattern.test(sessionId)
		? Effect.succeed(sessionId)
		: Effect.fail(
				new InvalidSessionIdError({
					message: `Invalid authoring session id: ${sessionId}`,
					recovery: "Use 1-128 letters, numbers, dots, underscores, or hyphens.",
					sessionId
				})
			);
}

function summary(document: AuthoringSessionDocument): AuthoringSessionSummary {
	return {
		commandCount: document.draft.commands.length,
		createdAt: document.createdAt,
		id: document.draft.id,
		lifecycle: document.lifecycle,
		tableObjectPaths: Object.keys(document.draft.base).toSorted(),
		undoPointer: document.draft.undoPointer,
		updatedAt: document.updatedAt
	};
}

function makeAuthoringSessionServiceEffect(): Effect.Effect<
	AuthoringSessionService,
	never,
	AuthoringSessionRepository | AuthoringIdGenerator
> {
	return Effect.gen(function* () {
		const mutex = yield* Semaphore.make(1);
		const repository = yield* AuthoringSessionRepository;
		const ids = yield* AuthoringIdGenerator;
		const now = Clock.currentTimeMillis.pipe(
			Effect.map((milliseconds) => new Date(milliseconds).toISOString())
		);

		const load = (
			sessionId: string
		): Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError> =>
			validateSessionId(sessionId).pipe(
				Effect.flatMap((validId) =>
					repository.read(validId).pipe(
						Effect.flatMap((contents) =>
							Effect.try({
								try: () => JSON.parse(contents) as unknown,
								catch: (cause) => cause
							}).pipe(
								Effect.flatMap(decodeDocument),
								Effect.catch((cause) => repository.quarantine(validId, cause))
							)
						),
						Effect.flatMap((document) =>
							document.project.id === repository.project.id
								? Effect.succeed(document)
								: Effect.fail(
										new AuthoringSessionStorageError({
											message: `Session ${validId} belongs to project ${document.project.id}`,
											operation: "verify_project",
											recovery:
												"Open the session through its owning project.",
											sessionId: validId
										})
									)
						)
					)
				),
				Effect.withSpan("authoring.session.open", {
					attributes: { "authoring.session.id": sessionId }
				})
			);

		const update = (
			sessionId: string,
			transition: (
				document: AuthoringSessionDocument,
				timestamp: string
			) => AuthoringSessionDocument
		): Effect.Effect<AuthoringSessionDocument, AuthoringSessionServiceError> =>
			mutex.withPermits(1)(
				load(sessionId).pipe(
					Effect.flatMap((document) =>
						now.pipe(
							Effect.flatMap((timestamp) =>
								Effect.try({
									try: () => transition(document, timestamp),
									catch: (cause) =>
										new AuthoringSessionTransitionError({
											message: String(cause),
											recovery:
												"Correct the rejected intent and retry the complete gesture.",
											sessionId
										})
								})
							)
						)
					),
					Effect.flatMap((document) =>
						repository.persist(document).pipe(Effect.as(document))
					)
				)
			);

		const requireIdle = (document: AuthoringSessionDocument): void => {
			if (document.pendingOperation.kind !== "none") {
				throw new Error(
					`Session has an unresolved ${document.pendingOperation.kind} operation; reconcile it first`
				);
			}
		};

		return {
			storageRoot: repository.storageRoot,
			create: Effect.fn("AuthoringSessions.create")((snapshots, options) =>
				mutex.withPermits(1)(
					Effect.gen(function* () {
						const id = yield* validateSessionId(options?.id ?? (yield* ids.generate()));
						const exists = yield* repository.exists(id);
						if (exists) {
							return yield* new AuthoringSessionStorageError({
								message: `Authoring session ${id} already exists`,
								operation: "create",
								recovery:
									"Choose a different session id or resume the existing session.",
								sessionId: id
							});
						}
						const timestamp = yield* now;
						const document: AuthoringSessionDocument = {
							contract: {
								name: "ue-shed-authoring-session",
								version: { major: 1, minor: 0 }
							},
							createdAt: timestamp,
							draft: createDraftSession(id, snapshots, fingerprintTable),
							lifecycle: "open",
							pendingOperation: { kind: "none" },
							project: repository.project,
							updatedAt: timestamp
						};
						yield* repository.persist(document);
						return document;
					})
				)
			),
			open: Effect.fn("AuthoringSessions.open")(load),
			resume: Effect.fn("AuthoringSessions.resume")((sessionId) =>
				update(sessionId, (document, timestamp) => ({
					...document,
					lifecycle: "open",
					updatedAt: timestamp
				}))
			),
			list: Effect.fn("AuthoringSessions.list")(() =>
				repository.listIds().pipe(
					Effect.flatMap((sessionIds) =>
						Effect.forEach(
							sessionIds,
							(sessionId) =>
								load(sessionId).pipe(
									Effect.map((document) => ({
										document,
										kind: "document" as const
									})),
									Effect.catch((error) =>
										error._tag === "SessionCorruptError"
											? Effect.succeed({ error, kind: "diagnostic" as const })
											: Effect.fail(
													new AuthoringSessionStorageError({
														message: error.message,
														operation: "list_entry",
														recovery: error.recovery,
														sessionId
													})
												)
									)
								),
							{ concurrency: 4 }
						)
					),
					Effect.map((results) => ({
						diagnostics: results
							.filter((result) => result.kind === "diagnostic")
							.map(({ error }) => ({
								code: "session_quarantined" as const,
								message: error.message,
								quarantinePath: error.quarantinePath
							})),
						sessions: results
							.filter((result) => result.kind === "document")
							.map(({ document }) => summary(document))
							.toSorted((left, right) =>
								right.updatedAt.localeCompare(left.updatedAt)
							)
					}))
				)
			),
			append: Effect.fn("AuthoringSessions.append")((sessionId, commands) =>
				update(sessionId, (document, timestamp) => {
					requireIdle(document);
					const draft = appendCommandGroup(document.draft as DraftSession, commands);
					for (const objectPath of new Set(
						commands.map((command) => command.tableObjectPath)
					)) {
						workingTable(draft, objectPath);
					}
					return { ...document, draft, updatedAt: timestamp };
				})
			),
			setCells: Effect.fn("AuthoringSessions.setCells")((args) =>
				Effect.gen(function* () {
					const commandIds = yield* Effect.forEach(args.edits, () => ids.generate());
					const groupId = yield* ids.generate();
					return yield* update(args.sessionId, (document, timestamp) => {
						requireIdle(document);
						const commands = buildSetCellCommandGroup({
							authoredAt: timestamp,
							commandIds,
							edits: args.edits,
							groupId,
							session: document.draft as DraftSession,
							tableObjectPath: args.tableObjectPath,
							...(args.author === undefined ? {} : { author: args.author })
						});
						const draft = appendCommandGroup(document.draft as DraftSession, commands);
						workingTable(draft, args.tableObjectPath);
						return { ...document, draft, updatedAt: timestamp };
					});
				})
			),
			undo: Effect.fn("AuthoringSessions.undo")((sessionId) =>
				update(sessionId, (document, timestamp) => {
					requireIdle(document);
					return {
						...document,
						draft: undo(document.draft as DraftSession),
						updatedAt: timestamp
					};
				})
			),
			redo: Effect.fn("AuthoringSessions.redo")((sessionId) =>
				update(sessionId, (document, timestamp) => {
					requireIdle(document);
					return {
						...document,
						draft: redo(document.draft as DraftSession),
						updatedAt: timestamp
					};
				})
			),
			prepareApply: Effect.fn("AuthoringSessions.prepareApply")(
				(sessionId, limits, operationId) =>
					Effect.gen(function* () {
						const requestId = operationId ?? (yield* ids.generate());
						return yield* update(sessionId, (document, timestamp) => {
							requireIdle(document);
							const request = buildApplyRequest(
								document.draft as DraftSession,
								requestId,
								limits
							);
							return {
								...document,
								pendingOperation: {
									kind: "apply",
									request,
									startedAt: timestamp,
									status: "dispatching"
								},
								updatedAt: timestamp
							};
						});
					})
			),
			markApplyIndeterminate: Effect.fn("AuthoringSessions.markApplyIndeterminate")(
				(sessionId, message) =>
					update(sessionId, (document, timestamp) => {
						if (document.pendingOperation.kind !== "apply") {
							throw new Error("Session has no pending Apply operation");
						}
						return {
							...document,
							pendingOperation: {
								...document.pendingOperation,
								lastError: message,
								status: "indeterminate"
							},
							updatedAt: timestamp
						};
					})
			),
			completeApply: Effect.fn("AuthoringSessions.completeApply")((sessionId, result) =>
				update(sessionId, (document, timestamp) => {
					if (document.pendingOperation.kind !== "apply") {
						throw new Error("Session has no pending Apply operation");
					}
					return {
						...document,
						draft: acceptApplyResult(
							document.draft as DraftSession,
							document.pendingOperation.request,
							result,
							timestamp
						),
						pendingOperation: { kind: "none" },
						updatedAt: timestamp
					};
				})
			),
			prepareSave: Effect.fn("AuthoringSessions.prepareSave")((sessionId, requestId) =>
				Effect.gen(function* () {
					const operationId = requestId ?? (yield* ids.generate());
					return yield* update(sessionId, (document, timestamp) => {
						requireIdle(document);
						const request = buildSaveRequest(
							document.draft as DraftSession,
							operationId
						);
						return {
							...document,
							pendingOperation: {
								kind: "save",
								request,
								startedAt: timestamp,
								status: "dispatching"
							},
							updatedAt: timestamp
						};
					});
				})
			),
			markSaveIndeterminate: Effect.fn("AuthoringSessions.markSaveIndeterminate")(
				(sessionId, message) =>
					update(sessionId, (document, timestamp) => {
						if (document.pendingOperation.kind !== "save") {
							throw new Error("Session has no pending Save operation");
						}
						return {
							...document,
							pendingOperation: {
								...document.pendingOperation,
								lastError: message,
								status: "indeterminate"
							},
							updatedAt: timestamp
						};
					})
			),
			completeSave: Effect.fn("AuthoringSessions.completeSave")((sessionId, result) =>
				update(sessionId, (document, timestamp) => {
					if (document.pendingOperation.kind !== "save") {
						throw new Error("Session has no pending Save operation");
					}
					return {
						...document,
						draft: acceptSaveResult(
							document.draft as DraftSession,
							document.pendingOperation.request,
							result,
							timestamp
						),
						pendingOperation: { kind: "none" },
						updatedAt: timestamp
					};
				})
			),
			close: Effect.fn("AuthoringSessions.close")((sessionId) =>
				update(sessionId, (document, timestamp) => ({
					...document,
					lifecycle: "closed",
					updatedAt: timestamp
				}))
			),
			discard: Effect.fn("AuthoringSessions.discard")((sessionId) =>
				mutex.withPermits(1)(
					validateSessionId(sessionId).pipe(
						Effect.flatMap((validId) => repository.discard(validId)),
						Effect.withSpan("authoring.session.discard", {
							attributes: { "authoring.session.id": sessionId }
						})
					)
				)
			)
		};
	});
}

export class AuthoringSessions extends Context.Service<
	AuthoringSessions,
	AuthoringSessionService
>()("@ue-shed/authoring/AuthoringSessions") {}

export const AuthoringSessionServiceLayer = Layer.effect(
	AuthoringSessions,
	makeAuthoringSessionServiceEffect().pipe(Effect.map(AuthoringSessions.of))
);

function authoringSessionDependencies(
	config: AuthoringSessionServiceConfig,
	idLayer: Layer.Layer<AuthoringIdGenerator>
) {
	const repository = authoringSessionRepositoryLayer(config).pipe(Layer.provide(idLayer));
	return Layer.merge(repository, idLayer);
}

export function authoringSessionServiceLayer(
	config: AuthoringSessionServiceConfig,
	idLayer: Layer.Layer<AuthoringIdGenerator> = AuthoringIdGeneratorLive
): Layer.Layer<AuthoringSessions> {
	return AuthoringSessionServiceLayer.pipe(
		Layer.provide(authoringSessionDependencies(config, idLayer))
	);
}

export function makeAuthoringSessionService(
	config: AuthoringSessionServiceConfig,
	idLayer: Layer.Layer<AuthoringIdGenerator> = AuthoringIdGeneratorLive
): Effect.Effect<AuthoringSessionService> {
	return makeAuthoringSessionServiceEffect().pipe(
		Effect.provide(authoringSessionDependencies(config, idLayer))
	);
}
