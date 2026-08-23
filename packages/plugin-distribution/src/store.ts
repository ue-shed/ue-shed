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
	PluginDistributionValidationError,
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
import {
	PluginVariantIdentity,
	PluginVariantReference,
	derivePluginVariantIdentity,
	pluginBundleKind,
	pluginVariantMatches,
	type PluginVariantRequest
} from "./variant.js";

const metadataFile = ".ue-shed-distribution.json";
const manifestFile = "plugins.manifest.json";
const artifactFile = "plugins.tar.gz";
const leaseRecordVersion = 1;

const StoredMetadataV1 = Schema.Struct({
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
const StoredMetadataV2 = Schema.Struct({
	artifactBytes: Schema.Int.check(Schema.isGreaterThan(0)),
	artifactDigest: Sha256Checksum,
	artifactKind: Schema.Literals(["source", "compiled"]),
	cacheIdentity: Schema.NonEmptyString,
	files: Schema.Record(Schema.String, Sha256Checksum),
	manifestDigest: Sha256Checksum,
	releaseIdentity: Schema.NonEmptyString,
	releaseVersion: ReleaseVersion,
	schemaVersion: Schema.Literal(2),
	source: PluginSourceProvenance,
	variantIdentity: PluginVariantIdentity
});
const StoredMetadata = Schema.Union([StoredMetadataV1, StoredMetadataV2]);
type StoredMetadata = typeof StoredMetadata.Type;

const LeaseRecordV1 = Schema.Struct({
	createdAt: Schema.String,
	identity: Schema.NonEmptyString,
	pid: Schema.Int.check(Schema.isGreaterThan(0)),
	releaseVersion: ReleaseVersion,
	schemaVersion: Schema.Literal(leaseRecordVersion)
});
const LeaseRecordV2 = Schema.Struct({
	createdAt: Schema.String,
	identity: Schema.NonEmptyString,
	pid: Schema.Int.check(Schema.isGreaterThan(0)),
	releaseVersion: ReleaseVersion,
	schemaVersion: Schema.Literal(2),
	variantIdentity: PluginVariantIdentity
});
const LeaseRecord = Schema.Union([LeaseRecordV1, LeaseRecordV2]);

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
	) => Effect.Effect<
		{ readonly artifactPath: string },
		PluginDistributionValidationError | PluginStorageFailure,
		Scope.Scope
	>;
	readonly find: (options: {
		readonly artifact?: PluginVariantRequest;
		readonly expectedArtifactDigest?: string;
		readonly expectedManifestDigest?: string;
		readonly releaseVersion: string;
	}) => Effect.Effect<
		Option.Option<StoredPluginRelease>,
		| CorruptCacheEntry
		| ImmutableVersionConflict
		| PluginDistributionValidationError
		| PluginStorageFailure
	>;
	readonly lease: (
		release: StoredPluginRelease
	) => Effect.Effect<PluginLease, PluginStorageFailure, Scope.Scope>;
	readonly list: () => Effect.Effect<
		ReadonlyArray<CachedPluginRelease>,
		CorruptCacheEntry | PluginStorageFailure
	>;
	readonly prune: (
		reference: string | PluginVariantReference
	) => Effect.Effect<
		void,
		| ActiveLeasePreventsPrune
		| CorruptCacheEntry
		| PluginDistributionValidationError
		| PluginStorageFailure
	>;
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
		reference: string | PluginVariantReference
	) => Effect.Effect<
		StoredPluginRelease,
		CorruptCacheEntry | PluginDistributionValidationError | PluginStorageFailure
	>;
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

function decodeReleaseVersion(input: string) {
	return Schema.decodeUnknownEffect(ReleaseVersion)(input).pipe(
		Effect.mapError(
			() =>
				new PluginDistributionValidationError({
					field: "releaseVersion",
					message: "Plugin release version must be an exact semantic version.",
					recovery: "Provide an exact SemVer release such as 0.4.0.",
					retrySafe: false
				})
		)
	);
}

function versionPath(cacheRoot: string, releaseVersion: string) {
	return join(cacheRoot, "releases", releaseVersion);
}

function variantsPath(cacheRoot: string, releaseVersion: string) {
	return join(cacheRoot, "variants", releaseVersion);
}

function variantPath(
	cacheRoot: string,
	releaseVersion: string,
	variantIdentity: PluginVariantIdentity
) {
	return join(variantsPath(cacheRoot, releaseVersion), variantIdentity);
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

async function readStoredBasic(cacheRoot: string, releaseVersion: string, root: string) {
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
	if (
		metadata.schemaVersion === 2 &&
		root !== variantPath(cacheRoot, releaseVersion, metadata.variantIdentity)
	) {
		throw corrupt(
			releaseVersion,
			root,
			"Cached variant metadata has a mismatched identity path."
		);
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
	const variantIdentity = derivePluginVariantIdentity({
		manifest,
		manifestDigest: basic.metadata.manifestDigest
	});
	if (
		basic.metadata.schemaVersion === 2 &&
		(basic.metadata.variantIdentity !== variantIdentity ||
			basic.metadata.artifactKind !== pluginBundleKind(manifest))
	) {
		throw corrupt(
			manifest.releaseVersion,
			basic.root,
			"Cached variant identity does not match its immutable manifest and artifact."
		);
	}
	return {
		artifactKind: pluginBundleKind(manifest),
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
		source: basic.metadata.source,
		variantIdentity
	};
}

function verifyStored(cacheRoot: string, releaseVersion: string, root: string) {
	return Effect.tryPromise({
		try: () => readStoredBasic(cacheRoot, releaseVersion, root),
		catch: (cause) =>
			cause instanceof CorruptCacheEntry
				? cause
				: corrupt(
						releaseVersion,
						root,
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

async function storedLocations(cacheRoot: string, releaseVersion: string): Promise<string[]> {
	const locations: string[] = [];
	const legacy = versionPath(cacheRoot, releaseVersion);
	try {
		await access(join(legacy, metadataFile));
		locations.push(legacy);
	} catch {
		// A missing legacy cache is expected for new variant-only stores.
	}
	const root = variantsPath(cacheRoot, releaseVersion);
	try {
		const entries = await readdir(root, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() && /^pv2-[a-f0-9]{64}$/.test(entry.name)) {
				locations.push(join(root, entry.name));
			}
		}
	} catch (cause) {
		if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
	}
	return locations.sort();
}

function allStored(cacheRoot: string, releaseVersion: string) {
	return Effect.tryPromise({
		try: () => storedLocations(cacheRoot, releaseVersion),
		catch: (cause) => storageError(releaseVersion, "List cached plugin variants", cause)
	}).pipe(
		Effect.flatMap((locations) =>
			Effect.forEach(
				locations,
				(location) => verifyStored(cacheRoot, releaseVersion, location),
				{ concurrency: 1 }
			)
		)
	);
}

type ProcessLiveness = "alive" | "dead" | "indeterminate";

function processLiveness(pid: number): ProcessLiveness {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (cause) {
		return cause instanceof Error && "code" in cause && cause.code === "ESRCH"
			? "dead"
			: "indeterminate";
	}
}

async function activeLeaseFiles(
	cacheRoot: string,
	releaseVersion: string,
	variantIdentity: PluginVariantIdentity
) {
	const legacyDirectory = join(cacheRoot, "leases", releaseVersion);
	const variantDirectory = join(legacyDirectory, variantIdentity);
	await assertDirectoryWithinCache(cacheRoot, variantDirectory);
	const directories = [variantDirectory];
	try {
		await access(legacyDirectory);
		directories.push(legacyDirectory);
	} catch {
		// No legacy release-wide leases exist.
	}
	const active: string[] = [];
	for (const directory of directories) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const path = join(directory, entry.name);
			try {
				const record = Schema.decodeUnknownSync(LeaseRecord)(
					JSON.parse(await readFile(path, "utf8"))
				);
				const belongsToVariant =
					record.schemaVersion === 1
						? directory === legacyDirectory
						: record.variantIdentity === variantIdentity;
				if (record.releaseVersion !== releaseVersion || !belongsToVariant) {
					await rm(path, { force: true });
				} else if (processLiveness(record.pid) === "dead") {
					await rm(path, { force: true });
				} else {
					active.push(path);
				}
			} catch {
				await rm(path, { force: true });
			}
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
				if (processLiveness(lock.pid) === "dead") {
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
					for (const directory of ["releases", "variants", "leases", "locks"]) {
						await assertDirectoryWithinCache(cacheRoot, join(cacheRoot, directory));
					}
				},
				catch: (cause) => storageError("unknown", "Create plugin cache root", cause)
			}).pipe(Effect.orDie);

			const resolveReference = Effect.fn("PluginStore.resolveReference")((
				reference: string | PluginVariantReference
			) => {
				if (Schema.is(Schema.String)(reference)) {
					return decodeReleaseVersion(reference).pipe(
						Effect.flatMap((releaseVersion) => allStored(cacheRoot, releaseVersion)),
						Effect.flatMap((releases) => {
							if (releases.length === 1 && releases[0] !== undefined) {
								return Effect.succeed(releases[0]);
							}
							return Effect.fail(
								new PluginDistributionValidationError({
									field: "variantIdentity",
									message:
										releases.length === 0
											? `Release ${reference} has no cached variants.`
											: `Release ${reference} has multiple cached variants.`,
									recovery:
										"Pass the exact releaseVersion and variantIdentity returned by install or list.",
									retrySafe: false
								})
							);
						})
					);
				}
				return Schema.decodeUnknownEffect(PluginVariantReference)(reference, {
					onExcessProperty: "error"
				}).pipe(
					Effect.mapError(
						() =>
							new PluginDistributionValidationError({
								field: "variantIdentity",
								message: "Cached plugin variant reference is invalid.",
								recovery: "Use an exact reference returned by install or list.",
								retrySafe: false
							})
					),
					Effect.flatMap((decoded) =>
						verifyStored(
							cacheRoot,
							decoded.releaseVersion,
							variantPath(cacheRoot, decoded.releaseVersion, decoded.variantIdentity)
						)
					)
				);
			});

			const verify = Effect.fn("PluginStore.verify")(
				(reference: string | PluginVariantReference) => resolveReference(reference)
			);

			const find = Effect.fn("PluginStore.find")(
				(request: {
					readonly artifact?: PluginVariantRequest;
					readonly expectedArtifactDigest?: string;
					readonly expectedManifestDigest?: string;
					readonly releaseVersion: string;
				}) =>
					decodeReleaseVersion(request.releaseVersion).pipe(
						Effect.flatMap((releaseVersion) => allStored(cacheRoot, releaseVersion)),
						Effect.flatMap((releases) => {
							const artifact: PluginVariantRequest = request.artifact ?? {
								kind: "source"
							};
							const compatible = releases.filter((release) =>
								artifact.kind === "source"
									? release.artifactKind === "source"
									: pluginVariantMatches(release.manifest, artifact)
							);
							const selected = compatible
								.filter(
									(release) =>
										(request.expectedArtifactDigest === undefined ||
											release.artifactDigest ===
												request.expectedArtifactDigest) &&
										(request.expectedManifestDigest === undefined ||
											release.manifestDigest ===
												request.expectedManifestDigest)
								)
								.sort((left, right) =>
									left.variantIdentity.localeCompare(right.variantIdentity)
								)[0];
							if (selected !== undefined)
								return Effect.succeed(Option.some(selected));
							if (
								artifact.kind === "source" &&
								compatible[0] !== undefined &&
								(request.expectedArtifactDigest !== undefined ||
									request.expectedManifestDigest !== undefined)
							) {
								const existing = compatible[0];
								return Effect.fail(
									new ImmutableVersionConflict({
										cachePath: existing.cachePath,
										message: `Source release ${request.releaseVersion} already exists with different immutable digests.`,
										recovery:
											"Use its exact pinned digests or explicitly prune this source variant.",
										releaseVersion: request.releaseVersion,
										retrySafe: false
									})
								);
							}
							return Effect.succeed(Option.none<StoredPluginRelease>());
						})
					)
			);

			const createArtifactStage = Effect.fn("PluginStore.createArtifactStage")(
				(releaseVersion: string) =>
					decodeReleaseVersion(releaseVersion).pipe(
						Effect.flatMap((version) =>
							Effect.acquireRelease(
								Effect.tryPromise({
									try: async () => {
										const root = await mkdtemp(join(cacheRoot, ".download-"));
										return { artifactPath: join(root, artifactFile), root };
									},
									catch: (cause) =>
										storageError(version, "Create download staging", cause)
								}),
								(stage) =>
									Effect.promise(() =>
										rm(stage.root, { force: true, recursive: true })
									),
								{ interruptible: true }
							).pipe(Effect.map(({ artifactPath }) => ({ artifactPath })))
						)
					)
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
				const variantIdentity = derivePluginVariantIdentity({
					manifest: request.manifest,
					manifestDigest: request.manifestDigest
				});
				let completion: Promise<StoredPluginRelease> | undefined;
				const operation = Effect.tryPromise({
					try: (signal) => {
						completion = (async () => {
							const releaseVersion = request.manifest.releaseVersion;
							return await acquireVersionLock(
								cacheRoot,
								variantIdentity,
								signal,
								async () => {
									await assertDirectoryWithinCache(
										cacheRoot,
										variantsPath(cacheRoot, releaseVersion)
									);
									const destination = variantPath(
										cacheRoot,
										releaseVersion,
										variantIdentity
									);
									try {
										await access(destination);
										const existing = await readStoredBasic(
											cacheRoot,
											releaseVersion,
											destination
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
										const identity = variantIdentity;
										const metadata: StoredMetadata = {
											artifactBytes: artifactDetails.size,
											artifactDigest: Sha256Checksum.make(artifactDigest),
											artifactKind: pluginBundleKind(request.manifest),
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
											schemaVersion: 2,
											source: request.source,
											variantIdentity
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
								release.variantIdentity,
								signal,
								async () => {
									await access(release.cachePath);
									const identity = randomUUID();
									const directory = join(
										cacheRoot,
										"leases",
										release.releaseVersion,
										release.variantIdentity
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
											schemaVersion: 2,
											variantIdentity: release.variantIdentity
										}),
										{ encoding: "utf8", flag: "wx" }
									);
									return {
										lease: PluginLease.make({
											cachePath: release.cachePath,
											identity,
											releaseVersion: release.releaseVersion,
											variantIdentity: release.variantIdentity
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

			const prune = Effect.fn("PluginStore.prune")(
				(reference: string | PluginVariantReference) =>
					resolveReference(reference).pipe(
						Effect.flatMap((release) =>
							Effect.tryPromise({
								try: (signal) =>
									acquireVersionLock(
										cacheRoot,
										release.variantIdentity,
										signal,
										async () => {
											const active = await activeLeaseFiles(
												cacheRoot,
												release.releaseVersion,
												release.variantIdentity
											);
											if (active.length > 0) {
												throw new ActiveLeasePreventsPrune({
													activeLeases: active.length,
													message: `Variant ${release.variantIdentity} has ${active.length} active lease(s).`,
													recovery:
														"Release all scoped consumers before pruning this exact variant.",
													releaseVersion: release.releaseVersion,
													retrySafe: true
												});
											}
											await rm(release.cachePath, {
												force: true,
												recursive: true
											});
											await rm(
												join(
													cacheRoot,
													"leases",
													release.releaseVersion,
													release.variantIdentity
												),
												{ force: true, recursive: true }
											);
										}
									),
								catch: (cause) =>
									cause instanceof ActiveLeasePreventsPrune
										? cause
										: storageError(
												release.releaseVersion,
												"Prune plugin variant",
												cause
											)
							})
						)
					)
			);

			const list = Effect.fn("PluginStore.list")(() =>
				Effect.tryPromise({
					try: async () => {
						const versions = new Set<string>();
						for (const directory of ["releases", "variants"]) {
							const root = join(cacheRoot, directory);
							await mkdir(root, { recursive: true });
							for (const entry of await readdir(root, { withFileTypes: true })) {
								if (entry.isDirectory()) versions.add(entry.name);
							}
						}
						return [...versions].sort();
					},
					catch: (cause) => storageError("unknown", "List plugin releases", cause)
				}).pipe(
					Effect.flatMap((versions) =>
						Effect.forEach(versions, (version) => allStored(cacheRoot, version), {
							concurrency: 1
						}).pipe(
							Effect.map((releases) =>
								releases.flat().map((release) => ({
									artifactKind: release.artifactKind,
									artifactDigest: release.artifactDigest,
									cacheIdentity: release.cacheIdentity,
									cachePath: release.cachePath,
									manifestDigest: release.manifestDigest,
									plugins: release.plugins,
									releaseIdentity: release.releaseIdentity,
									releaseVersion: release.releaseVersion,
									variantIdentity: release.variantIdentity
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
