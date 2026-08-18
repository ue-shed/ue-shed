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
	ReviewSet,
	ReviewSetId,
	type CaptureRun
} from "./review-schema.js";

export const DEFAULT_REVIEW_ROOT = ".ue-shed/review";

function hasErrorCode(cause: unknown, code: string): boolean {
	return cause instanceof Object && "code" in cause && cause.code === code;
}

export class ReviewStorageError extends Schema.TaggedErrorClass<ReviewStorageError>()(
	"ReviewStorageError",
	{
		message: Schema.String,
		operation: Schema.Literals([
			"create_set",
			"discard_staging",
			"finalize_run",
			"list_runs",
			"list_sets",
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

async function writeJsonAtomically<Value>(path: string, value: Value): Promise<void> {
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
		try: async () =>
			Schema.decodeUnknownSync(Schema.Json)(JSON.parse(await readFile(path, "utf8"))),
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

function findReviewSetWithNode(
	path: string
): Effect.Effect<ReviewSet | undefined, ReviewStorageError> {
	return Effect.tryPromise({
		try: async () => {
			try {
				await stat(path);
				return true;
			} catch (cause) {
				if (hasErrorCode(cause, "ENOENT")) return false;
				throw cause;
			}
		},
		catch: (cause) =>
			new ReviewStorageError({
				message: String(cause),
				operation: "load_set",
				path,
				recovery: "Check that the Review Set directory is readable."
			})
	}).pipe(
		Effect.flatMap((exists) =>
			exists ? loadReviewSetWithNode(path) : Effect.succeed(undefined)
		),
		Effect.withSpan("camera.review.set.find", { attributes: { path } })
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

export interface ReviewSetSummary {
	readonly displayName: string;
	readonly id: ReviewSet["id"];
	readonly mapPath: string;
	readonly path: string;
	readonly viewCount: number;
}

export function reviewSetsRoot(projectRoot: string): string {
	return resolve(projectRoot, DEFAULT_REVIEW_ROOT, "sets");
}

function summarizeReviewSet(path: string, reviewSet: ReviewSet): ReviewSetSummary {
	return {
		displayName: reviewSet.displayName,
		id: reviewSet.id,
		mapPath: reviewSet.project.mapPath,
		path,
		viewCount: reviewSet.views.length
	};
}

function listReviewSetsWithNode(
	projectRoot: string
): Effect.Effect<readonly ReviewSetSummary[], ReviewStorageError> {
	const root = reviewSetsRoot(projectRoot);
	return Effect.tryPromise({
		try: async () => {
			await mkdir(root, { recursive: true });
			const files = (await readdir(root, { withFileTypes: true })).filter(
				(entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json")
			);
			return Promise.all(
				files.map(async (entry) => {
					const path = join(root, entry.name);
					return {
						input: Schema.decodeUnknownSync(Schema.Json)(
							JSON.parse(await readFile(path, "utf8"))
						),
						path
					};
				})
			);
		},
		catch: (cause) =>
			new ReviewStorageError({
				message: String(cause),
				operation: "list_sets",
				path: root,
				recovery: "Check the project Review Set directory and repair malformed documents."
			})
	}).pipe(
		Effect.flatMap((entries) =>
			Effect.forEach(entries, ({ input, path }) =>
				decodeReviewSet(input).pipe(
					Effect.map((reviewSet) => summarizeReviewSet(path, reviewSet)),
					Effect.mapError(
						(cause) =>
							new ReviewStorageError({
								message: String(cause),
								operation: "list_sets",
								path,
								recovery: "Validate or repair the malformed Review Set document."
							})
					)
				)
			)
		),
		Effect.flatMap((sets) => {
			const ids = new Set<string>();
			const duplicate = sets.find((reviewSet) => {
				if (ids.has(reviewSet.id)) return true;
				ids.add(reviewSet.id);
				return false;
			});
			return duplicate === undefined
				? Effect.succeed(sets)
				: Effect.fail(
						new ReviewStorageError({
							message: `Review Set ID ${duplicate.id} is used by more than one document.`,
							operation: "list_sets",
							path: root,
							recovery:
								"Give every Review Set a unique ID, then reopen the set library."
						})
					);
		}),
		Effect.map((sets) =>
			sets.toSorted(
				(left, right) =>
					left.mapPath.localeCompare(right.mapPath) ||
					left.displayName.localeCompare(right.displayName)
			)
		),
		Effect.withSpan("camera.review.sets.list", { attributes: { root } })
	);
}

function reviewSetSlug(displayName: string): string {
	return (
		displayName
			.trim()
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, "-")
			.replaceAll(/^-+|-+$/g, "")
			.slice(0, 72) || "review-set"
	);
}

export function createReviewSetFromTemplate(args: {
	readonly displayName: string;
	readonly projectRoot: string;
	readonly templatePath: string;
}): Effect.Effect<ReviewSetSummary, ReviewStorageError, ReviewRepository> {
	return Effect.gen(function* () {
		const repository = yield* ReviewRepository;
		const template = yield* repository.loadSet(args.templatePath);
		const displayName = args.displayName.trim();
		if (displayName.length === 0) {
			return yield* Effect.fail(
				new ReviewStorageError({
					message: "A Review Set display name is required.",
					operation: "create_set",
					path: reviewSetsRoot(args.projectRoot),
					recovery: "Enter a name for the new Review Set."
				})
			);
		}
		const id = ReviewSetId.make(`${reviewSetSlug(displayName)}-${randomUUID()}`);
		const path = join(reviewSetsRoot(args.projectRoot), `${id}.json`);
		const reviewSet = ReviewSet.make({
			...template,
			description: `Created from ${template.displayName} capture and visibility settings.`,
			displayName,
			id,
			views: []
		});
		yield* repository.saveSet({ path, reviewSet });
		return summarizeReviewSet(path, reviewSet);
	}).pipe(
		Effect.withSpan("camera.review.set.create", {
			attributes: { projectRoot: args.projectRoot, templatePath: args.templatePath }
		})
	);
}

export function captureRunsRoot(projectRoot: string): string {
	return resolve(projectRoot, DEFAULT_REVIEW_ROOT, "runs");
}

function loadCaptureRunWithNode(path: string): Effect.Effect<CaptureRun, ReviewStorageError> {
	return Effect.tryPromise({
		try: async () =>
			Schema.decodeUnknownSync(Schema.Json)(JSON.parse(await readFile(path, "utf8"))),
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
					return {
						input: Schema.decodeUnknownSync(Schema.Json)(
							JSON.parse(await readFile(path, "utf8"))
						),
						path
					};
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

export interface ReviewRepositoryApi {
	readonly discardStaging: (stagingRoot: string) => Effect.Effect<void, ReviewStorageError>;
	readonly findSet: (path: string) => Effect.Effect<ReviewSet | undefined, ReviewStorageError>;
	readonly finalizeRun: (args: {
		readonly finalRoot: string;
		readonly run: CaptureRun;
		readonly stagingRoot: string;
	}) => Effect.Effect<void, ReviewStorageError>;
	readonly listRuns: (
		projectRoot: string
	) => Effect.Effect<readonly CaptureRunSummary[], ReviewStorageError>;
	readonly listSets: (
		projectRoot: string
	) => Effect.Effect<readonly ReviewSetSummary[], ReviewStorageError>;
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

export class ReviewRepository extends Context.Service<ReviewRepository, ReviewRepositoryApi>()(
	"@ue-shed/cameras/ReviewRepository"
) {}

const makeReviewRepository = (): ReviewRepositoryApi => {
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
	const discardStaging = Effect.fn("ReviewRepository.discardStaging")(function* (
		stagingRoot: string
	) {
		yield* Effect.tryPromise({
			try: () => rm(stagingRoot, { force: true, recursive: true }),
			catch: (cause) =>
				new ReviewStorageError({
					message: String(cause),
					operation: "discard_staging",
					path: stagingRoot,
					recovery: "Remove the leftover .staging-* directory manually if it remains."
				})
		});
	});
	return ReviewRepository.of({
		discardStaging,
		findSet: Effect.fn("ReviewRepository.findSet")(findReviewSetWithNode),
		finalizeRun,
		listRuns: Effect.fn("ReviewRepository.listRuns")(listCaptureRunsWithNode),
		listSets: Effect.fn("ReviewRepository.listSets")(listReviewSetsWithNode),
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
	service: Omit<ReviewRepositoryApi, "listSets"> & Partial<Pick<ReviewRepositoryApi, "listSets">>
): Layer.Layer<ReviewRepository> {
	return Layer.succeed(
		ReviewRepository,
		ReviewRepository.of({
			...service,
			listSets: service.listSets ?? (() => Effect.die("Review Set listing not stubbed"))
		})
	);
}

export function loadReviewSet(
	path: string
): Effect.Effect<ReviewSet, ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) => repository.loadSet(path));
}

export function findReviewSet(
	path: string
): Effect.Effect<ReviewSet | undefined, ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) => repository.findSet(path));
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

export function listReviewSets(
	projectRoot: string
): Effect.Effect<readonly ReviewSetSummary[], ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) => repository.listSets(projectRoot));
}
