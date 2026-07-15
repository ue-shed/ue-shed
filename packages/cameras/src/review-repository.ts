import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Data, Effect } from "effect";
import {
	decodeCaptureRun,
	decodeReviewSet,
	type CaptureRun,
	type ReviewSet
} from "./review-schema.js";

export const DEFAULT_REVIEW_ROOT = ".ue-shed/review";

export class ReviewStorageError extends Data.TaggedError("ReviewStorageError")<{
	readonly message: string;
	readonly operation: "list_runs" | "load_run" | "load_set" | "save_set";
	readonly path: string;
	readonly recovery: string;
}> {}

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

export function loadReviewSet(path: string): Effect.Effect<ReviewSet, ReviewStorageError> {
	return Effect.tryPromise({
		try: async () => decodeReviewSet(JSON.parse(await readFile(path, "utf8"))),
		catch: (cause) =>
			new ReviewStorageError({
				message: String(cause),
				operation: "load_set",
				path,
				recovery: "Validate or repair the Review Set document, then retry."
			})
	}).pipe(Effect.withSpan("camera.review.set.load", { attributes: { path } }));
}

export function saveReviewSet(args: {
	readonly path: string;
	readonly reviewSet: ReviewSet;
}): Effect.Effect<void, ReviewStorageError> {
	return Effect.tryPromise({
		try: async () => {
			const valid = decodeReviewSet(args.reviewSet);
			await writeJsonAtomically(args.path, valid);
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

export function loadCaptureRun(path: string): Effect.Effect<CaptureRun, ReviewStorageError> {
	return Effect.tryPromise({
		try: async () => decodeCaptureRun(JSON.parse(await readFile(path, "utf8"))),
		catch: (cause) =>
			new ReviewStorageError({
				message: String(cause),
				operation: "load_run",
				path,
				recovery:
					"Inspect the immutable Capture Run bundle or restore it from evidence storage."
			})
	});
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

export function listCaptureRuns(
	projectRoot: string
): Effect.Effect<readonly CaptureRunSummary[], ReviewStorageError> {
	const root = captureRunsRoot(projectRoot);
	return Effect.tryPromise({
		try: async () => {
			await mkdir(root, { recursive: true });
			const directories = (await readdir(root, { withFileTypes: true })).filter(
				(entry) => entry.isDirectory() && !entry.name.startsWith(".staging-")
			);
			const runs = await Promise.all(
				directories.map(async (entry) => {
					const path = join(root, entry.name, "run.json");
					const run = decodeCaptureRun(JSON.parse(await readFile(path, "utf8")));
					return {
						completedAt: run.completedAt,
						failedViews: run.results.filter((result) => result.status === "failed")
							.length,
						id: run.id,
						path,
						reviewSetId: run.reviewSetId,
						status: run.status,
						successfulViews: run.results.filter(
							(result) => result.status === "captured"
						).length
					} satisfies CaptureRunSummary;
				})
			);
			return runs.toSorted((left, right) =>
				right.completedAt.localeCompare(left.completedAt)
			);
		},
		catch: (cause) =>
			new ReviewStorageError({
				message: String(cause),
				operation: "list_runs",
				path: root,
				recovery: "Check the local review-run directory and repair malformed bundles."
			})
	}).pipe(Effect.withSpan("camera.review.runs.list", { attributes: { root } }));
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
