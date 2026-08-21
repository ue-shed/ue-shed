import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	access,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Context, Effect, Layer, Option, Schema, type Scope } from "effect";
import { extractPluginArchiveToDirectory } from "./archive.js";
import {
	PluginInstallCancelled,
	ActiveLeasePreventsPrune,
	CorruptCacheEntry,
	ImmutableVersionConflict,
	MalformedOrUnsafeArchive,
	PluginStorageFailure
} from "./errors.js";
import {
	PluginBundleManifest,
	ReleaseVersion,
	Sha256Checksum,
	validatePluginBundleManifest
} from "./manifest.js";
import {
	CachedPluginRelease,
	PluginLease,
	PluginSourceProvenance,
	type PluginInstallProgress,
	type PluginDistributionLimits
} from "./model.js";

const metadataFile = ".ue-shed-distribution.json";
const manifestFile = "plugins.manifest.json";
const artifactFile = "plugins.tar.gz";
const leaseRecordVersion = 1;

const StoredMetadata = Schema.Struct({
	artifactBytes: Schema.Int.check(Schema.isGreaterThan(0)),
	artifactDigest: Sha256Checksum,
	cacheIdentity: Schema.NonEmptyString,
	files: Schema.Record(Schema.String, Sha256Checksum),
	manifestDigest: Sha256Checksum,
	releaseIdentity: Schema.NonEmptyString,
	releaseVersion: ReleaseVersion,
	schemaVersion: Schema.Literal(1),
	source: PluginSourceProvenance
});
type StoredMetadata = typeof StoredMetadata.Type;

const LeaseRecord = Schema.Struct({
	createdAt: Schema.String,
	identity: Schema.NonEmptyString,
	pid: Schema.Int.check(Schema.isGreaterThan(0)),
	releaseVersion: ReleaseVersion,
	schemaVersion: Schema.Literal(leaseRecordVersion)
});

export interface StoredPluginRelease extends CachedPluginRelease {
	readonly artifactPath: string;
	readonly manifest: PluginBundleManifest;
	readonly manifestPath: string;
	readonly pluginsRoot: string;
	readonly source: PluginSourceProvenance;
}

export interface PluginStoreApi {
	readonly cacheRoot: string;
	readonly createArtifactStage: (
		releaseVersion: string
	) => Effect.Effect<{ readonly artifactPath: string }, PluginStorageFailure, Scope.Scope>;
	readonly find: (options: {
		readonly expectedArtifactDigest?: string;
		readonly expectedManifestDigest?: string;
		readonly releaseVersion: string;
	}) => Effect.Effect<
		Option.Option<StoredPluginRelease>,
		CorruptCacheEntry | ImmutableVersionConflict
	>;
	readonly lease: (
		release: StoredPluginRelease
	) => Effect.Effect<PluginLease, PluginStorageFailure, Scope.Scope>;
	readonly list: () => Effect.Effect<
		ReadonlyArray<CachedPluginRelease>,
		CorruptCacheEntry | PluginStorageFailure
	>;
	readonly prune: (
		releaseVersion: string
	) => Effect.Effect<void, ActiveLeasePreventsPrune | PluginStorageFailure>;
	readonly publish: (options: {
		readonly artifactPath: string;
		readonly limits: PluginDistributionLimits;
		readonly manifest: PluginBundleManifest;
		readonly manifestBytes: Uint8Array;
		readonly manifestDigest: PluginBundleManifest["artifact"]["sha256"];
		readonly onProgress?: (progress: PluginInstallProgress) => void;
		readonly source: PluginSourceProvenance;
	}) => Effect.Effect<
		StoredPluginRelease,
		| PluginInstallCancelled
		| CorruptCacheEntry
		| ImmutableVersionConflict
		| MalformedOrUnsafeArchive
		| PluginStorageFailure
	>;
	readonly verify: (
		releaseVersion: string
	) => Effect.Effect<StoredPluginRelease, CorruptCacheEntry>;
}

export class PluginStore extends Context.Service<PluginStore, PluginStoreApi>()(
	"@ue-shed/plugin-distribution/PluginStore"
) {}

function digestBytes(bytes: Uint8Array): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function digestFile(path: string): Promise<`sha256:${string}`> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return `sha256:${hash.digest("hex")}`;
}

function storageError(releaseVersion: string, operation: string, cause: unknown) {
	return new PluginStorageFailure({
		message: `${operation} failed: ${String(cause)}`,
		operation,
		recovery: "Check the caller-owned cache permissions and free space, then retry.",
		releaseVersion,
		retrySafe: true
	});
}

function corrupt(releaseVersion: string, cachePath: string, message: string) {
	return new CorruptCacheEntry({
		cachePath,
		message,
		recovery: "Explicitly prune the corrupt release, then reinstall the exact artifact.",
		releaseVersion,
		retrySafe: false
	});
}

function versionPath(cacheRoot: string, releaseVersion: string) {
	return join(cacheRoot, "releases", releaseVersion);
}

function cacheIdentity(releaseVersion: string, manifestDigest: string, artifactDigest: string) {
	return `${releaseVersion}:${manifestDigest.slice(7, 23)}:${artifactDigest.slice(7, 23)}`;
}

async function walkRegularFiles(root: string): Promise<Record<string, `sha256:${string}`>> {
	const result: Record<string, `sha256:${string}`> = {};
	const rootDetails = await lstat(root);
	if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
		throw new Error(`Cache content root is not a safe directory: ${root}`);
	}
	const canonicalRoot = await realpath(root);
	const walk = async (directory: string): Promise<void> => {
		const canonicalDirectory = await realpath(directory);
		const fromRoot = relative(canonicalRoot, canonicalDirectory);
		if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
			throw new Error(`Cache path escapes its release root: ${directory}`);
		}
		const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
			left.name.localeCompare(right.name)
		);
		for (const entry of entries) {
			const path = join(directory, entry.name);
			const relativePath = relative(root, path).replaceAll(sep, "/");
			const details = await lstat(path);
			if (details.isSymbolicLink()) throw new Error(`Cache contains a link: ${relativePath}`);
			if (details.isDirectory()) await walk(path);
			else if (details.isFile()) result[relativePath] = await digestFile(path);
			else throw new Error(`Cache contains an unsupported entry: ${relativePath}`);
		}
	};
	await walk(root);
	return result;
}

async function assertDirectoryWithinCache(cacheRoot: string, directory: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	const details = await lstat(directory);
	if (!details.isDirectory() || details.isSymbolicLink()) {
		throw new Error(`Cache path is not a safe directory: ${directory}`);
	}
	const canonicalRoot = await realpath(cacheRoot);
	const canonicalDirectory = await realpath(directory);
	const fromRoot = relative(canonicalRoot, canonicalDirectory);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		throw new Error(`Cache directory escapes its configured root: ${directory}`);
	}
}

async function assertRegularCacheFile(path: string): Promise<void> {
	const details = await lstat(path);
	if (!details.isFile() || details.isSymbolicLink()) {
		throw new Error(`Cached path is not a regular file: ${path}`);
	}
}

async function readStoredBasic(cacheRoot: string, releaseVersion: string) {
	await assertDirectoryWithinCache(cacheRoot, join(cacheRoot, "releases"));
	const root = versionPath(cacheRoot, releaseVersion);
	const details = await lstat(root);
	if (!details.isDirectory() || details.isSymbolicLink()) {
		throw corrupt(releaseVersion, root, "Cached release is not a regular directory.");
	}
	const canonicalRoot = await realpath(cacheRoot);
	const canonicalRelease = await realpath(root);
	const fromRoot = relative(canonicalRoot, canonicalRelease);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		throw corrupt(releaseVersion, root, "Cached release escapes its configured root.");
	}
	let metadata: StoredMetadata;
	try {
		await assertRegularCacheFile(join(root, metadataFile));
		metadata = Schema.decodeUnknownSync(StoredMetadata)(
			JSON.parse(await readFile(join(root, metadataFile), "utf8"))
		);
	} catch (cause) {
		throw corrupt(
			releaseVersion,
			root,
			`Cached release metadata is malformed: ${String(cause)}`
		);
	}
	if (metadata.releaseVersion !== releaseVersion) {
		throw corrupt(releaseVersion, root, "Cached release metadata has a mismatched version.");
	}
	const manifestPath = join(root, manifestFile);
	const artifactPath = join(root, artifactFile);
	await assertRegularCacheFile(manifestPath).catch((cause) => {
		throw corrupt(releaseVersion, root, `Cached release manifest is unsafe: ${String(cause)}`);
	});
	await assertRegularCacheFile(artifactPath).catch((cause) => {
		throw corrupt(releaseVersion, root, `Cached release artifact is unsafe: ${String(cause)}`);
	});
	const manifestBytes = await readFile(manifestPath);
	if (digestBytes(manifestBytes) !== metadata.manifestDigest) {
		throw corrupt(
			releaseVersion,
			root,
			"Cached release manifest digest does not match metadata."
		);
	}
	const artifactDetails = await stat(artifactPath);
	if (
		artifactDetails.size !== metadata.artifactBytes ||
		(await digestFile(artifactPath)) !== metadata.artifactDigest
	) {
		throw corrupt(releaseVersion, root, "Cached release artifact is truncated or corrupt.");
	}
	const contentRoot = join(root, "content");
	const actualFiles = await walkRegularFiles(contentRoot);
	if (JSON.stringify(actualFiles) !== JSON.stringify(metadata.files)) {
		throw corrupt(
			releaseVersion,
			root,
			"Cached extracted files do not match immutable metadata."
		);
	}
	let manifest: unknown;
	try {
		manifest = Schema.decodeUnknownSync(Schema.Json)(
			JSON.parse(manifestBytes.toString("utf8"))
		);
	} catch (cause) {
		throw corrupt(releaseVersion, root, `Cached manifest JSON is malformed: ${String(cause)}`);
	}
	return { artifactPath, contentRoot, manifest, manifestPath, metadata, root };
}

function storedRelease(
	basic: Awaited<ReturnType<typeof readStoredBasic>>,
	manifest: PluginBundleManifest
): StoredPluginRelease {
	return {
		artifactDigest: basic.metadata.artifactDigest,
		artifactPath: basic.artifactPath,
		cacheIdentity: basic.metadata.cacheIdentity,
		cachePath: basic.root,
		manifest,
		manifestDigest: basic.metadata.manifestDigest,
		manifestPath: basic.manifestPath,
		plugins: manifest.plugins.map((plugin) => plugin.id),
		pluginsRoot: join(basic.contentRoot, "Plugins"),
		releaseIdentity: basic.metadata.releaseIdentity,
		releaseVersion: manifest.releaseVersion,
		source: basic.metadata.source
	};
}

function verifyStored(cacheRoot: string, releaseVersion: string) {
	return Effect.tryPromise({
		try: () => readStoredBasic(cacheRoot, releaseVersion),
		catch: (cause) =>
			cause instanceof CorruptCacheEntry
				? cause
				: corrupt(
						releaseVersion,
						versionPath(cacheRoot, releaseVersion),
						`Cached release cannot be verified: ${String(cause)}`
					)
	}).pipe(
		Effect.flatMap((basic) =>
			validatePluginBundleManifest(basic.manifest, {
				expectedCandidateVersion: releaseVersion
			}).pipe(
				Effect.mapError((cause) =>
					corrupt(
						releaseVersion,
						basic.root,
						`Cached manifest is invalid: ${cause.message}`
					)
				),
				Effect.map((manifest) => storedRelease(basic, manifest))
			)
		)
	);
}

function processIsAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function activeLeaseFiles(cacheRoot: string, releaseVersion: string) {
	const directory = join(cacheRoot, "leases", releaseVersion);
	await assertDirectoryWithinCache(cacheRoot, directory);
	const active: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const path = join(directory, entry.name);
		try {
			const record = Schema.decodeUnknownSync(LeaseRecord)(
				JSON.parse(await readFile(path, "utf8"))
			);
			if (record.releaseVersion === releaseVersion && processIsAlive(record.pid))
				active.push(path);
			else await rm(path, { force: true });
		} catch {
			await rm(path, { force: true });
		}
	}
	return active;
}

async function acquireVersionLock<A>(
	cacheRoot: string,
	releaseVersion: string,
	signal: AbortSignal,
	operation: () => Promise<A>
): Promise<A> {
	const directory = join(cacheRoot, "locks");
	await assertDirectoryWithinCache(cacheRoot, directory);
	const path = join(directory, `${releaseVersion}.lock`);
	let handle;
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
		try {
			handle = await open(path, "wx");
			break;
		} catch (cause) {
			if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST")
				throw cause;
			try {
				const lock = Schema.decodeUnknownSync(
					Schema.Struct({ pid: Schema.Int.check(Schema.isGreaterThan(0)) })
				)(JSON.parse(await readFile(path, "utf8")));
				if (!processIsAlive(lock.pid)) {
					await rm(path, { force: true });
					continue;
				}
			} catch {
				const details = await stat(path).catch(() => undefined);
				if (details !== undefined && Date.now() - details.mtimeMs > 30_000) {
					await rm(path, { force: true });
					continue;
				}
			}
			await new Promise<void>((complete, reject) => {
				const onAbort = () => {
					clearTimeout(timeout);
					reject(new DOMException("Cancelled", "AbortError"));
				};
				const timeout = setTimeout(() => {
					signal.removeEventListener("abort", onAbort);
					complete();
				}, 25);
				signal.addEventListener("abort", onAbort, { once: true });
			});
		}
	}
	if (handle === undefined) throw new Error(`Timed out acquiring cache lock ${path}.`);
	try {
		await handle.writeFile(JSON.stringify({ pid: process.pid }));
		return await operation();
	} finally {
		await handle.close();
		await rm(path, { force: true });
	}
}

export interface PluginStoreLayerOptions {
	readonly cacheRoot: string;
}

export const pluginStoreLayer = (options: PluginStoreLayerOptions): Layer.Layer<PluginStore> =>
	Layer.effect(
		PluginStore,
		Effect.gen(function* () {
			const cacheRoot = resolve(options.cacheRoot);
			if (dirname(cacheRoot) === cacheRoot) {
				return yield* Effect.die(
					new Error("Plugin cache root cannot be a filesystem root.")
				);
			}
			yield* Effect.tryPromise({
				try: async () => {
					await mkdir(cacheRoot, { recursive: true });
					for (const directory of ["releases", "leases", "locks"]) {
						await assertDirectoryWithinCache(cacheRoot, join(cacheRoot, directory));
					}
				},
				catch: (cause) => storageError("unknown", "Create plugin cache root", cause)
			}).pipe(Effect.orDie);

			const verify = Effect.fn("PluginStore.verify")((releaseVersion: string) =>
				verifyStored(cacheRoot, releaseVersion)
			);

			const find = Effect.fn("PluginStore.find")(
				(request: {
					readonly expectedArtifactDigest?: string;
					readonly expectedManifestDigest?: string;
					readonly releaseVersion: string;
				}) =>
					Effect.promise(async () => {
						try {
							await access(versionPath(cacheRoot, request.releaseVersion));
							return true;
						} catch {
							return false;
						}
					}).pipe(
						Effect.flatMap((exists) =>
							!exists
								? Effect.succeed(Option.none<StoredPluginRelease>())
								: verify(request.releaseVersion).pipe(
										Effect.flatMap((release) => {
											const conflict =
												(request.expectedArtifactDigest !== undefined &&
													release.artifactDigest !==
														request.expectedArtifactDigest) ||
												(request.expectedManifestDigest !== undefined &&
													release.manifestDigest !==
														request.expectedManifestDigest);
											return conflict
												? Effect.fail(
														new ImmutableVersionConflict({
															cachePath: release.cachePath,
															message: `Release ${request.releaseVersion} already exists with different immutable digests.`,
															recovery:
																"Use a different exact release version or explicitly prune the existing unleased entry.",
															releaseVersion: request.releaseVersion,
															retrySafe: false
														})
													)
												: Effect.succeed(Option.some(release));
										})
									)
						)
					)
			);

			const createArtifactStage = Effect.fn("PluginStore.createArtifactStage")(
				(releaseVersion: string) =>
					Effect.acquireRelease(
						Effect.tryPromise({
							try: async () => {
								const root = await mkdtemp(join(cacheRoot, ".download-"));
								return { artifactPath: join(root, artifactFile), root };
							},
							catch: (cause) =>
								storageError(releaseVersion, "Create download staging", cause)
						}),
						(stage) =>
							Effect.promise(() => rm(stage.root, { force: true, recursive: true })),
						{ interruptible: true }
					).pipe(Effect.map(({ artifactPath }) => ({ artifactPath })))
			);

			const publish = Effect.fn("PluginStore.publish")((request: {
				readonly artifactPath: string;
				readonly limits: PluginDistributionLimits;
				readonly manifest: PluginBundleManifest;
				readonly manifestBytes: Uint8Array;
				readonly manifestDigest: PluginBundleManifest["artifact"]["sha256"];
				readonly onProgress?: (progress: PluginInstallProgress) => void;
				readonly source: PluginSourceProvenance;
			}) => {
				let completion: Promise<StoredPluginRelease> | undefined;
				const operation = Effect.tryPromise({
					try: (signal) => {
						completion = (async () => {
							const releaseVersion = request.manifest.releaseVersion;
							return await acquireVersionLock(
								cacheRoot,
								releaseVersion,
								signal,
								async () => {
									await assertDirectoryWithinCache(
										cacheRoot,
										join(cacheRoot, "releases")
									);
									const destination = versionPath(cacheRoot, releaseVersion);
									try {
										await access(destination);
										const existing = await readStoredBasic(
											cacheRoot,
											releaseVersion
										);
										if (
											existing.metadata.manifestDigest ===
												request.manifestDigest &&
											existing.metadata.artifactDigest ===
												request.manifest.artifact.sha256
										) {
											return storedRelease(existing, request.manifest);
										}
										throw new ImmutableVersionConflict({
											cachePath: destination,
											message: `Immutable release ${releaseVersion} already exists.`,
											recovery:
												"Verify and reuse it, or explicitly prune it before reacquisition.",
											releaseVersion,
											retrySafe: false
										});
									} catch (cause) {
										if (cause instanceof ImmutableVersionConflict) throw cause;
									}
									const stage = await mkdtemp(join(cacheRoot, ".publish-"));
									try {
										const contentRoot = join(stage, "content");
										const extraction = await extractPluginArchiveToDirectory({
											archivePath: request.artifactPath,
											destination: contentRoot,
											limits: request.limits,
											manifest: request.manifest,
											...(request.onProgress === undefined
												? undefined
												: { onProgress: request.onProgress }),
											signal
										});
										await cp(request.artifactPath, join(stage, artifactFile), {
											force: false
										});
										await writeFile(
											join(stage, manifestFile),
											request.manifestBytes,
											{ flag: "wx" }
										);
										const artifactDetails = await stat(request.artifactPath);
										const artifactDigest = await digestFile(
											request.artifactPath
										);
										const identity = cacheIdentity(
											releaseVersion,
											request.manifestDigest,
											artifactDigest
										);
										const metadata: StoredMetadata = {
											artifactBytes: artifactDetails.size,
											artifactDigest: Sha256Checksum.make(artifactDigest),
											cacheIdentity: identity,
											files: Object.fromEntries(
												Object.entries(extraction.files)
													.sort(([left], [right]) =>
														left.localeCompare(right)
													)
													.map(([path, digest]) => [
														path,
														Sha256Checksum.make(digest)
													])
											),
											manifestDigest: request.manifestDigest,
											releaseIdentity: `${request.manifest.provenance.source.commit}:${releaseVersion}`,
											releaseVersion,
											schemaVersion: 1,
											source: request.source
										};
										await writeFile(
											join(stage, metadataFile),
											`${JSON.stringify(metadata, null, "\t")}\n`,
											{ encoding: "utf8", flag: "wx" }
										);
										request.onProgress?.({
											phase: "publishing",
											releaseVersion
										});
										await mkdir(dirname(destination), { recursive: true });
										await rename(stage, destination);
										const manifest = request.manifest;
										return storedRelease(
											{
												artifactPath: join(destination, artifactFile),
												contentRoot: join(destination, "content"),
												manifest,
												manifestPath: join(destination, manifestFile),
												metadata,
												root: destination
											},
											manifest
										);
									} finally {
										await rm(stage, { force: true, recursive: true });
									}
								}
							);
						})();
						return completion;
					},
					catch: (cause) => {
						if (
							cause instanceof PluginInstallCancelled ||
							cause instanceof CorruptCacheEntry ||
							cause instanceof ImmutableVersionConflict ||
							cause instanceof MalformedOrUnsafeArchive
						) {
							return cause;
						}
						return storageError(
							request.manifest.releaseVersion,
							"Publish plugin release",
							cause
						);
					}
				});
				return operation.pipe(
					Effect.onInterrupt(() =>
						completion === undefined
							? Effect.void
							: Effect.promise(async () => {
									try {
										await completion;
									} catch {
										// The typed operation reports the cancellation; this only awaits cleanup.
									}
								})
					)
				);
			});

			const lease = Effect.fn("PluginStore.lease")((release: StoredPluginRelease) =>
				Effect.acquireRelease(
					Effect.tryPromise({
						try: (signal) =>
							acquireVersionLock(
								cacheRoot,
								release.releaseVersion,
								signal,
								async () => {
									await access(release.cachePath);
									const identity = randomUUID();
									const directory = join(
										cacheRoot,
										"leases",
										release.releaseVersion
									);
									await assertDirectoryWithinCache(cacheRoot, directory);
									const path = join(directory, `${identity}.json`);
									await writeFile(
										path,
										JSON.stringify({
											createdAt: new Date().toISOString(),
											identity,
											pid: process.pid,
											releaseVersion: release.releaseVersion,
											schemaVersion: leaseRecordVersion
										}),
										{ encoding: "utf8", flag: "wx" }
									);
									return {
										lease: PluginLease.make({
											cachePath: release.cachePath,
											identity,
											releaseVersion: release.releaseVersion
										}),
										path
									};
								}
							),
						catch: (cause) =>
							storageError(release.releaseVersion, "Acquire plugin lease", cause)
					}),
					(resource) => Effect.promise(() => rm(resource.path, { force: true })),
					{ interruptible: true }
				).pipe(Effect.map(({ lease }) => lease))
			);

			const prune = Effect.fn("PluginStore.prune")((releaseVersion: string) =>
				Effect.tryPromise({
					try: (signal) =>
						acquireVersionLock(cacheRoot, releaseVersion, signal, async () => {
							await assertDirectoryWithinCache(
								cacheRoot,
								join(cacheRoot, "releases")
							);
							const active = await activeLeaseFiles(cacheRoot, releaseVersion);
							if (active.length > 0) {
								throw new ActiveLeasePreventsPrune({
									activeLeases: active.length,
									message: `Release ${releaseVersion} has ${active.length} active lease(s).`,
									recovery:
										"Release all scoped consumers before pruning this version.",
									releaseVersion,
									retrySafe: true
								});
							}
							await rm(versionPath(cacheRoot, releaseVersion), {
								force: true,
								recursive: true
							});
							await rm(join(cacheRoot, "leases", releaseVersion), {
								force: true,
								recursive: true
							});
						}),
					catch: (cause) =>
						cause instanceof ActiveLeasePreventsPrune
							? cause
							: storageError(releaseVersion, "Prune plugin release", cause)
				})
			);

			const list = Effect.fn("PluginStore.list")(() =>
				Effect.tryPromise({
					try: async () => {
						const releasesRoot = join(cacheRoot, "releases");
						await mkdir(releasesRoot, { recursive: true });
						return (await readdir(releasesRoot, { withFileTypes: true }))
							.filter((entry) => entry.isDirectory())
							.map((entry) => entry.name)
							.sort();
					},
					catch: (cause) => storageError("unknown", "List plugin releases", cause)
				}).pipe(
					Effect.flatMap((versions) =>
						Effect.forEach(versions, verify, { concurrency: 1 }).pipe(
							Effect.map((releases) =>
								releases.map((release) => ({
									artifactDigest: release.artifactDigest,
									cacheIdentity: release.cacheIdentity,
									cachePath: release.cachePath,
									manifestDigest: release.manifestDigest,
									plugins: release.plugins,
									releaseIdentity: release.releaseIdentity,
									releaseVersion: release.releaseVersion
								}))
							)
						)
					)
				)
			);

			return PluginStore.of({
				cacheRoot,
				createArtifactStage,
				find,
				lease,
				list,
				prune,
				publish,
				verify
			});
		})
	);
