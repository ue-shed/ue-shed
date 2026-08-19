import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";

export class CaptureFilesystemError extends Schema.TaggedErrorClass<CaptureFilesystemError>()(
	"CaptureFilesystemError",
	{
		message: Schema.String,
		operation: Schema.Literals(["discard", "prepare", "promote", "store", "write"]),
		path: Schema.String,
		recovery: Schema.String
	}
) {}

export class CaptureArtifactSourceRejected extends Schema.TaggedErrorClass<CaptureArtifactSourceRejected>()(
	"CaptureArtifactSourceRejected",
	{
		message: Schema.String,
		path: Schema.String,
		root: Schema.String
	}
) {}

export interface FilesystemCaptureAttempt {
	readonly discard: () => Effect.Effect<void, CaptureFilesystemError>;
	readonly promote: (args: {
		readonly documentName: string;
		readonly documentValue: unknown;
		readonly relativeDestination: string;
	}) => Effect.Effect<string, CaptureFilesystemError>;
	readonly storeArtifact: (args: {
		readonly relativePath: string;
		readonly sourceAuthorizationRoot: string;
		readonly sourcePath: string;
		readonly sourceRoot: string;
	}) => Effect.Effect<
		{ readonly bytes: Uint8Array; readonly size: number },
		CaptureArtifactSourceRejected | CaptureFilesystemError
	>;
	readonly writeDocument: (args: {
		readonly relativePath: string;
		readonly value: unknown;
	}) => Effect.Effect<void, CaptureFilesystemError>;
}

export interface FilesystemCaptureDestination {
	readonly documentPath: (relativeDestination: string, documentName: string) => string;
	readonly prepare: (args: {
		readonly attemptName: string;
		readonly reservedDestinations: ReadonlyArray<string>;
	}) => Effect.Effect<FilesystemCaptureAttempt, CaptureFilesystemError>;
}

export interface FilesystemCaptureDestinationOptions {
	readonly authorizationRoot: string;
	readonly createRoot: boolean;
	readonly destinationRoot: string;
	readonly rejectAuthorizationRootLink: boolean;
	readonly recovery: string;
}

function hasErrorCode(cause: unknown, code: string): boolean {
	return cause instanceof Object && "code" in cause && cause.code === code;
}

function isPathWithin(root: string, path: string): boolean {
	const child = relative(resolve(root), resolve(path));
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
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

function filesystemError(args: {
	readonly cause: unknown;
	readonly operation: CaptureFilesystemError["operation"];
	readonly path: string;
	readonly recovery: string;
}): CaptureFilesystemError {
	return new CaptureFilesystemError({
		message: String(args.cause),
		operation: args.operation,
		path: args.path,
		recovery: args.recovery
	});
}

async function prepareDestinationRoot(
	options: FilesystemCaptureDestinationOptions
): Promise<string> {
	if (!isAbsolute(options.authorizationRoot)) {
		throw new Error("The authorized capture destination root must be absolute.");
	}
	const authorizationEntry = await lstat(options.authorizationRoot);
	if (!authorizationEntry.isDirectory()) {
		throw new Error("The authorized capture destination root must be an existing directory.");
	}
	if (options.rejectAuthorizationRootLink && authorizationEntry.isSymbolicLink()) {
		throw new Error(
			"A caller-owned capture destination root cannot be a symbolic link or junction."
		);
	}
	const canonicalAuthorizationRoot = await realpath(options.authorizationRoot);
	if (options.createRoot) {
		if (!isPathWithinOrSame(options.authorizationRoot, options.destinationRoot)) {
			throw new Error("The capture destination is outside its authorized root.");
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
			throw new Error("The capture destination escapes through an existing reparse point.");
		}
		for (const directory of missing.reverse()) {
			await mkdir(directory);
			const canonicalDirectory = await realpath(directory);
			if (!isPathWithinOrSame(canonicalAuthorizationRoot, canonicalDirectory)) {
				throw new Error("The capture destination escaped while creating its directory.");
			}
		}
	}
	const destinationEntry = await lstat(options.destinationRoot);
	if (!destinationEntry.isDirectory()) {
		throw new Error("The capture destination must be a directory.");
	}
	const canonicalDestinationRoot = await realpath(options.destinationRoot);
	if (!isPathWithinOrSame(canonicalAuthorizationRoot, canonicalDestinationRoot)) {
		throw new Error(
			"The capture destination escapes its authorized root through a reparse point."
		);
	}
	return canonicalDestinationRoot;
}

async function containedPath(args: {
	readonly allowExistingParent: boolean;
	readonly relativePath: string;
	readonly root: string;
}): Promise<string> {
	if (isAbsolute(args.relativePath))
		throw new Error("Capture destination paths must be relative.");
	const destinationPath = resolve(args.root, args.relativePath);
	if (!isPathWithin(args.root, destinationPath)) {
		throw new Error("The capture destination path escapes its authorized root.");
	}
	if (args.allowExistingParent) await mkdir(dirname(destinationPath), { recursive: true });
	const canonicalParent = await realpath(dirname(destinationPath));
	if (!isPathWithinOrSame(args.root, canonicalParent)) {
		throw new Error(
			"The capture destination path escapes through a symbolic link or junction."
		);
	}
	return join(canonicalParent, basename(destinationPath));
}

async function authorizedArtifactSource(args: {
	readonly sourceAuthorizationRoot: string;
	readonly sourcePath: string;
	readonly sourceRoot: string;
}): Promise<string | undefined> {
	if (
		!isAbsolute(args.sourceAuthorizationRoot) ||
		!isAbsolute(args.sourceRoot) ||
		!isAbsolute(args.sourcePath)
	) {
		return undefined;
	}
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

export function makeFilesystemCaptureDestination(
	options: FilesystemCaptureDestinationOptions
): FilesystemCaptureDestination {
	const prepare = Effect.fn("CaptureFilesystemDestination.prepare")(function* (args: {
		readonly attemptName: string;
		readonly reservedDestinations: ReadonlyArray<string>;
	}) {
		const destinationRoot = yield* Effect.tryPromise({
			try: () => prepareDestinationRoot(options),
			catch: (cause) =>
				filesystemError({
					cause,
					operation: "prepare",
					path: options.destinationRoot,
					recovery: options.recovery
				})
		});
		const stagingRoot = yield* Effect.tryPromise({
			try: async () => {
				for (const reserved of args.reservedDestinations) {
					const reservedPath = await containedPath({
						allowExistingParent: true,
						relativePath: reserved,
						root: destinationRoot
					});
					if (await pathExists(reservedPath)) {
						throw new Error(`Capture destination ${reserved} already exists.`);
					}
				}
				const attemptRoot = await containedPath({
					allowExistingParent: false,
					relativePath: args.attemptName,
					root: destinationRoot
				});
				await mkdir(attemptRoot);
				return attemptRoot;
			},
			catch: (cause) =>
				filesystemError({
					cause,
					operation: "prepare",
					path: destinationRoot,
					recovery:
						"Choose a new capture identity or inspect the existing run and attempt."
				})
		});

		const discard = Effect.fn("CaptureFilesystemAttempt.discard")(function* () {
			yield* Effect.tryPromise({
				try: () => rm(stagingRoot, { force: true, recursive: true }),
				catch: (cause) =>
					filesystemError({
						cause,
						operation: "discard",
						path: stagingRoot,
						recovery: "Remove the owned staging attempt manually if it remains."
					})
			});
		});
		const writeDocument = Effect.fn("CaptureFilesystemAttempt.writeDocument")(
			function* (input: { readonly relativePath: string; readonly value: unknown }) {
				yield* Effect.tryPromise({
					try: async () => {
						const path = await containedPath({
							allowExistingParent: true,
							relativePath: input.relativePath,
							root: stagingRoot
						});
						await writeJsonAtomically(path, input.value);
					},
					catch: (cause) =>
						filesystemError({
							cause,
							operation: "write",
							path: stagingRoot,
							recovery: "Check capture destination permissions and retry the attempt."
						})
				});
			}
		);
		const storeArtifact = Effect.fn("CaptureFilesystemAttempt.storeArtifact")(
			function* (input: {
				readonly relativePath: string;
				readonly sourceAuthorizationRoot: string;
				readonly sourcePath: string;
				readonly sourceRoot: string;
			}) {
				const sourcePath = yield* Effect.tryPromise({
					try: () => authorizedArtifactSource(input),
					catch: (cause) =>
						filesystemError({
							cause,
							operation: "store",
							path: input.sourcePath,
							recovery: "Inspect Unreal staging and retry the capture."
						})
				});
				if (sourcePath === undefined) {
					return yield* Effect.fail(
						new CaptureArtifactSourceRejected({
							message:
								"Unreal returned an artifact outside its authorized staging root.",
							path: input.sourcePath,
							root: input.sourceRoot
						})
					);
				}
				return yield* Effect.tryPromise({
					try: async () => {
						const destinationPath = await containedPath({
							allowExistingParent: true,
							relativePath: input.relativePath,
							root: stagingRoot
						});
						const handle = await open(destinationPath, "wx");
						try {
							const bytes = await readFile(sourcePath);
							if (bytes.byteLength === 0)
								throw new Error("Staged artifact is empty.");
							await handle.writeFile(bytes);
							await handle.sync();
							await unlink(sourcePath).catch(() => undefined);
							return { bytes: new Uint8Array(bytes), size: bytes.byteLength };
						} finally {
							await handle.close();
						}
					},
					catch: (cause) =>
						filesystemError({
							cause,
							operation: "store",
							path: stagingRoot,
							recovery: "Check Unreal staging and capture destination permissions."
						})
				});
			}
		);
		const promote = Effect.fn("CaptureFilesystemAttempt.promote")(function* (input: {
			readonly documentName: string;
			readonly documentValue: unknown;
			readonly relativeDestination: string;
		}) {
			return yield* Effect.tryPromise({
				try: async () => {
					const finalRoot = await containedPath({
						allowExistingParent: true,
						relativePath: input.relativeDestination,
						root: destinationRoot
					});
					if (await pathExists(finalRoot)) {
						throw new Error(
							`Capture destination ${input.relativeDestination} already exists.`
						);
					}
					const documentPath = await containedPath({
						allowExistingParent: true,
						relativePath: input.documentName,
						root: stagingRoot
					});
					await writeJsonAtomically(documentPath, input.documentValue);
					await rename(stagingRoot, finalRoot);
					return join(finalRoot, input.documentName);
				},
				catch: (cause) =>
					filesystemError({
						cause,
						operation: "promote",
						path: stagingRoot,
						recovery: "Inspect the staged capture and retry atomic promotion safely."
					})
			});
		});
		return {
			discard,
			promote,
			storeArtifact,
			writeDocument
		} satisfies FilesystemCaptureAttempt;
	});
	return {
		documentPath: (relativeDestination, documentName) =>
			join(options.destinationRoot, relativeDestination, documentName),
		prepare
	};
}
