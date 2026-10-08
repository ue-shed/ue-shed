import { Context, Effect, Layer, Metric, Result, Schema } from "effect";
import {
	decodeText,
	immutable,
	limitsFor,
	localizationError,
	parseResult,
	validate
} from "./decode.js";
import { LocalizationFileAccess, LocalizationFileAccessLive } from "./file-access.js";
import { parseArchive, parseManifest } from "./json-formats.js";
import { parsePO } from "./po.js";
import { parseLocmeta, parseWordCountCSV } from "./reports.js";
import {
	LocalizationError,
	LocalizationProjectRequest,
	LocalizationEvidenceRequest,
	LocalizationTargetDiscovery,
	LocalizationTargetEvidence,
	LocalizationTargetsReport,
	type FileProvenance,
	type ManifestFileEvidence
} from "./schema.js";
import { discoverLocalizationTargets } from "./targets.js";

export interface LocalizationEvidenceApi {
	readonly discover: (
		request: LocalizationProjectRequest
	) => Effect.Effect<LocalizationTargetDiscovery, LocalizationError>;
	readonly targets: (
		request: LocalizationProjectRequest
	) => Effect.Effect<LocalizationTargetsReport, LocalizationError>;
	readonly read: (
		request: LocalizationEvidenceRequest
	) => Effect.Effect<LocalizationTargetEvidence, LocalizationError>;
}
export class LocalizationEvidence extends Context.Service<
	LocalizationEvidence,
	LocalizationEvidenceApi
>()("@ue-shed/localization/LocalizationEvidence") {}

const fileCount = Metric.counter("localization.evidence.files");
const failureCount = Metric.counter("localization.evidence.failures");
type FailedFileEvidence = Extract<typeof ManifestFileEvidence.Type, { status: "failed" }>;

function boundary<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: S["Encoded"]) {
	const parsed = parseResult(() => validate(schema, input));
	return Result.isFailure(parsed) ? Effect.fail(parsed.failure) : Effect.succeed(parsed.success);
}

export const LocalizationEvidenceLive = Layer.effect(
	LocalizationEvidence,
	Effect.gen(function* () {
		const files = yield* LocalizationFileAccess;
		const discover = Effect.fn("LocalizationEvidence.discover")(function* (
			input: LocalizationProjectRequest
		) {
			const request = yield* boundary(LocalizationProjectRequest, input);
			const limits = limitsFor(request.limits);
			const editor = yield* files
				.read(request.projectRoot, "Config/DefaultEditor.ini", limits)
				.pipe(Effect.result);
			if (Result.isFailure(editor) && editor.failure.code !== "file_missing")
				return yield* Effect.fail(editor.failure);
			const names = yield* files.listConfigs(request.projectRoot, limits);
			const configs: { relativePath: string; text: string }[] = [];
			const diagnostics: LocalizationTargetDiscovery["diagnostics"][number][] = [];
			for (const [configIndex, name] of names.entries()) {
				const file = yield* files
					.read(request.projectRoot, name, limits)
					.pipe(Effect.result);
				if (Result.isFailure(file)) {
					diagnostics.push({ configIndex, error: file.failure });
					continue;
				}
				const decoded = parseResult(() => decodeText(file.success.bytes, limits));
				if (Result.isFailure(decoded)) {
					diagnostics.push({ configIndex, error: decoded.failure });
					continue;
				}
				configs.push({ relativePath: name, text: decoded.success });
			}
			const dashboard = Result.isSuccess(editor)
				? parseResult(() => decodeText(editor.success.bytes, limits))
				: Result.succeed("");
			if (Result.isFailure(dashboard)) return yield* Effect.fail(dashboard.failure);
			const parsed = discoverLocalizationTargets({
				dashboardText: dashboard.success,
				configs,
				limits
			});
			if (Result.isFailure(parsed)) return yield* Effect.fail(parsed.failure);
			yield* Effect.annotateCurrentSpan({
				"localization.targets": parsed.success.targets.length,
				"localization.configs": configs.length,
				"localization.failures": diagnostics.length + parsed.success.diagnostics.length
			});
			return immutable({
				...parsed.success,
				diagnostics: [...parsed.success.diagnostics, ...diagnostics]
			});
		});

		const targets = Effect.fn("LocalizationEvidence.targets")(function* (
			request: LocalizationProjectRequest
		) {
			const discovery = yield* discover(request);
			const limits = limitsFor(request.limits);
			if (
				discovery.targets.reduce(
					(count, target) => count + 1 + target.cultures.length * 3,
					0
				) > limits.maxFiles
			) {
				return yield* Effect.fail(localizationError("limit_exceeded"));
			}
			const presence: LocalizationTargetsReport["presence"][number][] = [];
			for (const target of discovery.targets) {
				const cultures: LocalizationTargetsReport["presence"][number]["cultures"][number][] =
					[];
				for (const culture of target.cultures) {
					const diagnostics: LocalizationError[] = [];
					const exists = Effect.fn("LocalizationEvidence.filePresence")(function* (
						path: string | undefined
					) {
						if (path === undefined) return false;
						const result = yield* files
							.presence(request.projectRoot, path)
							.pipe(Effect.result);
						if (Result.isFailure(result)) {
							diagnostics.push(result.failure);
							return false;
						}
						return result.success;
					});
					cultures.push({
						culture,
						archive: yield* exists(target.outputPaths.archives[culture]),
						po: yield* exists(target.outputPaths.portableObjects[culture]),
						resource: yield* exists(target.outputPaths.resources[culture]),
						diagnostics
					});
				}
				const manifest =
					target.outputPaths.manifest === null
						? Result.succeed(false)
						: yield* files
								.presence(request.projectRoot, target.outputPaths.manifest)
								.pipe(Effect.result);
				if (Result.isFailure(manifest)) return yield* Effect.fail(manifest.failure);
				presence.push({ target: target.name, manifest: manifest.success, cultures });
			}
			return immutable(validate(LocalizationTargetsReport, { ...discovery, presence }));
		});

		const read = Effect.fn("LocalizationEvidence.read")(function* (
			input: LocalizationEvidenceRequest
		) {
			const request = yield* boundary(LocalizationEvidenceRequest, input);
			const limits = limitsFor(request.limits);
			if (request.target.cultures.length * 2 + 3 > limits.maxFiles)
				return yield* Effect.fail(localizationError("limit_exceeded"));
			let readCount = 0;
			let failedCount = 0;
			let entryCount = 0;
			function readEvidence<A>(
				relativePath: string | null | undefined,
				parse: (bytes: Uint8Array) => Result.Result<A, LocalizationError>,
				count: (value: A) => number = () => 0
			) {
				return Effect.gen(function* () {
					const failed = (error: LocalizationError, provenance?: FileProvenance) => {
						failedCount++;
						const evidence: FailedFileEvidence = {
							status: "failed",
							relativePath: relativePath ?? null,
							error
						};
						if (provenance !== undefined) Object.assign(evidence, { provenance });
						return evidence;
					};
					if (relativePath === undefined || relativePath === null)
						return failed(localizationError("file_missing"));
					const file = yield* files
						.read(request.projectRoot, relativePath, limits)
						.pipe(Effect.result);
					if (Result.isFailure(file)) return failed(file.failure);
					readCount++;
					const parsed = parse(file.success.bytes);
					if (Result.isFailure(parsed))
						return failed(parsed.failure, file.success.provenance);
					const entries = count(parsed.success);
					if (entries + entryCount > limits.maxEntries)
						return failed(localizationError("limit_exceeded"), file.success.provenance);
					entryCount += entries;
					return {
						status: "read" as const,
						provenance: file.success.provenance,
						value: parsed.success
					};
				}).pipe(Effect.withSpan("LocalizationEvidence.readFile"));
			}
			const target = request.target;
			const manifest = yield* readEvidence(
				target.outputPaths.manifest,
				(bytes) => parseManifest(bytes, limits),
				(value) => value.entries.length
			);
			const cultures: LocalizationTargetEvidence["cultures"][number][] = [];
			for (const culture of target.cultures) {
				const archive = yield* readEvidence(
					target.outputPaths.archives[culture],
					(bytes) => parseArchive(bytes, limits),
					(value) => value.entries.length
				);
				const po = yield* readEvidence(
					target.outputPaths.portableObjects[culture],
					(bytes) =>
						parsePO(bytes, {
							format: target.poFormat,
							collapseMode: target.collapseMode,
							limits
						}),
					(value) => value.blocks.filter((block) => block.kind === "entry").length
				);
				cultures.push({ culture, archive, po });
			}
			const locmeta = yield* readEvidence(target.outputPaths.locmeta, (bytes) =>
				parseLocmeta(bytes, limits)
			);
			const wordCount = yield* readEvidence(target.outputPaths.wordCount, (bytes) =>
				parseWordCountCSV(bytes, limits)
			);
			yield* Metric.update(fileCount, readCount);
			yield* Metric.update(failureCount, failedCount);
			yield* Effect.annotateCurrentSpan({
				"localization.files": readCount,
				"localization.failures": failedCount,
				"localization.entries": entryCount
			});
			return immutable(
				validate(LocalizationTargetEvidence, {
					schemaVersion: 1,
					target,
					manifest,
					cultures,
					locmeta,
					wordCount
				})
			);
		});
		return LocalizationEvidence.of({ discover, targets, read });
	})
);

export const LocalizationEvidenceNodeLive = LocalizationEvidenceLive.pipe(
	Layer.provide(LocalizationFileAccessLive)
);
export function makeLocalizationEvidenceTestLayer(api: LocalizationEvidenceApi) {
	return Layer.succeed(LocalizationEvidence, LocalizationEvidence.of(api));
}
