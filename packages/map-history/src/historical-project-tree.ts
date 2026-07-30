import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Schema, Scope } from "effect";
import { MapHistoryError } from "./errors.js";

const TEMPORARY_PROJECT_PREFIX = "ue-shed-map-history-";

export const HistoricalFileMutation = Schema.Union([
	Schema.Struct({
		action: Schema.Literals(["add", "edit"]),
		materializedPath: Schema.NonEmptyString,
		projectRelativePath: Schema.NonEmptyString
	}),
	Schema.Struct({
		action: Schema.Literal("delete"),
		projectRelativePath: Schema.NonEmptyString
	})
]);
export type HistoricalFileMutation = Schema.Schema.Type<typeof HistoricalFileMutation>;

export interface HistoricalProjectTree {
	readonly materializationRoot: string;
	readonly projectRoot: string;
	readonly applyRevision: (
		mutations: readonly HistoricalFileMutation[]
	) => Effect.Effect<void, MapHistoryError>;
}

function temporaryStorageError(operation: string, path: string, cause: unknown): MapHistoryError {
	return new MapHistoryError({
		cause,
		kind: "temporary_storage",
		message: `${operation} failed for ${path}: ${String(cause)}`,
		recovery: "Check temporary-directory permissions and available disk space, then retry.",
		retrySafe: true
	});
}

function invalidTarget(path: string, message: string): MapHistoryError {
	return new MapHistoryError({
		kind: "invalid_target",
		message,
		recovery: "Use a non-empty project-relative path contained by the historical project.",
		retrySafe: false
	});
}

function resolveContainedPath(projectRoot: string, projectRelativePath: string): string {
	if (projectRelativePath.length === 0 || isAbsolute(projectRelativePath)) {
		throw invalidTarget(
			projectRelativePath,
			`Historical package path must be project-relative: ${projectRelativePath}`
		);
	}
	const target = resolve(projectRoot, projectRelativePath);
	const relativeTarget = relative(projectRoot, target);
	if (
		relativeTarget.length === 0 ||
		relativeTarget === ".." ||
		relativeTarget.startsWith(`..\\`) ||
		relativeTarget.startsWith("../") ||
		isAbsolute(relativeTarget)
	) {
		throw invalidTarget(
			projectRelativePath,
			`Historical package path escapes the temporary project: ${projectRelativePath}`
		);
	}
	return target;
}

function isContainedPath(root: string, path: string): boolean {
	const contained = relative(resolve(root), resolve(path));
	return (
		contained.length > 0 &&
		contained !== ".." &&
		!contained.startsWith("..\\") &&
		!contained.startsWith("../") &&
		!isAbsolute(contained)
	);
}

function validateMutations(
	projectRoot: string,
	mutations: readonly HistoricalFileMutation[]
): readonly { readonly mutation: HistoricalFileMutation; readonly target: string }[] {
	const targets = new Set<string>();
	return mutations.map((mutation) => {
		const target = resolveContainedPath(projectRoot, mutation.projectRelativePath);
		const key = target.toLocaleLowerCase("en-US");
		if (targets.has(key)) {
			throw invalidTarget(
				mutation.projectRelativePath,
				`Historical revision contains duplicate target ${mutation.projectRelativePath}.`
			);
		}
		targets.add(key);
		return { mutation, target };
	});
}

function makeHistoricalProjectTree(operationRoot: string): HistoricalProjectTree {
	const projectRoot = resolve(operationRoot, "project");
	const materializationRoot = resolve(operationRoot, "materialized");
	const applyRevision = Effect.fn("HistoricalProjectTree.applyRevision")(function* (
		mutations: readonly HistoricalFileMutation[]
	) {
		const validated = yield* Effect.try({
			try: () => validateMutations(projectRoot, mutations),
			catch: (cause) =>
				cause instanceof MapHistoryError
					? cause
					: invalidTarget("", `Historical revision targets are invalid: ${String(cause)}`)
		});
		for (const { mutation, target } of validated) {
			if (mutation.action === "delete") {
				yield* Effect.tryPromise({
					try: () => rm(target, { force: true }),
					catch: (cause) =>
						temporaryStorageError("Delete historical package", target, cause)
				});
				continue;
			}
			yield* Effect.tryPromise({
				try: async () => {
					await mkdir(dirname(target), { recursive: true });
					if (isContainedPath(materializationRoot, mutation.materializedPath)) {
						await rm(target, { force: true });
						await rename(mutation.materializedPath, target);
					} else {
						await copyFile(mutation.materializedPath, target);
					}
				},
				catch: (cause) => temporaryStorageError("Copy historical package", target, cause)
			});
		}
	});
	return { applyRevision, materializationRoot, projectRoot };
}

function isOwnedTemporaryProject(path: string): boolean {
	return (
		dirname(path) === resolve(tmpdir()) && basename(path).startsWith(TEMPORARY_PROJECT_PREFIX)
	);
}

export function acquireHistoricalProjectTree(): Effect.Effect<
	HistoricalProjectTree,
	MapHistoryError,
	Scope.Scope
> {
	return Effect.acquireRelease(
		Effect.tryPromise({
			try: async () => {
				const operationRoot = await mkdtemp(resolve(tmpdir(), TEMPORARY_PROJECT_PREFIX));
				await Promise.all([
					mkdir(resolve(operationRoot, "materialized")),
					mkdir(resolve(operationRoot, "project"))
				]);
				return operationRoot;
			},
			catch: (cause) => temporaryStorageError("Create historical project", tmpdir(), cause)
		}).pipe(Effect.map(makeHistoricalProjectTree)),
		(tree) =>
			isOwnedTemporaryProject(dirname(tree.projectRoot))
				? Effect.promise(() =>
						rm(dirname(tree.projectRoot), { force: true, recursive: true })
					)
				: Effect.void
	);
}
