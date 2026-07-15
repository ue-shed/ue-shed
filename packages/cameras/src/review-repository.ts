import { randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	unlink
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import {
	decodeCaptureRun,
	decodeReviewSet,
	type CaptureRun,
	type ReviewSet
} from "./review-schema.js";

export const DEFAULT_REVIEW_ROOT = ".ue-shed/review";

export class ReviewStorageError extends Schema.TaggedErrorClass<ReviewStorageError>()(
	"ReviewStorageError",
	{
		message: Schema.String,
		operation: Schema.Literals([
			"finalize_run",
			"list_runs",
			"load_run",
			"load_set",
			"prepare_run",
			"save_set",
			"store_artifact",
			"write_run"
		]),
		path: Schema.String,
		recovery: Schema.String
	}
) {}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx");
		try {
			await handle.writeFile(`${JSON.stringify(value, null, "\t")}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	} catch (cause) {
		await rm(temporary, { force: true });
		throw cause;
	}
}

function loadReviewSetWithNode(path: string): Effect.Effect<ReviewSet, ReviewStorageError> {
	return Effect.tryPromise({
		try: async () => JSON.parse(await readFile(path, "utf8")) as unknown,
		catch: (cause) =>
			new ReviewStorageError({
				message: String(cause),
				operation: "load_set",
				path,
				recovery: "Validate or repair the Review Set document, then retry."
			})
	}).pipe(
		Effect.flatMap((input) =>
			decodeReviewSet(input).pipe(
				Effect.mapError(
					(cause) =>
						new ReviewStorageError({
							message: String(cause),
							operation: "load_set",
							path,
							recovery: "Validate or repair the Review Set document, then retry."
						})
				)
			)
		),
		Effect.withSpan("camera.review.set.load", { attributes: { path } })
	);
}

function saveReviewSetWithNode(args: {
	readonly path: string;
	readonly reviewSet: ReviewSet;
}): Effect.Effect<void, ReviewStorageError> {
	return Effect.tryPromise({
		try: async () => {
			await writeJsonAtomically(args.path, args.reviewSet);
		},
		catch: (cause) =>
			new ReviewStorageError({
				message: String(cause),
				operation: "save_set",
				path: args.path,
				recovery: "Check that the Review Set directory is writable."
			})
	}).pipe(Effect.withSpan("camera.review.set.save", { attributes: { path: args.path } }));
}

export function captureRunsRoot(projectRoot: string): string {
	return resolve(projectRoot, DEFAULT_REVIEW_ROOT, "runs");
}

function loadCaptureRunWithNode(path: string): Effect.Effect<CaptureRun, ReviewStorageError> {
	return Effect.tryPromise({
		try: async () => JSON.parse(await readFile(path, "utf8")) as unknown,
		catch: (cause) =>
			new ReviewStorageError({
				message: String(cause),
				operation: "load_run",
				path,
				recovery:
					"Inspect the immutable Capture Run bundle or restore it from evidence storage."
			})
	}).pipe(
		Effect.flatMap((input) =>
			decodeCaptureRun(input).pipe(
				Effect.mapError(
					(cause) =>
						new ReviewStorageError({
							message: String(cause),
							operation: "load_run",
							path,
							recovery:
								"Inspect the immutable Capture Run bundle or restore it from evidence storage."
						})
				)
			)
		)
	);
}

export interface CaptureRunSummary {
	readonly completedAt: string;
	readonly failedViews: number;
	readonly id: string;
	readonly path: string;
	readonly reviewSetId: string;
	readonly status: CaptureRun["status"];
	readonly successfulViews: number;
}

function listCaptureRunsWithNode(
	projectRoot: string
): Effect.Effect<readonly CaptureRunSummary[], ReviewStorageError> {
	const root = captureRunsRoot(projectRoot);
	return Effect.tryPromise({
		try: async () => {
			await mkdir(root, { recursive: true });
			const directories = (await readdir(root, { withFileTypes: true })).filter(
				(entry) => entry.isDirectory() && !entry.name.startsWith(".staging-")
			);
			return Promise.all(
				directories.map(async (entry) => {
					const path = join(root, entry.name, "run.json");
					return { input: JSON.parse(await readFile(path, "utf8")) as unknown, path };
				})
			);
		},
		catch: (cause) =>
			new ReviewStorageError({
				message: String(cause),
				operation: "list_runs",
				path: root,
				recovery: "Check the local review-run directory and repair malformed bundles."
			})
	}).pipe(
		Effect.flatMap((entries) =>
			Effect.forEach(entries, ({ input, path }) =>
				decodeCaptureRun(input).pipe(
					Effect.map(
						(run) =>
							({
								completedAt: run.completedAt,
								failedViews: run.results.filter(
									(result) => result.status === "failed"
								).length,
								id: run.id,
								path,
								reviewSetId: run.reviewSetId,
								status: run.status,
								successfulViews: run.results.filter(
									(result) => result.status === "captured"
								).length
							}) satisfies CaptureRunSummary
					),
					Effect.mapError(
						(cause) =>
							new ReviewStorageError({
								message: String(cause),
								operation: "list_runs",
								path,
								recovery: "Repair or remove the malformed Capture Run bundle."
							})
					)
				)
			)
		),
		Effect.map((runs) =>
			runs.toSorted((left, right) => right.completedAt.localeCompare(left.completedAt))
		),
		Effect.withSpan("camera.review.runs.list", { attributes: { root } })
	);
}

export function isPathWithin(root: string, path: string): boolean {
	const child = relative(resolve(root), resolve(path));
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export function captureRunPath(projectRoot: string, runId: string): string {
	return join(captureRunsRoot(projectRoot), runId, "run.json");
}

export function runIdFromPath(path: string): string {
	return basename(dirname(path));
}

export interface ReviewRepositoryShape {
	readonly finalizeRun: (args: {
		readonly finalRoot: string;
		readonly run: CaptureRun;
		readonly stagingRoot: string;
	}) => Effect.Effect<void, ReviewStorageError>;
	readonly listRuns: (
		projectRoot: string
	) => Effect.Effect<readonly CaptureRunSummary[], ReviewStorageError>;
	readonly loadRun: (path: string) => Effect.Effect<CaptureRun, ReviewStorageError>;
	readonly loadSet: (path: string) => Effect.Effect<ReviewSet, ReviewStorageError>;
	readonly prepareRun: (args: {
		readonly root: string;
		readonly stagingRoot: string;
	}) => Effect.Effect<void, ReviewStorageError>;
	readonly saveSet: (args: {
		readonly path: string;
		readonly reviewSet: ReviewSet;
	}) => Effect.Effect<void, ReviewStorageError>;
	readonly storeArtifact: (args: {
		readonly destinationPath: string;
		readonly sourcePath: string;
	}) => Effect.Effect<{ readonly bytes: Uint8Array; readonly size: number }, ReviewStorageError>;
	readonly writeRunDocument: (args: {
		readonly path: string;
		readonly value: unknown;
	}) => Effect.Effect<void, ReviewStorageError>;
}

export class ReviewRepository extends Context.Service<ReviewRepository, ReviewRepositoryShape>()(
	"@ue-shed/cameras/ReviewRepository"
) {}

const makeReviewRepository = (): ReviewRepositoryShape => {
	const prepareRun = Effect.fn("ReviewRepository.prepareRun")(function* (args: {
		readonly root: string;
		readonly stagingRoot: string;
	}) {
		yield* Effect.tryPromise({
			try: async () => {
				await mkdir(args.root, { recursive: true });
				await mkdir(args.stagingRoot);
			},
			catch: (cause) =>
				new ReviewStorageError({
					message: String(cause),
					operation: "prepare_run",
					path: args.stagingRoot,
					recovery: "Check that the project review directory is writable."
				})
		});
	});
	const storeArtifact = Effect.fn("ReviewRepository.storeArtifact")(function* (args: {
		readonly destinationPath: string;
		readonly sourcePath: string;
	}) {
		return yield* Effect.tryPromise({
			try: async () => {
				await mkdir(dirname(args.destinationPath), { recursive: true });
				await copyFile(args.sourcePath, args.destinationPath);
				const bytes = await readFile(args.destinationPath);
				const file = await stat(args.destinationPath);
				await unlink(args.sourcePath).catch(() => undefined);
				return { bytes: new Uint8Array(bytes), size: file.size };
			},
			catch: (cause) =>
				new ReviewStorageError({
					message: String(cause),
					operation: "store_artifact",
					path: args.destinationPath,
					recovery: "Check staging and evidence directory permissions, then retry."
				})
		});
	});
	const writeRunDocument = Effect.fn("ReviewRepository.writeRunDocument")(function* (args: {
		readonly path: string;
		readonly value: unknown;
	}) {
		yield* Effect.tryPromise({
			try: () => writeJsonAtomically(args.path, args.value),
			catch: (cause) =>
				new ReviewStorageError({
					message: String(cause),
					operation: "write_run",
					path: args.path,
					recovery: "Check the evidence directory and retry the run."
				})
		});
	});
	const finalizeRun = Effect.fn("ReviewRepository.finalizeRun")(function* (args: {
		readonly finalRoot: string;
		readonly run: CaptureRun;
		readonly stagingRoot: string;
	}) {
		yield* Effect.tryPromise({
			try: async () => {
				await writeJsonAtomically(join(args.stagingRoot, "run.json"), args.run);
				await rename(args.stagingRoot, args.finalRoot);
			},
			catch: (cause) =>
				new ReviewStorageError({
					message: String(cause),
					operation: "finalize_run",
					path: args.stagingRoot,
					recovery: "Inspect the staged Capture Run and retry finalization safely."
				})
		});
	});
	return ReviewRepository.of({
		finalizeRun,
		listRuns: Effect.fn("ReviewRepository.listRuns")(listCaptureRunsWithNode),
		loadRun: Effect.fn("ReviewRepository.loadRun")(loadCaptureRunWithNode),
		loadSet: Effect.fn("ReviewRepository.loadSet")(loadReviewSetWithNode),
		prepareRun,
		saveSet: Effect.fn("ReviewRepository.saveSet")(saveReviewSetWithNode),
		storeArtifact,
		writeRunDocument
	});
};

export const ReviewRepositoryLive = Layer.sync(ReviewRepository, makeReviewRepository);

export function makeReviewRepositoryTestLayer(
	service: ReviewRepositoryShape
): Layer.Layer<ReviewRepository> {
	return Layer.succeed(ReviewRepository, ReviewRepository.of(service));
}

export function loadReviewSet(
	path: string
): Effect.Effect<ReviewSet, ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) => repository.loadSet(path));
}

export function saveReviewSet(args: {
	readonly path: string;
	readonly reviewSet: ReviewSet;
}): Effect.Effect<void, ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) => repository.saveSet(args));
}

export function loadCaptureRun(
	path: string
): Effect.Effect<CaptureRun, ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) => repository.loadRun(path));
}

export function listCaptureRuns(
	projectRoot: string
): Effect.Effect<readonly CaptureRunSummary[], ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) => repository.listRuns(projectRoot));
}
