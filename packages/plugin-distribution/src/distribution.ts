import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Context, Effect, Fiber, Layer, Option, Schema, Semaphore, type Scope } from "effect";
import {
	PluginInstallCancelled,
	ReleaseUnavailable,
	ArtifactDigestMismatch,
	CompatiblePluginBuildUnavailable,
	IncompatibleUnrealVersion,
	ManifestDigestMismatch,
	OfflineCacheMiss,
	PluginDistributionValidationError,
	UnsupportedManifestVersion,
	type PluginDistributionError
} from "./errors.js";
import {
	PluginBundleManifestValidationError,
	Sha256Checksum,
	resolvePluginBundleDependencies,
	validatePluginBundleManifest,
	type PluginBundleManifest
} from "./manifest.js";
import {
	PluginInstallRequest,
	PluginInstallResult,
	defaultPluginDistributionLimits,
	type CachedPluginRelease,
	type PluginInstallProgress,
	type PluginDistributionLimits
} from "./model.js";
import { PluginReleaseSource } from "./source.js";
import { PluginStore, type StoredPluginRelease } from "./store.js";
import { verifyPluginArtifact } from "./archive.js";
import {
	PluginVariantReference,
	pluginVariantMatches,
	type PluginVariantRequest
} from "./variant.js";

export interface PluginInstallOptions {
	readonly onProgress?: (progress: PluginInstallProgress) => void;
	readonly signal?: AbortSignal;
}

export interface PluginDistributionApi {
	readonly install: (
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This public hostile-input boundary is immediately decoded by PluginInstallRequest.
		request: unknown,
		options?: PluginInstallOptions
	) => Effect.Effect<PluginInstallResult, PluginDistributionError, Scope.Scope>;
	readonly listCached: () => Effect.Effect<
		ReadonlyArray<CachedPluginRelease>,
		PluginDistributionError
	>;
	readonly prune: (
		reference: string | PluginVariantReference
	) => Effect.Effect<void, PluginDistributionError>;
	readonly verifyCached: (
		reference: string | PluginVariantReference
	) => Effect.Effect<CachedPluginRelease, PluginDistributionError>;
}

export class PluginDistribution extends Context.Service<
	PluginDistribution,
	PluginDistributionApi
>()("@ue-shed/plugin-distribution/PluginDistribution") {}

interface EnsuredRelease {
	readonly cacheHit: boolean;
	readonly release: StoredPluginRelease;
}

interface InstallFlight {
	readonly fiber: Fiber.Fiber<EnsuredRelease, PluginDistributionError>;
	waiters: number;
}

function sha256(bytes: Uint8Array) {
	return Sha256Checksum.make(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}

function decodeFailure() {
	return new PluginDistributionValidationError({
		field: "request",
		message: "Plugin install request is invalid.",
		recovery: "Provide one exact SemVer release and between 1 and 64 valid plugin IDs.",
		retrySafe: false
	});
}

function mapManifestError(
	error: PluginBundleManifestValidationError,
	releaseVersion: string,
	unrealVersion?: string
): PluginDistributionError {
	if (error.code === "schema_invalid") {
		return new UnsupportedManifestVersion({
			message: error.message,
			recovery: error.recovery,
			releaseVersion,
			retrySafe: false
		});
	}
	if (error.code === "unsupported_unreal") {
		return new IncompatibleUnrealVersion({
			message: error.message,
			recovery: error.recovery,
			releaseVersion,
			retrySafe: false,
			unrealVersion: unrealVersion ?? "unknown"
		});
	}
	return new PluginDistributionValidationError({
		field: "manifest",
		message: error.message,
		recovery: error.recovery,
		retrySafe: false
	});
}

function validateRequestedManifest(
	manifest: Schema.Json | PluginBundleManifest,
	request: PluginInstallRequest
): Effect.Effect<PluginBundleManifest, PluginDistributionError> {
	const artifact = requestedArtifact(request);
	return validatePluginBundleManifest(manifest, {
		expectedCandidateVersion: request.releaseVersion,
		...(artifact.kind === "source" && artifact.unrealVersion !== undefined
			? { unrealVersion: artifact.unrealVersion }
			: undefined)
	}).pipe(
		Effect.mapError(
			(error): PluginDistributionError =>
				mapManifestError(error, request.releaseVersion, request.unrealVersion)
		),
		Effect.flatMap(
			(validated): Effect.Effect<PluginBundleManifest, PluginDistributionError> => {
				if (pluginVariantMatches(validated, artifact)) return Effect.succeed(validated);
				if (artifact.kind === "compiled") {
					return Effect.fail(
						compatibleBuildUnavailable(
							artifact,
							request.releaseVersion,
							`No compiled plugin artifact exactly matches engine BuildId ${artifact.engineBuildId}.`
						)
					);
				}
				return Effect.fail(
					new PluginDistributionValidationError({
						field: "artifact",
						message:
							"The selected manifest is compiled, but the caller explicitly requested source.",
						recovery:
							"Select a source manifest asset; source requests never use binary artifacts.",
						retrySafe: false
					})
				);
			}
		)
	);
}

function requestedArtifact(request: PluginInstallRequest): PluginVariantRequest {
	if (request.artifact !== undefined) return request.artifact;
	return request.unrealVersion === undefined
		? { kind: "source" }
		: { kind: "source", unrealVersion: request.unrealVersion };
}

function compatibleBuildUnavailable(
	request: Extract<PluginVariantRequest, { readonly kind: "compiled" }>,
	releaseVersion: string,
	message: string
) {
	return new CompatiblePluginBuildUnavailable({
		architecture: request.architecture,
		configuration: request.configuration,
		engineBuildId: request.engineBuildId,
		message,
		platform: request.platform,
		recovery:
			"Build or select a compiled artifact for the exact engine, platform, architecture, target, and configuration.",
		releaseVersion,
		retrySafe: false,
		target: request.target,
		unrealVersion: request.unrealVersion
	});
}

function canonicalRequest(request: PluginInstallRequest) {
	return JSON.stringify({
		artifact: requestedArtifact(request),
		expectedArtifactSha256: request.expectedArtifactSha256,
		expectedManifestSha256: request.expectedManifestSha256,
		networkPolicy: request.networkPolicy ?? "online",
		pluginIds: [...request.pluginIds].sort(),
		releaseVersion: request.releaseVersion,
		unrealVersion: request.unrealVersion
	});
}

function abortEffect(releaseVersion: string, signal: AbortSignal) {
	return Effect.callback<never, PluginInstallCancelled>((resume) => {
		const onAbort = () =>
			resume(
				Effect.fail(
					new PluginInstallCancelled({
						message: "Plugin install was cancelled by the host.",
						recovery: "Retry installing the exact release when the host is ready.",
						releaseVersion,
						retrySafe: true,
						stage: "install"
					})
				)
			);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		return Effect.sync(() => signal.removeEventListener("abort", onAbort));
	});
}

export interface PluginDistributionLayerOptions {
	readonly limits?: Partial<PluginDistributionLimits>;
}

export const pluginDistributionLayer = (
	options: PluginDistributionLayerOptions = {}
): Layer.Layer<PluginDistribution, never, PluginReleaseSource | PluginStore> =>
	Layer.effect(
		PluginDistribution,
		Effect.gen(function* () {
			const source = yield* PluginReleaseSource;
			const store = yield* PluginStore;
			const layerScope = yield* Effect.scope;
			const limits = { ...defaultPluginDistributionLimits, ...options.limits };
			const flightGate = yield* Semaphore.make(1);
			const flights = new Map<string, InstallFlight>();
			const subscribers = new Map<string, Set<(progress: PluginInstallProgress) => void>>();
			const publishProgress = (key: string, progress: PluginInstallProgress) => {
				for (const subscriber of subscribers.get(key) ?? []) subscriber(progress);
			};

			const ensureUncached = Effect.fn("PluginDistribution.ensureUncached")(function* (
				key: string
			) {
				const request = yield* Schema.decodeUnknownEffect(PluginInstallRequest)(
					JSON.parse(key)
				).pipe(Effect.mapError(decodeFailure));
				publishProgress(key, {
					phase: "resolving",
					releaseVersion: request.releaseVersion
				});
				const cached = yield* store.find({
					artifact: requestedArtifact(request),
					releaseVersion: request.releaseVersion,
					...(request.expectedArtifactSha256 === undefined
						? undefined
						: { expectedArtifactDigest: request.expectedArtifactSha256 }),
					...(request.expectedManifestSha256 === undefined
						? undefined
						: { expectedManifestDigest: request.expectedManifestSha256 })
				});
				if (Option.isSome(cached)) {
					yield* validateRequestedManifest(cached.value.manifest, request);
					return { cacheHit: true, release: cached.value };
				}
				if ((request.networkPolicy ?? "online") === "cache-only") {
					return yield* new OfflineCacheMiss({
						message: `Release ${request.releaseVersion} is not present in the verified cache.`,
						recovery:
							"Allow an online install once or pre-populate this caller-owned cache.",
						releaseVersion: request.releaseVersion,
						retrySafe: true
					});
				}
				const artifactRequest = requestedArtifact(request);
				const document = yield* source
					.fetchManifest({
						artifact: artifactRequest,
						limits,
						releaseVersion: request.releaseVersion
					})
					.pipe(
						Effect.mapError((error) =>
							artifactRequest.kind === "compiled" &&
							error instanceof ReleaseUnavailable
								? compatibleBuildUnavailable(
										artifactRequest,
										request.releaseVersion,
										`No compiled plugin manifest is available for engine BuildId ${artifactRequest.engineBuildId}.`
									)
								: error
						)
					);
				const manifestDigest = sha256(document.bytes);
				if (
					request.expectedManifestSha256 !== undefined &&
					request.expectedManifestSha256 !== manifestDigest
				) {
					return yield* new ManifestDigestMismatch({
						actual: manifestDigest,
						expected: request.expectedManifestSha256,
						message: `Manifest digest ${manifestDigest} does not match the pinned digest.`,
						recovery: "Use the exact manifest selected by the host policy.",
						releaseVersion: request.releaseVersion,
						retrySafe: false
					});
				}
				const manifest = yield* validateRequestedManifest(document.manifest, request);
				if (manifest.releaseVersion !== request.releaseVersion) {
					return yield* new PluginDistributionValidationError({
						field: "releaseVersion",
						message: `Manifest release ${manifest.releaseVersion} does not match requested ${request.releaseVersion}.`,
						recovery: "Select the manifest asset for the exact requested release.",
						retrySafe: false
					});
				}
				if (
					request.expectedArtifactSha256 !== undefined &&
					request.expectedArtifactSha256 !== manifest.artifact.sha256
				) {
					return yield* new ArtifactDigestMismatch({
						actual: manifest.artifact.sha256,
						expected: request.expectedArtifactSha256,
						message:
							"Manifest artifact digest does not match the host's pinned digest.",
						recovery:
							"Use the exact release manifest and artifact selected by host policy.",
						releaseVersion: request.releaseVersion,
						retrySafe: false
					});
				}
				return yield* Effect.scoped(
					Effect.gen(function* () {
						const stage = yield* store.createArtifactStage(request.releaseVersion);
						const provenance = yield* source.fetchArtifact({
							destination: stage.artifactPath,
							limits,
							manifest,
							onProgress: (progress) => publishProgress(key, progress)
						});
						yield* verifyPluginArtifact({
							artifactPath: stage.artifactPath,
							expectedBytes: manifest.artifact.bytes,
							expectedDigest: manifest.artifact.sha256,
							limits,
							onProgress: (progress) => publishProgress(key, progress),
							releaseVersion: request.releaseVersion
						});
						const release = yield* store.publish({
							artifactPath: stage.artifactPath,
							limits,
							manifest,
							manifestBytes: document.bytes,
							manifestDigest,
							onProgress: (progress) => publishProgress(key, progress),
							source: provenance
						});
						return { cacheHit: false, release } satisfies EnsuredRelease;
					})
				);
			});

			const joinFlight = Effect.fn("PluginDistribution.joinFlight")(
				(key: string, releaseVersion: string, signal?: AbortSignal) =>
					Effect.acquireUseRelease(
						flightGate.withPermits(1)(
							Effect.gen(function* () {
								const current = flights.get(key);
								if (current !== undefined) {
									current.waiters += 1;
									return current;
								}
								const fiber = yield* ensureUncached(key).pipe(
									Effect.forkIn(layerScope)
								);
								const created: InstallFlight = { fiber, waiters: 1 };
								flights.set(key, created);
								return created;
							})
						),
						(flight) => {
							const joined = Fiber.join(flight.fiber);
							return signal === undefined
								? joined
								: Effect.raceFirst(joined, abortEffect(releaseVersion, signal));
						},
						(flight) =>
							flightGate.withPermits(1)(
								Effect.gen(function* () {
									const current = flights.get(key);
									if (current !== flight) return;
									current.waiters -= 1;
									if (current.waiters > 0) return;
									flights.delete(key);
									yield* Fiber.interrupt(current.fiber);
								})
							)
					)
			);

			const install = Effect.fn("PluginDistribution.install")(function* (
				// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This implementation decodes the public hostile-input boundary immediately below.
				input: unknown,
				installOptions: PluginInstallOptions = {}
			) {
				const request = yield* Schema.decodeUnknownEffect(PluginInstallRequest)(input).pipe(
					Effect.mapError(decodeFailure)
				);
				const key = canonicalRequest(request);
				const subscriber = installOptions.onProgress;
				if (subscriber !== undefined) {
					const current = subscribers.get(key) ?? new Set();
					current.add(subscriber);
					subscribers.set(key, current);
				}
				return yield* Effect.gen(function* () {
					const ensured = yield* joinFlight(
						key,
						request.releaseVersion,
						installOptions.signal
					);
					const resolved = yield* resolvePluginBundleDependencies(
						ensured.release.manifest,
						request.pluginIds
					).pipe(
						Effect.mapError(
							(error) =>
								new PluginDistributionValidationError({
									field: "pluginIds",
									message: error.message,
									recovery: error.recovery,
									retrySafe: false
								})
						)
					);
					const lease = yield* store.lease(ensured.release);
					const descriptorPaths = resolved.plugins.map((plugin) =>
						resolve(ensured.release.pluginsRoot, ...plugin.descriptorPath.split("/"))
					);
					publishProgress(key, {
						cacheHit: ensured.cacheHit,
						phase: "ready",
						releaseVersion: request.releaseVersion
					});
					return PluginInstallResult.make({
						artifactKind: ensured.release.artifactKind,
						artifactDigest: ensured.release.artifactDigest,
						cacheHit: ensured.cacheHit,
						cacheIdentity: ensured.release.cacheIdentity,
						cachePath: ensured.release.cachePath,
						descriptorPaths,
						lease,
						manifestDigest: ensured.release.manifestDigest,
						releaseIdentity: ensured.release.releaseIdentity,
						releaseVersion: ensured.release.releaseVersion,
						resolvedPluginIds: resolved.orderedPluginIds,
						resolvedPlugins: resolved.plugins,
						source: ensured.release.source,
						variantIdentity: ensured.release.variantIdentity
					});
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							if (subscriber === undefined) return;
							const current = subscribers.get(key);
							current?.delete(subscriber);
							if (current?.size === 0) subscribers.delete(key);
						})
					)
				);
			});

			const listCached = Effect.fn("PluginDistribution.listCached")(() => store.list());
			const verifyCached = Effect.fn("PluginDistribution.verifyCached")(
				(reference: string | PluginVariantReference) =>
					store.verify(reference).pipe(
						Effect.map((release) => ({
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
			);
			const prune = Effect.fn("PluginDistribution.prune")(
				(reference: string | PluginVariantReference) => store.prune(reference)
			);
			return PluginDistribution.of({ install, listCached, prune, verifyCached });
		})
	);
