import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { decodeDraftSession, type DraftSession } from "./draft.js";

export class SessionPersistenceError extends Schema.TaggedErrorClass<SessionPersistenceError>()(
	"SessionPersistenceError",
	{
		operation: Schema.Literals(["load", "save"]),
		path: Schema.String,
		message: Schema.String
	}
) {}

export interface DraftSessionRepositoryShape {
	readonly load: (path: string) => Effect.Effect<DraftSession, SessionPersistenceError>;
	readonly save: (
		path: string,
		session: DraftSession
	) => Effect.Effect<void, SessionPersistenceError>;
}

export class DraftSessionRepository extends Context.Service<
	DraftSessionRepository,
	DraftSessionRepositoryShape
>()("@ue-shed/authoring/DraftSessionRepository") {}

const makeDraftSessionRepository = (): DraftSessionRepositoryShape => {
	const save = Effect.fn("DraftSessionRepository.save")(function* (
		path: string,
		session: DraftSession
	) {
		yield* Effect.tryPromise({
			try: async () => {
				await mkdir(dirname(path), { recursive: true });
				const temporary = `${path}.${randomUUID()}.tmp`;
				try {
					await writeFile(temporary, `${JSON.stringify(session, null, "\t")}\n`, {
						encoding: "utf8",
						flag: "wx"
					});
					await rename(temporary, path);
				} catch (cause) {
					await rm(temporary, { force: true });
					throw cause;
				}
			},
			catch: (cause) =>
				new SessionPersistenceError({ message: String(cause), operation: "save", path })
		});
	});
	const load = Effect.fn("DraftSessionRepository.load")(function* (path: string) {
		const input = yield* Effect.tryPromise({
			try: async () => JSON.parse(await readFile(path, "utf8")) as unknown,
			catch: (cause) =>
				new SessionPersistenceError({ message: String(cause), operation: "load", path })
		});
		return yield* decodeDraftSession(input).pipe(
			Effect.mapError(
				(cause) =>
					new SessionPersistenceError({
						message: String(cause),
						operation: "load",
						path
					})
			)
		);
	});
	return DraftSessionRepository.of({ load, save });
};

export const DraftSessionRepositoryLive = Layer.sync(
	DraftSessionRepository,
	makeDraftSessionRepository
);

export function makeDraftSessionRepositoryTestLayer(
	service: DraftSessionRepositoryShape
): Layer.Layer<DraftSessionRepository> {
	return Layer.succeed(DraftSessionRepository, DraftSessionRepository.of(service));
}

export function saveDraftSession(
	path: string,
	session: DraftSession
): Effect.Effect<void, SessionPersistenceError, DraftSessionRepository> {
	return Effect.flatMap(DraftSessionRepository, (repository) => repository.save(path, session));
}

export function loadDraftSession(
	path: string
): Effect.Effect<DraftSession, SessionPersistenceError, DraftSessionRepository> {
	return Effect.flatMap(DraftSessionRepository, (repository) => repository.load(path));
}
