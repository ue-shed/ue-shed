import { randomUUID } from "node:crypto";
import {
	copyFile,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	unlink
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ErrorCauseFields, ErrorGuidanceFields } from "@ue-shed/protocol";
import { Context, Effect, Layer, Schema } from "effect";
import { fileFailureReason } from "./file-failure.js";
import {
	decodeCaptureRun,
	decodeReviewSet,
	ReviewSet,
	ReviewSetId,
	type CaptureRun
} from "./review-schema.js";

/**
 * Default project-relative .ue-shed/review storage for review sets and immutable runs.
 * Host-provided capture destinations can replace publication storage.
 */
export const DEFAULT_REVIEW_ROOT = ".ue-shed/review";

function hasErrorCode(cause: unknown, code: string): boolean {
	return cause instanceof Object && "code" in cause && cause.code === code;
}

/**
 * Review repository operation/path failure retaining original IO/parser cause and recovery.
 * Partial publication/cleanup failures must be reconciled before claiming a run was
 * finalized.
 */
export class ReviewStorageError extends Schema.TaggedError<ReviewStorageError>()(
	"ReviewStorageError",
	{
		...ErrorGuidanceFields,
		...ErrorCauseFields,
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
		path: Schema.String
	}
) {}

/**
 * Capture source is not authorized beneath the declared artifact root. Reject arbitrary
 * producer paths rather than copying them into trusted run history.
 */
export class ReviewArtifactSourceRejected extends Schema.TaggedError<ReviewArtifactSourceRejected>()(
	"ReviewArtifactSourceRejected",
	{
		...ErrorGuidanceFields,
		path: Schema.String,
		root: Schema.String
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
				message: `Could not load Review Set ${path} because ${fileFailureReason(cause)}.`,
				operation: "load_set",
				path,
				recovery: "Validate or repair the Review Set document, then retry.",
				retrySafe: true,
				nextStep: "fix_input",
				cause
			})
	}).pipe(
		Effect.flatMap((input) =>
			decodeReviewSet(input).pipe(
				Effect.mapError(
					(cause) =>
						new ReviewStorageError({
							message: `Review Set ${path} does not match the Review Set contract.`,
							operation: "load_set",
							path,
							recovery: "Validate or repair the Review Set document, then retry.",
							retrySafe: true,
							nextStep: "fix_input",
							cause
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
				message: `Could not check for Review Set ${path} because ${fileFailureReason(cause)}.`,
				operation: "load_set",
				path,
				recovery: "Check that the Review Set directory is readable.",
				retrySafe: true,
				nextStep: "retry",
				cause
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
				message: `Could not save Review Set ${args.path} because ${fileFailureReason(cause)}.`,
				operation: "save_set",
				path: args.path,
				recovery: "Check that the Review Set directory is writable.",
				retrySafe: true,
				nextStep: "retry",
				cause
			})
	}).pipe(Effect.withSpan("camera.review.set.save", { attributes: { path: args.path } }));
}

/**
 * Saved review-set listing with ID, display name, map, path and view count. Load the set for
 * full approved poses and policy definitions.
 */
export interface ReviewSetSummary {
	readonly displayName: string;
	readonly id: ReviewSet["id"];
	readonly mapPath: string;
	readonly path: string;
	readonly viewCount: number;
}

/**
 * Resolves the project-local review-set directory from an explicit project root. This pure
 * path helper does not discover a project or create directories.
 */
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
	return Effect.gen(function* () {
		const entries = yield* Effect.tryPromise({
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
					message: `Could not list Review Sets in ${root} because ${fileFailureReason(cause)}.`,
					cause,
					operation: "list_sets",
					path: root,
					recovery:
						"Check the project Review Set directory and repair malformed documents.",
					retrySafe: true,
					nextStep: "fix_input"
				})
		});
		const sets = yield* Effect.forEach(entries, ({ input, path }) =>
			decodeReviewSet(input).pipe(
				Effect.map((reviewSet) => summarizeReviewSet(path, reviewSet)),
				Effect.mapError(
					(cause) =>
						new ReviewStorageError({
							message: `Review Set ${path} does not match the Review Set contract.`,
							cause,
							operation: "list_sets",
							path,
							recovery: "Validate or repair the malformed Review Set document.",
							retrySafe: true,
							nextStep: "fix_input"
						})
				)
			)
		);
		const ids = new Set<string>();
		const duplicate = sets.find((reviewSet) => {
			if (ids.has(reviewSet.id)) return true;
			ids.add(reviewSet.id);
			return false;
		});
		if (duplicate !== undefined)
			return yield* Effect.fail(
				new ReviewStorageError({
					message: `Review Set ID ${duplicate.id} is used by more than one document.`,
					operation: "list_sets",
					path: root,
					recovery: "Give every Review Set a unique ID, then reopen the set library.",
					retrySafe: true,
					nextStep: "fix_input"
				})
			);
		return sets.toSorted(
			(left, right) =>
				left.mapPath.localeCompare(right.mapPath) ||
				left.displayName.localeCompare(right.displayName)
		);
	}).pipe(Effect.withSpan("camera.review.sets.list", { attributes: { root } }));
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

/**
 * Loads a template through ReviewRepository, assigns a fresh ID and persists a named set
 * under the explicit project. Does not change the host's active project or review-set
 * selection automatically.
 */
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
					recovery: "Enter a name for the new Review Set.",
					retrySafe: true,
					nextStep: "fix_input"
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

/**
 * Resolves the immutable capture-run root beneath an explicit project. Does not create a run
 * or establish filesystem source authorization.
 */
export function captureRunsRoot(projectRoot: string): string {
	return resolve(projectRoot, DEFAULT_REVIEW_ROOT, "runs");
}

/**
 * Prepared staged run with authorized artifact ingestion, document writing, finalization and
 * discard. A run is trusted history only after verified artifacts and finalization succeed.
 */
export interface ReviewCaptureAttempt {
	readonly discard: () => Effect.Effect<void, ReviewStorageError>;
	readonly finalize: (run: CaptureRun) => Effect.Effect<void, ReviewStorageError>;
	readonly storeArtifact: (args: {
		readonly relativePath: string;
		readonly sourceAuthorizationRoot: string;
		readonly sourcePath: string;
		readonly sourceRoot: string;
	}) => Effect.Effect<
		{ readonly bytes: Uint8Array; readonly size: number },
		ReviewArtifactSourceRejected | ReviewStorageError
	>;
	readonly writeDocument: (args: {
		readonly relativePath: string;
		readonly value: unknown;
	}) => Effect.Effect<void, ReviewStorageError>;
}

/**
 * Host-owned run preparation and document-path policy. Enables alternative publication
 * storage without coupling capture to Workbench or project picker state.
 */
export interface ReviewCaptureDestination {
	readonly prepare: (
		runId: CaptureRun["id"]
	) => Effect.Effect<ReviewCaptureAttempt, ReviewStorageError>;
	readonly runDocumentPath: (runId: CaptureRun["id"]) => string;
}

interface FilesystemReviewCaptureDestinationOptions {
	readonly authorizationRoot: string;
	readonly createRoot: boolean;
	readonly destinationRoot: string;
	readonly rejectAuthorizationRootLink: boolean;
	readonly recovery: string;
}

function isPathWithinOrSame(root: string, path: string): boolean {
	const child = relative(resolve(root), resolve(path));
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (cause) {
		if (hasErrorCode(cause, "ENOENT")) return false;
		throw cause;
	}
}

function destinationStorageError(args: {
	readonly cause: unknown;
	readonly operation: ReviewStorageError["operation"];
	readonly path: string;
	readonly recovery: string;
	readonly retrySafe: boolean;
	readonly nextStep: ReviewStorageError["nextStep"];
}): ReviewStorageError {
	return new ReviewStorageError({
		message: `Could not ${args.operation.replaceAll("_", " ")} review data at ${args.path}.`,
		cause: args.cause,
		nextStep: args.nextStep,
		operation: args.operation,
		path: args.path,
		recovery: args.recovery,
		retrySafe: args.retrySafe
	});
}

async function prepareDestinationRoot(
	options: FilesystemReviewCaptureDestinationOptions
): Promise<string> {
	if (!isAbsolute(options.authorizationRoot)) {
		throw new Error("The authorized Capture Run root must be absolute.");
	}
	const authorizationEntry = await lstat(options.authorizationRoot);
	if (!authorizationEntry.isDirectory()) {
		throw new Error("The authorized Capture Run root must be an existing directory.");
	}
	if (options.rejectAuthorizationRootLink && authorizationEntry.isSymbolicLink()) {
		throw new Error("A caller-owned Capture Run root cannot be a symbolic link or junction.");
	}
	const canonicalAuthorizationRoot = await realpath(options.authorizationRoot);
	if (options.createRoot) {
		if (!isPathWithinOrSame(options.authorizationRoot, options.destinationRoot)) {
			throw new Error("The Capture Run destination is outside its authorized root.");
		}
		const missing: string[] = [];
		let existing = options.destinationRoot;
		while (!(await pathExists(existing))) {
			missing.push(existing);
			const parent = dirname(existing);
			if (parent === existing) throw new Error("No existing destination ancestor was found.");
			existing = parent;
		}
		const canonicalExisting = await realpath(existing);
		if (!isPathWithinOrSame(canonicalAuthorizationRoot, canonicalExisting)) {
			throw new Error(
				"The Capture Run destination escapes through an existing reparse point."
			);
		}
		for (const directory of missing.reverse()) {
			await mkdir(directory);
			const canonicalDirectory = await realpath(directory);
			if (!isPathWithinOrSame(canonicalAuthorizationRoot, canonicalDirectory)) {
				throw new Error(
					"The Capture Run destination escaped while creating its directory."
				);
			}
		}
	}
	const destinationEntry = await lstat(options.destinationRoot);
	if (!destinationEntry.isDirectory()) {
		throw new Error("The Capture Run destination must be a directory.");
	}
	const canonicalDestinationRoot = await realpath(options.destinationRoot);
	if (!isPathWithinOrSame(canonicalAuthorizationRoot, canonicalDestinationRoot)) {
		throw new Error(
			"The Capture Run destination escapes its authorized root through a reparse point."
		);
	}
	return canonicalDestinationRoot;
}

async function containedAttemptPath(args: {
	readonly attemptRoot: string;
	readonly relativePath: string;
}): Promise<string> {
	if (isAbsolute(args.relativePath)) {
		throw new Error("Capture Run paths must be relative.");
	}
	const destinationPath = resolve(args.attemptRoot, args.relativePath);
	if (!isPathWithin(args.attemptRoot, destinationPath)) {
		throw new Error("The Capture Run path escapes its prepared attempt.");
	}
	const parentPath = dirname(destinationPath);
	const parentSegments = relative(args.attemptRoot, parentPath);
	let canonicalParent = args.attemptRoot;
	for (const segment of parentSegments === "" ? [] : parentSegments.split(sep)) {
		const candidate = join(canonicalParent, segment);
		if (!(await pathExists(candidate))) await mkdir(candidate);
		canonicalParent = await realpath(candidate);
		if (!isPathWithinOrSame(args.attemptRoot, canonicalParent)) {
			throw new Error("The Capture Run path escapes through a symbolic link or junction.");
		}
	}
	return join(canonicalParent, basename(destinationPath));
}

async function authorizedArtifactSource(args: {
	readonly sourceAuthorizationRoot: string;
	readonly sourcePath: string;
	readonly sourceRoot: string;
}): Promise<string | undefined> {
	if (!isAbsolute(args.sourceRoot) || !isAbsolute(args.sourcePath)) return undefined;
	try {
		const canonicalAuthorizationRoot = await realpath(args.sourceAuthorizationRoot);
		const canonicalRoot = await realpath(args.sourceRoot);
		const canonicalSource = await realpath(args.sourcePath);
		return isPathWithin(canonicalAuthorizationRoot, canonicalRoot) &&
			isPathWithin(canonicalRoot, canonicalSource)
			? canonicalSource
			: undefined;
	} catch (cause) {
		if (hasErrorCode(cause, "ENOENT")) return undefined;
		throw cause;
	}
}

function filesystemReviewCaptureDestination(
	options: FilesystemReviewCaptureDestinationOptions
): ReviewCaptureDestination {
	const prepare = Effect.fn("ReviewCaptureDestination.prepare")(function* (
		runId: CaptureRun["id"]
	) {
		const destinationRoot = yield* Effect.tryPromise({
			try: () => prepareDestinationRoot(options),
			catch: (cause) =>
				destinationStorageError({
					cause,
					operation: "prepare_run",
					path: options.destinationRoot,
					recovery: options.recovery,
					retrySafe: true,
					nextStep: "fix_input"
				})
		});
		const stagingRoot = join(destinationRoot, `.staging-${runId}`);
		const finalRoot = join(destinationRoot, runId);
		yield* Effect.tryPromise({
			try: async () => {
				if (await pathExists(finalRoot)) {
					throw new Error(`Capture Run ${runId} already exists.`);
				}
				await mkdir(stagingRoot);
			},
			catch: (cause) =>
				destinationStorageError({
					cause,
					operation: "prepare_run",
					path: stagingRoot,
					recovery: "Choose a new Capture Run identity or inspect the existing attempt.",
					retrySafe: false,
					nextStep: "reconcile"
				})
		});

		const discard = Effect.fn("ReviewCaptureAttempt.discard")(function* () {
			yield* Effect.tryPromise({
				try: () => rm(stagingRoot, { force: true, recursive: true }),
				catch: (cause) =>
					destinationStorageError({
						cause,
						operation: "discard_staging",
						path: stagingRoot,
						recovery: "Remove the owned .staging-* attempt manually if it remains.",
						retrySafe: true,
						nextStep: "retry"
					})
			});
		});
		const writeDocument = Effect.fn("ReviewCaptureAttempt.writeDocument")(function* (args: {
			readonly relativePath: string;
			readonly value: unknown;
		}) {
			yield* Effect.tryPromise({
				try: async () => {
					const path = await containedAttemptPath({
						attemptRoot: stagingRoot,
						relativePath: args.relativePath
					});
					await writeJsonAtomically(path, args.value);
				},
				catch: (cause) =>
					destinationStorageError({
						cause,
						operation: "write_run",
						path: stagingRoot,
						recovery: "Check the Capture Run destination and retry the attempt.",
						retrySafe: true,
						nextStep: "retry"
					})
			});
		});
		const storeArtifact = Effect.fn("ReviewCaptureAttempt.storeArtifact")(function* (args: {
			readonly relativePath: string;
			readonly sourceAuthorizationRoot: string;
			readonly sourcePath: string;
			readonly sourceRoot: string;
		}) {
			const sourcePath = yield* Effect.tryPromise({
				try: () => authorizedArtifactSource(args),
				catch: (cause) =>
					destinationStorageError({
						cause,
						operation: "store_artifact",
						path: args.sourcePath,
						recovery: "Inspect Unreal staging and retry the capture.",
						retrySafe: true,
						nextStep: "retry"
					})
			});
			if (sourcePath === undefined) {
				return yield* Effect.fail(
					new ReviewArtifactSourceRejected({
						message: "Unreal returned an artifact outside its authorized staging root.",
						nextStep: "escalate",
						path: args.sourcePath,
						recovery:
							"Do not trust this capture; update the Core and Cameras plugins together and report the artifact path if it recurs.",
						retrySafe: false,
						root: args.sourceRoot
					})
				);
			}
			return yield* Effect.tryPromise({
				try: async () => {
					const destinationPath = await containedAttemptPath({
						attemptRoot: stagingRoot,
						relativePath: args.relativePath
					});
					const handle = await open(destinationPath, "wx");
					try {
						const bytes = await readFile(sourcePath);
						await handle.writeFile(bytes);
						await handle.sync();
						await unlink(sourcePath).catch(() => undefined);
						return { bytes: new Uint8Array(bytes), size: bytes.byteLength };
					} finally {
						await handle.close();
					}
				},
				catch: (cause) =>
					destinationStorageError({
						cause,
						operation: "store_artifact",
						path: stagingRoot,
						recovery: "Check Unreal staging and Capture Run destination permissions.",
						retrySafe: false,
						nextStep: "reconcile"
					})
			});
		});
		const finalize = Effect.fn("ReviewCaptureAttempt.finalize")(function* (run: CaptureRun) {
			yield* Effect.tryPromise({
				try: async () => {
					if (await pathExists(finalRoot)) {
						throw new Error(`Capture Run ${runId} already exists.`);
					}
					await writeJsonAtomically(join(stagingRoot, "run.json"), run);
					await rename(stagingRoot, finalRoot);
				},
				catch: (cause) =>
					destinationStorageError({
						cause,
						operation: "finalize_run",
						path: stagingRoot,
						recovery: "Inspect the staged Capture Run and retry finalization safely.",
						retrySafe: false,
						nextStep: "reconcile"
					})
			});
		});
		return { discard, finalize, storeArtifact, writeDocument } satisfies ReviewCaptureAttempt;
	});
	return {
		prepare,
		runDocumentPath: (runId) => join(options.destinationRoot, runId, "run.json")
	};
}

/** The compatibility adapter that publishes beneath `<project>/.ue-shed/review/runs`. */
export function projectLocalReviewCaptureDestination(
	projectRoot: string
): ReviewCaptureDestination {
	const absoluteProjectRoot = resolve(projectRoot);
	return filesystemReviewCaptureDestination({
		authorizationRoot: absoluteProjectRoot,
		createRoot: true,
		destinationRoot: captureRunsRoot(absoluteProjectRoot),
		recovery: "Check that the project and its review directory are writable.",
		rejectAuthorizationRootLink: false
	});
}

/** A trusted-host adapter for one existing, absolute, caller-authorized Capture Run root. */
export function callerOwnedReviewCaptureDestination(root: string): ReviewCaptureDestination {
	return filesystemReviewCaptureDestination({
		authorizationRoot: root,
		createRoot: false,
		destinationRoot: root,
		recovery:
			"Select an existing absolute directory that the caller authorizes for Capture Runs.",
		rejectAuthorizationRootLink: true
	});
}

function loadCaptureRunWithNode(path: string): Effect.Effect<CaptureRun, ReviewStorageError> {
	return Effect.tryPromise({
		try: async () =>
			Schema.decodeUnknownSync(Schema.Json)(JSON.parse(await readFile(path, "utf8"))),
		catch: (cause) =>
			new ReviewStorageError({
				message: `Could not load Capture Run ${path} because ${fileFailureReason(cause)}.`,
				operation: "load_run",
				path,
				recovery:
					"Inspect the immutable Capture Run bundle or restore it from evidence storage.",
				retrySafe: true,
				nextStep: "fix_input",
				cause
			})
	}).pipe(
		Effect.flatMap((input) =>
			decodeCaptureRun(input).pipe(
				Effect.mapError(
					(cause) =>
						new ReviewStorageError({
							message: `Capture Run ${path} does not match the Capture Run contract.`,
							operation: "load_run",
							path,
							recovery:
								"Inspect the immutable Capture Run bundle or restore it from evidence storage.",
							retrySafe: true,
							nextStep: "escalate",
							cause
						})
				)
			)
		)
	);
}

/**
 * Saved run listing with set/run identity, completion/status and success/failure counts. A
 * completed_with_failures run retains useful successful artifacts and explicit failures.
 */
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
				message: `Could not list Capture Runs in ${root} because ${fileFailureReason(cause)}.`,
				operation: "list_runs",
				path: root,
				recovery: "Check the local review-run directory and repair malformed bundles.",
				retrySafe: true,
				nextStep: "fix_input",
				cause
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
								message: `Capture Run ${path} does not match the Capture Run contract.`,
								operation: "list_runs",
								path,
								recovery: "Repair or remove the malformed Capture Run bundle.",
								retrySafe: true,
								nextStep: "fix_input",
								cause
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

/**
 * Lexically checks strict path containment after resolution, excluding the root itself. This
 * is not symlink/realpath authorization; IO boundaries must validate actual filesystem
 * ownership separately.
 */
export function isPathWithin(root: string, path: string): boolean {
	const child = relative(resolve(root), resolve(path));
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/**
 * Builds the default run.json destination from explicit project and already validated run ID.
 * Does not reserve storage or validate arbitrary untrusted path components.
 */
export function captureRunPath(projectRoot: string, runId: string): string {
	return join(captureRunsRoot(projectRoot), runId, "run.json");
}

/**
 * Returns the parent directory name of a run document for display/lookup. Does not parse the
 * document or validate that the directory is an authorized capture run.
 */
export function runIdFromPath(path: string): string {
	return basename(dirname(path));
}

/**
 * Review-set and immutable run storage with staged publication and verified artifact copying.
 * Hosts may replace IO while preserving source authorization, migration and partial-write
 * recovery.
 */
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

/** @deprecated Use `ReviewRepositoryApi`. */
export type ReviewRepositoryShape = ReviewRepositoryApi;

/**
 * Headless review persistence boundary. No operation requires a Workbench shell or maintains
 * a separate active project.
 */
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
					message: `Could not prepare Capture Run staging ${args.stagingRoot} because ${fileFailureReason(cause)}.`,
					operation: "prepare_run",
					path: args.stagingRoot,
					recovery: "Check that the project review directory is writable.",
					retrySafe: false,
					nextStep: "reconcile",
					cause
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
					message: `Could not store artifact ${args.destinationPath} from ${args.sourcePath} because ${fileFailureReason(cause)}.`,
					operation: "store_artifact",
					path: args.destinationPath,
					recovery: "Check staging and evidence directory permissions, then retry.",
					retrySafe: true,
					nextStep: "retry",
					cause
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
					message: `Could not write Capture Run document ${args.path} because ${fileFailureReason(cause)}.`,
					operation: "write_run",
					path: args.path,
					recovery: "Check the evidence directory and retry the run.",
					retrySafe: true,
					nextStep: "retry",
					cause
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
					message: `Could not finalize Capture Run ${args.stagingRoot} into ${args.finalRoot} because ${fileFailureReason(cause)}.`,
					operation: "finalize_run",
					path: args.stagingRoot,
					recovery: "Inspect the staged Capture Run and retry finalization safely.",
					retrySafe: false,
					nextStep: "reconcile",
					cause
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
					message: `Could not discard Capture Run staging ${stagingRoot} because ${fileFailureReason(cause)}.`,
					operation: "discard_staging",
					path: stagingRoot,
					recovery: "Remove the leftover .staging-* directory manually if it remains.",
					retrySafe: true,
					nextStep: "retry",
					cause
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

/**
 * Node review repository with validated/migrated documents, scoped artifact-source checks and
 * staged run finalization. Methods perform IO; construction does not create a project or
 * capture.
 */
export const ReviewRepositoryLive = Layer.sync(ReviewRepository, makeReviewRepository);

/** A test layer over a complete fake repository; the test decides every operation. */
export function makeReviewRepositoryTestLayer(
	service: ReviewRepositoryApi
): Layer.Layer<ReviewRepository> {
	return Layer.succeed(ReviewRepository, ReviewRepository.of(service));
}

/**
 * Loads and validates/migrates a saved set through ReviewRepository. Missing or invalid input
 * is a typed storage failure rather than an empty set.
 */
export function loadReviewSet(
	path: string
): Effect.Effect<ReviewSet, ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) => repository.loadSet(path));
}

/**
 * Looks up a set through ReviewRepository, returning undefined when absent.
 * Corrupt/unreadable data remains a typed failure rather than being treated as absence.
 */
export function findReviewSet(
	path: string
): Effect.Effect<ReviewSet | undefined, ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) => repository.findSet(path));
}

/**
 * Persists a validated set at an explicit destination through ReviewRepository. Does not
 * capture frames or change host project/set selection.
 */
export function saveReviewSet(args: {
	readonly path: string;
	readonly reviewSet: ReviewSet;
}): Effect.Effect<void, ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) => repository.saveSet(args));
}

/**
 * Loads and validates/migrates immutable run history through ReviewRepository. Legacy missing
 * realization remains explicit instead of being filled from today's approved pose.
 */
export function loadCaptureRun(
	path: string
): Effect.Effect<CaptureRun, ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) => repository.loadRun(path));
}

/**
 * Lists saved run summaries beneath an explicit project via ReviewRepository. Consumers load
 * a run for its per-view artifacts and failure details.
 */
export function listCaptureRuns(
	projectRoot: string
): Effect.Effect<readonly CaptureRunSummary[], ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) => repository.listRuns(projectRoot));
}

/**
 * Lists saved set summaries beneath an explicit project via ReviewRepository. The result does
 * not implicitly activate the first set.
 */
export function listReviewSets(
	projectRoot: string
): Effect.Effect<readonly ReviewSetSummary[], ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) => repository.listSets(projectRoot));
}
