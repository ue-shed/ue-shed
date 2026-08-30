import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";
import { Effect, Schema } from "effect";
import {
	PluginInstallCancelled,
	ArtifactDigestMismatch,
	MalformedOrUnsafeArchive,
	PluginStorageFailure
} from "./errors.js";
import {
	EngineBuildId,
	PluginId,
	isCompiledPluginBundleManifest,
	type PluginBundleManifest
} from "./manifest.js";
import type { PluginDistributionLimits, PluginInstallProgress } from "./model.js";

const TAR_BLOCK_BYTES = 512;
const COPY_CHUNK_BYTES = 64 * 1024;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const UnrealModuleManifestEvidence = Schema.Struct({
	BuildId: EngineBuildId,
	Modules: Schema.Record(PluginId, Schema.String)
});
const UnrealPluginDescriptorEvidence = Schema.Struct({
	Modules: Schema.optionalKey(Schema.Array(Schema.Struct({ Name: PluginId })))
});

export interface VerifiedPluginArtifact {
	readonly bytes: number;
	readonly digest: `sha256:${string}`;
	readonly path: string;
}

export interface ArchiveExtractionReport {
	readonly extractedBytes: number;
	readonly fileCount: number;
	readonly files: Readonly<Record<string, `sha256:${string}`>>;
}

interface ByteReader {
	readonly read: (length: number) => Promise<Buffer | undefined>;
}

function abortError(signal: AbortSignal, releaseVersion: string, stage: string) {
	return signal.aborted
		? new PluginInstallCancelled({
				message: `Plugin install was cancelled during ${stage}.`,
				recovery: "Retry installing the exact release when the host is ready.",
				releaseVersion,
				retrySafe: true,
				stage
			})
		: undefined;
}

function storageFailure(releaseVersion: string, operation: string, cause: unknown) {
	return new PluginStorageFailure({
		message: `${operation} failed: ${String(cause)}`,
		operation,
		recovery: "Check cache permissions and free space, then retry.",
		releaseVersion,
		retrySafe: true
	});
}

function archiveFailure(releaseVersion: string, message: string, entry?: string) {
	return new MalformedOrUnsafeArchive({
		...(entry === undefined ? undefined : { entry }),
		message,
		recovery: "Discard the artifact and install it again from a trusted exact release.",
		releaseVersion,
		retrySafe: false
	});
}

function makeByteReader(iterator: AsyncIterator<Buffer>): ByteReader {
	let pending = Buffer.alloc(0);
	let ended = false;
	return {
		read: async (length) => {
			while (pending.byteLength < length && !ended) {
				const next = await iterator.next();
				if (next.done) ended = true;
				else pending = Buffer.concat([pending, next.value]);
			}
			if (pending.byteLength === 0 && ended) return undefined;
			if (pending.byteLength < length) throw new Error("Plugin archive ended unexpectedly.");
			const result = pending.subarray(0, length);
			pending = pending.subarray(length);
			return result;
		}
	};
}

function tarString(block: Buffer, start: number, length: number): string {
	const field = block.subarray(start, start + length);
	const end = field.indexOf(0);
	return field.subarray(0, end === -1 ? field.byteLength : end).toString("utf8");
}

function tarOctal(block: Buffer, start: number, length: number, label: string): number {
	const raw = tarString(block, start, length).trim();
	if (raw === "") return 0;
	if (!/^[0-7]+$/u.test(raw)) throw new Error(`Plugin archive has invalid ${label}.`);
	const value = Number.parseInt(raw, 8);
	if (!Number.isSafeInteger(value)) throw new Error(`Plugin archive ${label} is too large.`);
	return value;
}

function assertTarChecksum(block: Buffer): void {
	const expected = tarOctal(block, 148, 8, "header checksum");
	let actual = 0;
	for (let index = 0; index < block.byteLength; index += 1) {
		actual += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
	}
	if (actual !== expected) throw new Error("Plugin archive has an invalid tar header checksum.");
}

function safeArchivePath(input: string): string {
	if (
		input.length === 0 ||
		[...input].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 0x1f || code === 0x7f;
		})
	) {
		throw new Error("Plugin archive contains an empty or control-character path.");
	}
	const normalized = input.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
	if (
		normalized.length === 0 ||
		normalized.startsWith("/") ||
		/^[A-Za-z]:/u.test(normalized) ||
		isAbsolute(normalized)
	) {
		throw new Error(`Plugin archive contains an absolute path: ${input}`);
	}
	const segments = normalized.split("/");
	for (const segment of segments) {
		if (
			segment === "" ||
			segment === "." ||
			segment === ".." ||
			segment.includes(":") ||
			segment.endsWith(".") ||
			segment.endsWith(" ") ||
			WINDOWS_DEVICE_NAME.test(segment)
		) {
			throw new Error(`Plugin archive contains an unsafe path segment: ${input}`);
		}
	}
	return segments.join("/");
}

function destinationRelativePath(entry: string): string | undefined {
	if (entry === "UEShed" || entry === "UEShed/Plugins") return undefined;
	if (entry === "UEShed/LICENSE") return "LICENSE";
	const prefix = "UEShed/Plugins/";
	if (!entry.startsWith(prefix)) {
		throw new Error(`Plugin archive entry is outside UEShed/Plugins: ${entry}`);
	}
	return `Plugins/${entry.slice(prefix.length)}`;
}

async function assertSafeParent(root: string, destination: string): Promise<void> {
	const parent = dirname(destination);
	await mkdir(parent, { recursive: true });
	const canonicalRoot = await realpath(root);
	const canonicalParent = await realpath(parent);
	const fromRoot = relative(canonicalRoot, canonicalParent);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		throw new Error(`Plugin archive path escapes the extraction root: ${destination}`);
	}
	let cursor = canonicalRoot;
	for (const segment of fromRoot.split(sep).filter(Boolean)) {
		cursor = resolve(cursor, segment);
		const details = await lstat(cursor);
		if (!details.isDirectory() || details.isSymbolicLink()) {
			throw new Error(`Plugin archive parent is not a safe directory: ${cursor}`);
		}
	}
}

/** Hashes an artifact as a cancellable bounded stream before any extraction. */
export const verifyPluginArtifact = (options: {
	readonly artifactPath: string;
	readonly expectedBytes: number;
	readonly expectedDigest: string;
	readonly limits: PluginDistributionLimits;
	readonly releaseVersion: PluginBundleManifest["releaseVersion"];
	readonly signal?: AbortSignal;
	readonly onProgress?: (event: PluginInstallProgress) => void;
}): Effect.Effect<
	VerifiedPluginArtifact,
	PluginInstallCancelled | ArtifactDigestMismatch | PluginStorageFailure
> =>
	Effect.tryPromise({
		try: async (runtimeSignal) => {
			const signal =
				options.signal === undefined
					? runtimeSignal
					: AbortSignal.any([runtimeSignal, options.signal]);
			const details = await stat(options.artifactPath);
			if (!details.isFile()) throw new Error("Artifact is not a regular file.");
			if (
				details.size !== options.expectedBytes ||
				details.size > options.limits.maximumArtifactBytes
			) {
				throw new ArtifactDigestMismatch({
					actual: `bytes:${details.size}`,
					expected: `bytes:${options.expectedBytes}`,
					message: `Artifact size ${details.size} does not match ${options.expectedBytes}.`,
					recovery: "Discard the truncated or oversized artifact and download it again.",
					releaseVersion: options.releaseVersion,
					retrySafe: true
				});
			}
			const hash = createHash("sha256");
			let completed = 0;
			for await (const chunk of createReadStream(options.artifactPath, {
				highWaterMark: COPY_CHUNK_BYTES,
				signal
			})) {
				const cancelled = abortError(signal, options.releaseVersion, "verification");
				if (cancelled !== undefined) throw cancelled;
				hash.update(chunk);
				completed += chunk.byteLength;
				options.onProgress?.({
					bytesCompleted: completed,
					bytesTotal: details.size,
					phase: "verifying",
					releaseVersion: options.releaseVersion
				});
			}
			const digest = `sha256:${hash.digest("hex")}` as const;
			if (digest !== options.expectedDigest) {
				throw new ArtifactDigestMismatch({
					actual: digest,
					expected: options.expectedDigest,
					message: `Artifact digest ${digest} does not match ${options.expectedDigest}.`,
					recovery: "Discard the artifact and download the exact release asset again.",
					releaseVersion: options.releaseVersion,
					retrySafe: true
				});
			}
			return { bytes: details.size, digest, path: resolve(options.artifactPath) };
		},
		catch: (cause) => {
			if (
				cause instanceof PluginInstallCancelled ||
				cause instanceof ArtifactDigestMismatch
			) {
				return cause;
			}
			return (
				(options.signal === undefined
					? undefined
					: abortError(options.signal, options.releaseVersion, "verification")) ??
				storageFailure(options.releaseVersion, "Verify plugin artifact", cause)
			);
		}
	});

export interface ExtractPluginArchiveOptions {
	readonly archivePath: string;
	readonly destination: string;
	readonly limits: PluginDistributionLimits;
	readonly manifest: PluginBundleManifest;
	readonly signal: AbortSignal;
	readonly onProgress?: (event: PluginInstallProgress) => void;
}

/** Internal promise adapter used by the filesystem store inside its existing Effect boundary. */
export async function extractPluginArchiveToDirectory(
	options: ExtractPluginArchiveOptions
): Promise<ArchiveExtractionReport> {
	try {
		const initialCancellation = abortError(
			options.signal,
			options.manifest.releaseVersion,
			"extraction"
		);
		if (initialCancellation !== undefined) throw initialCancellation;
		await mkdir(options.destination);
		const gunzip = createReadStream(options.archivePath, { signal: options.signal }).pipe(
			createGunzip()
		);
		// SAFETY: no text encoding is configured, so Node's readable stream yields Buffer chunks.
		const iterator = gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
		const reader = makeByteReader(iterator);
		const seen = new Set<string>();
		const files: Record<string, `sha256:${string}`> = {};
		let extractedBytes = 0;
		let fileCount = 0;
		let sawEnd = false;

		for (;;) {
			const cancelled = abortError(
				options.signal,
				options.manifest.releaseVersion,
				"extraction"
			);
			if (cancelled !== undefined) throw cancelled;
			const header = await reader.read(TAR_BLOCK_BYTES);
			if (header === undefined) break;
			if (header.every((byte) => byte === 0)) {
				sawEnd = true;
				break;
			}
			assertTarChecksum(header);
			const name = tarString(header, 0, 100);
			const prefix = tarString(header, 345, 155);
			const archivePath = safeArchivePath(prefix.length > 0 ? `${prefix}/${name}` : name);
			const type = String.fromCharCode(header[156] ?? 0);
			const size = tarOctal(header, 124, 12, "entry size");
			const caseKey = archivePath.toLocaleLowerCase("en-US");
			if (seen.has(caseKey)) throw new Error(`Plugin archive repeats path ${archivePath}.`);
			seen.add(caseKey);
			fileCount += 1;
			if (fileCount > options.limits.maximumFileCount) {
				throw new Error("Plugin archive exceeds the configured file-count limit.");
			}
			if (size > options.limits.maximumFileBytes) {
				throw new Error(`Plugin archive entry exceeds the file-size limit: ${archivePath}`);
			}
			extractedBytes += size;
			if (extractedBytes > options.limits.maximumExtractedBytes) {
				throw new Error("Plugin archive exceeds the configured extracted-byte limit.");
			}
			if (type !== "\0" && type !== "0" && type !== "5") {
				throw new Error(
					`Plugin archive contains unsupported entry type ${type}: ${archivePath}`
				);
			}
			const relativePath = destinationRelativePath(archivePath);
			if (type === "5") {
				if (size !== 0)
					throw new Error(`Plugin archive directory has payload: ${archivePath}`);
				if (relativePath !== undefined) {
					const destination = resolve(options.destination, relativePath);
					await assertSafeParent(options.destination, destination);
					await mkdir(destination);
				}
			} else {
				if (relativePath === undefined) {
					throw new Error(`Plugin archive root entry is not a directory: ${archivePath}`);
				}
				const destination = resolve(options.destination, relativePath);
				await assertSafeParent(options.destination, destination);
				const handle = await open(destination, "wx");
				const hash = createHash("sha256");
				let remaining = size;
				try {
					while (remaining > 0) {
						const chunk = await reader.read(Math.min(remaining, COPY_CHUNK_BYTES));
						if (chunk === undefined)
							throw new Error("Plugin archive file is truncated.");
						const currentCancellation = abortError(
							options.signal,
							options.manifest.releaseVersion,
							"extraction"
						);
						if (currentCancellation !== undefined) throw currentCancellation;
						await handle.writeFile(chunk, { signal: options.signal });
						hash.update(chunk);
						remaining -= chunk.byteLength;
						options.onProgress?.({
							bytesCompleted: extractedBytes - remaining,
							bytesTotal: options.limits.maximumExtractedBytes,
							filesCompleted: Object.keys(files).length,
							phase: "extracting",
							releaseVersion: options.manifest.releaseVersion
						});
					}
				} finally {
					await handle.close();
				}
				files[relativePath.replaceAll("\\", "/")] = `sha256:${hash.digest("hex")}`;
			}
			const padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
			if (padding > 0 && (await reader.read(padding)) === undefined) {
				throw new Error("Plugin archive padding is truncated.");
			}
		}
		if (!sawEnd) throw new Error("Plugin archive has no tar end marker.");
		for (const plugin of options.manifest.plugins) {
			const descriptor = `Plugins/${plugin.descriptorPath}`;
			if (files[descriptor] === undefined) {
				throw new Error(`Plugin archive is missing descriptor ${plugin.descriptorPath}.`);
			}
		}
		if (isCompiledPluginBundleManifest(options.manifest)) {
			const platform = options.manifest.compatibility.platform;
			const binaryExtension =
				platform === "Win64" ? ".dll" : platform === "Mac" ? ".dylib" : ".so";
			for (const plugin of options.manifest.plugins) {
				const descriptorPath = `Plugins/${plugin.descriptorPath}`;
				const descriptor = Schema.decodeUnknownSync(UnrealPluginDescriptorEvidence)(
					JSON.parse(await readFile(resolve(options.destination, descriptorPath), "utf8"))
				);
				const declaredModules = new Set(
					(descriptor.Modules ?? []).map((module) => module.Name)
				);
				const evidencedModules = new Set<string>();
				const binaryRoot = `Plugins/${plugin.directory}/Binaries/${platform}/`;
				const paths = Object.keys(files).filter((path) => path.startsWith(binaryRoot));
				const modulePaths = paths.filter((path) => path.endsWith(".modules"));
				if (modulePaths.length === 0) {
					throw new Error(`Compiled plugin ${plugin.id} is missing .modules evidence.`);
				}
				if (!paths.some((path) => path.toLowerCase().endsWith(binaryExtension))) {
					throw new Error(
						`Compiled plugin ${plugin.id} is missing a ${binaryExtension} binary.`
					);
				}
				for (const modulePath of modulePaths) {
					const evidence = Schema.decodeUnknownSync(UnrealModuleManifestEvidence)(
						JSON.parse(await readFile(resolve(options.destination, modulePath), "utf8"))
					);
					if (evidence.BuildId !== options.manifest.compatibility.engineBuildId) {
						throw new Error(
							`.modules BuildId ${evidence.BuildId} does not match ${options.manifest.compatibility.engineBuildId}: ${modulePath}`
						);
					}
					for (const moduleId of Object.keys(evidence.Modules)) {
						evidencedModules.add(moduleId);
					}
					const products = Object.values(evidence.Modules);
					if (products.length === 0) {
						throw new Error(
							`Compiled plugin ${plugin.id} has empty .modules evidence.`
						);
					}
					for (const product of products) {
						const normalizedProduct = safeArchivePath(product);
						const productPath = `${binaryRoot}${normalizedProduct}`;
						if (
							!normalizedProduct.toLowerCase().endsWith(binaryExtension) ||
							files[productPath] === undefined
						) {
							throw new Error(
								`.modules product ${product} is not an extracted ${binaryExtension} binary beneath ${binaryRoot}: ${modulePath}`
							);
						}
					}
				}
				const missingModules = [...declaredModules].filter(
					(moduleId) => !evidencedModules.has(moduleId)
				);
				if (missingModules.length > 0) {
					throw new Error(
						`Compiled plugin ${plugin.id} has no .modules evidence for descriptor module(s): ${missingModules.join(", ")}.`
					);
				}
			}
			if (options.manifest.schemaVersion === 3) {
				const attested = new Map(
					options.manifest.nativeFiles.map((file) => [file.path, file.sha256])
				);
				const nativePaths = Object.keys(files).filter((path) =>
					/\.(?:dll|dylib|modules|pdb|so|uplugin)$/iu.test(path)
				);
				if (nativePaths.length !== attested.size) {
					throw new Error("Compiled archive native-file attestations are incomplete.");
				}
				for (const path of nativePaths) {
					if (attested.get(path) !== files[path]) {
						throw new Error(
							`Compiled archive digest does not match native-file attestation: ${path}`
						);
					}
				}
			}
		}
		return { extractedBytes, fileCount, files };
	} catch (cause) {
		if (cause instanceof PluginInstallCancelled) throw cause;
		throw (
			abortError(options.signal, options.manifest.releaseVersion, "extraction") ??
			archiveFailure(
				options.manifest.releaseVersion,
				cause instanceof Error ? cause.message : String(cause)
			)
		);
	}
}

/** Extracts the strict ustar subset emitted by UE Shed without following archive links. */
export const extractPluginArchive = (
	options: ExtractPluginArchiveOptions
): Effect.Effect<ArchiveExtractionReport, PluginInstallCancelled | MalformedOrUnsafeArchive> =>
	Effect.tryPromise({
		try: () => extractPluginArchiveToDirectory(options),
		catch: (cause) =>
			cause instanceof PluginInstallCancelled || cause instanceof MalformedOrUnsafeArchive
				? cause
				: archiveFailure(
						options.manifest.releaseVersion,
						cause instanceof Error ? cause.message : String(cause)
					)
	});
