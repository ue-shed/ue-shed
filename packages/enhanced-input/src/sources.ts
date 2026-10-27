import { ErrorNextStep } from "@ue-shed/protocol/errors";
// Effectful evidence sources for the analysis: saved config through Config Explorer, a host
// document, Blueprint packages and platform data classes through the asset reader. Each is its own
// function with its requirement in the type, so a host provides only the services it uses.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
	ConfigExplorer,
	ConfigFamily,
	ConfigKey,
	ConfigPlatform,
	ConfigSection,
	type ConfigExplanation,
	type ConfigExplorerError
} from "@ue-shed/config-explorer";
import { AssetReader, isHeaderScanEntry, type AssetReaderError } from "@ue-shed/unreal-assets";
import { blueprintReferences } from "@ue-shed/unreal-assets/saved-review";
import { Context, Effect, Layer, Schema } from "effect";
import {
	coActivationFromDefaultContexts,
	CoActivationDocument,
	coActivationFromDocument,
	contextIdentity,
	parseDefaultContextSettings,
	type CoActivationSet,
	type CoActivationSourceStatus
} from "./coactivation.js";
import {
	InputDeviceSetsDocument,
	parsePlatformInputData,
	platformDataRedirectsFromInspection,
	platformSettingsSection,
	type InputContextRedirect,
	type InputPlatformView
} from "./platforms.js";
import type { EnhancedInputReport } from "./schema.js";
import {
	blueprintCoverageComplete,
	blueprintInputActionUses,
	blueprintInputCandidatePaths,
	inputActionPackageNames,
	type BlueprintInputActionUse,
	type BlueprintPartialRead,
	type BlueprintUseCoverage
} from "./usage.js";

export class EnhancedInputAnalysisError extends Schema.TaggedError<EnhancedInputAnalysisError>()(
	"EnhancedInputAnalysisError",
	{
		code: Schema.Literals([
			"invalid_co_activation_document",
			"invalid_device_sets_document",
			"project_files_unreadable",
			"reader_failed"
		]),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		nextStep: ErrorNextStep,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

/** The section and key the project's default contexts live under, in the `Input` family. */
export const ENHANCED_INPUT_DEVELOPER_SETTINGS_SECTION =
	"/Script/EnhancedInput.EnhancedInputDeveloperSettings";
export const DEFAULT_MAPPING_CONTEXTS_KEY = "DefaultMappingContexts";
export const PLATFORM_INPUT_DATA_KEY = "InputData";
const INPUT_CONFIG_FAMILY = "Input";

function effectiveValues(explanation: ConfigExplanation): readonly string[] {
	switch (explanation.effectiveValue.kind) {
		case "array":
			return explanation.effectiveValue.values;
		case "scalar":
			return [explanation.effectiveValue.value];
		default:
			return [];
	}
}

function explainInput(options: {
	readonly project: string;
	readonly platform: string;
	readonly section: string;
	readonly key: string;
	readonly engineRoot?: string;
}) {
	return Effect.flatMap(ConfigExplorer, (explorer) =>
		explorer.explain({
			project: options.project,
			platform: ConfigPlatform.make(options.platform),
			section: ConfigSection.make(options.section),
			key: ConfigKey.make(options.key),
			family: ConfigFamily.make(INPUT_CONFIG_FAMILY),
			...(options.engineRoot === undefined ? undefined : { engineRoot: options.engineRoot })
		})
	);
}

export interface CoActivationResolution {
	readonly sets: readonly CoActivationSet[];
	readonly status: CoActivationSourceStatus;
}

/**
 * Reads the project's `DefaultMappingContexts` for one platform through Config Explorer. A config
 * failure, such as no discoverable engine, is reported as an unavailable source, not a failure.
 */
export const resolveDefaultContextsFromConfig = Effect.fn(
	"EnhancedInput.resolveDefaultContextsFromConfig"
)(function* (options: {
	readonly project: string;
	readonly platform: string;
	readonly engineRoot?: string;
}) {
	const origin = `[${ENHANCED_INPUT_DEVELOPER_SETTINGS_SECTION}] ${DEFAULT_MAPPING_CONTEXTS_KEY}`;
	return yield* explainInput({
		...options,
		section: ENHANCED_INPUT_DEVELOPER_SETTINGS_SECTION,
		key: DEFAULT_MAPPING_CONTEXTS_KEY
	}).pipe(
		Effect.map((explanation): CoActivationResolution => {
			const settings = parseDefaultContextSettings(effectiveValues(explanation));
			const sets = coActivationFromDefaultContexts(settings, {
				origin,
				platform: options.platform
			});
			return sets.length === 0
				? {
						sets,
						status: {
							source: "project_default_contexts",
							status: "absent",
							detail: `${origin} lists no context added at startup on ${options.platform}.`
						}
					}
				: {
						sets,
						status: {
							source: "project_default_contexts",
							status: "resolved",
							sets: sets.length,
							detail: `${origin} on ${options.platform}, ${explanation.status} saved-source coverage.`
						}
					};
		}),
		Effect.catchTag("ConfigExplorerError", (error: ConfigExplorerError) =>
			Effect.succeed<CoActivationResolution>({
				sets: [],
				status: {
					source: "project_default_contexts",
					status: "unavailable",
					detail: error.message,
					recovery: error.recovery
				}
			})
		)
	);
});

/** Documents stay small; a co-activation or device list is never megabytes. */
const MAXIMUM_DOCUMENT_BYTES = 1024 * 1024;

/** Reads one bounded JSON document and decodes it. A bad document is the caller's input error. */
function readJsonDocument<S extends Schema.Decoder<unknown>>(
	path: string,
	schema: S,
	options: {
		readonly code: "invalid_co_activation_document" | "invalid_device_sets_document";
		readonly label: string;
		readonly example: string;
	}
) {
	const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
	return Effect.tryPromise({
		try: async () => {
			const info = await stat(path);
			if (info.size > MAXIMUM_DOCUMENT_BYTES) throw new Error("Document exceeds 1 MiB.");
			return await readFile(path, "utf8");
		},
		catch: (cause) =>
			new EnhancedInputAnalysisError({
				code: options.code,
				message: `Could not read the ${options.label} ${path}.`,
				recovery: "Choose a readable JSON document smaller than 1 MiB.",
				retrySafe: true,
				nextStep: "fix_input",
				cause
			})
	}).pipe(
		Effect.flatMap((text) =>
			decode(text).pipe(
				Effect.mapError(
					(cause) =>
						new EnhancedInputAnalysisError({
							code: options.code,
							message: `The ${options.label} ${path} is not schema 1 JSON: ${cause.message}`,
							recovery: `Use ${options.example}.`,
							retrySafe: false,
							nextStep: "fix_input",
							cause
						})
				)
			)
		)
	);
}

/** Reads and validates a host co-activation document. */
export const readCoActivationDocument = Effect.fn("EnhancedInput.readCoActivationDocument")(
	function* (path: string) {
		const document = yield* readJsonDocument(path, CoActivationDocument, {
			code: "invalid_co_activation_document",
			label: "co-activation document",
			example: '{ "schemaVersion": 1, "kind": "enhanced_input_co_activation", "sets": [...] }'
		});
		const sets = coActivationFromDocument(document, path);
		return {
			sets,
			status: {
				source: "host_document",
				status: "resolved",
				sets: sets.length,
				detail: path
			}
		} satisfies CoActivationResolution;
	}
);

/** Reads and validates a host device-sets document, which replaces the default device sets. */
export const readInputDeviceSetsDocument = Effect.fn("EnhancedInput.readInputDeviceSetsDocument")(
	function* (path: string) {
		const document = yield* readJsonDocument(path, InputDeviceSetsDocument, {
			code: "invalid_device_sets_document",
			label: "device sets document",
			example: '{ "schemaVersion": 1, "kind": "enhanced_input_device_sets", "sets": [...] }'
		});
		return document.sets;
	}
);

const MissingPath = Schema.Struct({ code: Schema.Literals(["ENOENT", "ENOTDIR"]) });
const isMissingPath = Schema.is(MissingPath);

function readerFailure(error: AssetReaderError): EnhancedInputAnalysisError {
	return new EnhancedInputAnalysisError({
		code: "reader_failed",
		message: error.message,
		recovery: error.recovery,
		retrySafe: error.retrySafe,
		nextStep: error.nextStep,
		cause: error
	});
}

export interface BlueprintUseScanOptions {
	readonly projectRoot: string;
	/** The decode bound. Matches past it are counted as skipped, never silently dropped. */
	readonly maximumBlueprints: number;
	readonly paths?: readonly string[];
	readonly concurrency?: number;
}

export interface BlueprintUseScan {
	readonly uses: readonly BlueprintInputActionUse[];
	readonly coverage: BlueprintUseCoverage;
}

/**
 * Finds Blueprint uses of the report's actions. One header scan lists Blueprint packages and probes
 * their name maps for the action package names; only matches are decoded, up to the bound.
 */
export const scanBlueprintInputActionUses = Effect.fn("EnhancedInput.scanBlueprintInputActionUses")(
	function* (report: EnhancedInputReport, options: BlueprintUseScanOptions) {
		const reader = yield* AssetReader;
		const actions = new Set(report.actions.map((action) => String(action.objectPath)));
		const names = inputActionPackageNames(report);
		if (names.length === 0) {
			return {
				uses: [],
				coverage: {
					status: "scanned",
					complete: true,
					blueprints: 0,
					matched: 0,
					decoded: 0,
					skipped: 0,
					failed: [],
					partial: [],
					headerFailures: []
				}
			} satisfies BlueprintUseScan;
		}
		const index = yield* reader
			.scanProject({
				depth: "header",
				projectRoot: options.projectRoot,
				classNameSuffixes: ["Blueprint"],
				names,
				...(options.paths === undefined ? undefined : { paths: options.paths })
			})
			.pipe(Effect.mapError(readerFailure));
		const selection = blueprintInputCandidatePaths(index, {
			maximumBlueprints: options.maximumBlueprints,
			nameProbe: true
		});
		const relativePath = (path: string) => relative(options.projectRoot, path) || path;
		const reads = yield* Effect.forEach(
			selection.paths,
			(path) =>
				reader.readBlueprint(resolve(options.projectRoot, path)).pipe(
					Effect.map((read) => {
						const gaps = read.blueprint.coverage_gaps;
						// A partial read keeps the uses it found and says what it could not see.
						const partial: BlueprintPartialRead | undefined =
							read.outcome === "partial" || gaps.length > 0
								? {
										path: relativePath(path),
										blueprint: read.blueprint.object_path,
										diagnostics: read.diagnostics.map((diagnostic) => ({
											code: diagnostic.code,
											message: diagnostic.message
										})),
										coverageGaps: gaps.map((gap) => ({
											objectPath: gap.object_path,
											reason: gap.reason,
											detail: gap.detail
										}))
									}
								: undefined;
						return {
							status: "read" as const,
							partial,
							uses: blueprintInputActionUses(
								read.blueprint.object_path,
								blueprintReferences(read),
								actions
							)
						};
					}),
					Effect.catchTag("AssetReaderError", (error) =>
						Effect.succeed({ status: "failed" as const, path, message: error.message })
					)
				),
			{ concurrency: Math.max(1, options.concurrency ?? 4) }
		);
		const coverage = {
			blueprints: selection.blueprints,
			matched: selection.matched,
			decoded: reads.filter((read) => read.status === "read").length,
			skipped: selection.skipped,
			failed: reads.flatMap((read) =>
				read.status === "failed"
					? [{ path: relativePath(read.path), message: read.message }]
					: []
			),
			partial: reads.flatMap((read) =>
				read.status === "read" && read.partial !== undefined ? [read.partial] : []
			),
			headerFailures: selection.headerFailures.map((failure) => ({
				path: relativePath(failure.path),
				message: failure.message
			}))
		};
		return {
			uses: reads.flatMap((read) => (read.status === "read" ? read.uses : [])),
			coverage: {
				status: "scanned",
				complete: blueprintCoverageComplete(coverage),
				...coverage
			}
		} satisfies BlueprintUseScan;
	}
);

/**
 * Platforms with a project platform `Input` config, the files where the editor saves per-platform
 * Enhanced Input settings: `Config/<Platform>/<Platform>Input.ini` and
 * `Platforms/<Platform>/Config/<Platform>Input.ini`.
 */
export const discoverInputPlatforms = Effect.fn("EnhancedInput.discoverInputPlatforms")(function* (
	projectRoot: string
) {
	const unreadable = (path: string, cause: unknown) =>
		new EnhancedInputAnalysisError({
			code: "project_files_unreadable",
			message: `Could not read ${path}.`,
			recovery: "Check that the project directory is readable, then retry.",
			retrySafe: true,
			nextStep: "retry",
			cause
		});
	// A missing directory or file is an answer ("no platform config here"); anything else fails.
	const list = (path: string) =>
		Effect.tryPromise({
			try: async () => {
				try {
					const entries = await readdir(path, { withFileTypes: true });
					return entries
						.filter((entry) => entry.isDirectory())
						.map((entry) => entry.name);
				} catch (cause) {
					if (isMissingPath(cause)) return [];
					throw cause;
				}
			},
			catch: (cause) => unreadable(path, cause)
		});
	const exists = (path: string) =>
		Effect.tryPromise({
			try: async () => {
				try {
					return (await stat(path)).isFile();
				} catch (cause) {
					if (isMissingPath(cause)) return false;
					throw cause;
				}
			},
			catch: (cause) => unreadable(path, cause)
		});
	const candidates = [
		...(yield* list(join(projectRoot, "Config"))).map((platform) => ({
			platform,
			file: join(projectRoot, "Config", platform, `${platform}Input.ini`)
		})),
		...(yield* list(join(projectRoot, "Platforms"))).map((platform) => ({
			platform,
			file: join(projectRoot, "Platforms", platform, "Config", `${platform}Input.ini`)
		}))
	];
	const found = yield* Effect.filter(candidates, (candidate) => exists(candidate.file));
	return [...new Set(found.map((candidate) => candidate.platform))].sort((left, right) =>
		left.localeCompare(right)
	);
});

/**
 * One view per platform: the platform data classes its `EnhancedInputPlatformSettings` lists and
 * the redirects their class defaults save. One header scan finds the classes' packages; each costs
 * one package decode.
 */
export const resolvePlatformViews = Effect.fn("EnhancedInput.resolvePlatformViews")(
	function* (options: {
		readonly project: string;
		readonly projectRoot: string;
		readonly platforms: readonly string[];
		readonly engineRoot?: string;
	}) {
		const reader = yield* AssetReader;
		const listed = yield* Effect.forEach(options.platforms, (platform) =>
			explainInput({
				project: options.project,
				platform,
				section: platformSettingsSection(platform),
				key: PLATFORM_INPUT_DATA_KEY,
				...(options.engineRoot === undefined
					? undefined
					: { engineRoot: options.engineRoot })
			}).pipe(
				Effect.map((explanation) => ({
					platform,
					status: "read" as const,
					inputData: parsePlatformInputData(effectiveValues(explanation))
				})),
				Effect.catchTag("ConfigExplorerError", (error: ConfigExplorerError) =>
					Effect.succeed({
						platform,
						status: "unavailable" as const,
						message: `${error.message} ${error.recovery}`
					})
				)
			)
		);
		const packages = new Set(
			listed.flatMap((entry) =>
				entry.status === "read" ? entry.inputData.map((path) => contextIdentity(path)) : []
			)
		);
		const files = new Map<string, string>();
		let inventoryFailure: string | undefined;
		if (packages.size > 0) {
			const scan = yield* Effect.result(
				reader.scanProject({
					depth: "header",
					projectRoot: options.projectRoot,
					classNameSuffixes: ["Blueprint"]
				})
			);
			if (scan._tag === "Failure") inventoryFailure = scan.failure.message;
			else {
				for (const entry of scan.success.assets.filter(isHeaderScanEntry)) {
					if (packages.has(entry.header.package.name)) {
						files.set(entry.header.package.name, entry.header.path);
					}
				}
			}
		}
		type RedirectRead =
			| { readonly status: "read"; readonly redirects: readonly InputContextRedirect[] }
			| { readonly status: "failed"; readonly message: string };
		const redirectCache = new Map<string, RedirectRead>();
		const redirectsOf = (inputData: string) =>
			Effect.gen(function* () {
				const cached = redirectCache.get(inputData);
				if (cached !== undefined) return cached;
				const file = files.get(contextIdentity(inputData));
				const result: RedirectRead =
					file === undefined
						? {
								status: "failed",
								message:
									inventoryFailure ??
									`No saved Blueprint package was found for ${inputData}; a native class saves no redirects here.`
							}
						: yield* reader.readAsset(resolve(options.projectRoot, file)).pipe(
								Effect.map(
									(inspection): RedirectRead => ({
										status: "read",
										redirects: platformDataRedirectsFromInspection(
											inspection,
											inputData
										)
									})
								),
								Effect.catchTag("AssetReaderError", (error) =>
									Effect.succeed<RedirectRead>({
										status: "failed",
										message: error.message
									})
								)
							);
				redirectCache.set(inputData, result);
				return result;
			});
		return yield* Effect.forEach(listed, (entry) =>
			Effect.gen(function* () {
				if (entry.status === "unavailable") {
					return {
						platform: entry.platform,
						status: "unavailable",
						inputData: [],
						redirects: [],
						diagnostics: [entry.message]
					} satisfies InputPlatformView;
				}
				const redirects: InputContextRedirect[] = [];
				const diagnostics: string[] = [];
				for (const inputData of entry.inputData) {
					const result = yield* redirectsOf(inputData);
					if (result.status === "failed") diagnostics.push(result.message);
					else redirects.push(...result.redirects);
				}
				return {
					platform: entry.platform,
					status: diagnostics.length > 0 ? "partial" : "resolved",
					inputData: entry.inputData,
					redirects,
					diagnostics
				} satisfies InputPlatformView;
			})
		);
	}
);

/** The composed co-activation sources a host asked for, each optional. */
export interface CoActivationRequest {
	readonly project?: {
		readonly project: string;
		readonly platform: string;
		readonly engineRoot?: string;
	};
	readonly documentPath?: string;
	/** Config asset sets come from the report and cost nothing; pass them in to include them. */
	readonly configAssetSets?: readonly CoActivationSet[];
}

export interface EnhancedInputAnalysisApi {
	readonly coActivation: (request: CoActivationRequest) => Effect.Effect<
		{
			readonly sets: readonly CoActivationSet[];
			readonly sources: readonly CoActivationSourceStatus[];
		},
		EnhancedInputAnalysisError
	>;
	readonly blueprintUses: (
		report: EnhancedInputReport,
		options: BlueprintUseScanOptions
	) => Effect.Effect<BlueprintUseScan, EnhancedInputAnalysisError>;
	readonly platforms: (options: {
		readonly project: string;
		readonly projectRoot: string;
		readonly platforms: readonly string[];
		readonly engineRoot?: string;
	}) => Effect.Effect<readonly InputPlatformView[]>;
}

/** The analysis sources as one service, for hosts that want a single layer to provide. */
export class EnhancedInputAnalysis extends Context.Service<
	EnhancedInputAnalysis,
	EnhancedInputAnalysisApi
>()("@ue-shed/enhanced-input/EnhancedInputAnalysis") {}

export const EnhancedInputAnalysisLive = Layer.effect(
	EnhancedInputAnalysis,
	Effect.gen(function* () {
		const explorer = yield* ConfigExplorer;
		const reader = yield* AssetReader;
		const provide = <A, E>(effect: Effect.Effect<A, E, ConfigExplorer | AssetReader>) =>
			effect.pipe(
				Effect.provideService(ConfigExplorer, explorer),
				Effect.provideService(AssetReader, reader)
			);
		const coActivation = Effect.fn("EnhancedInputAnalysis.coActivation")(function* (
			request: CoActivationRequest
		) {
			const sets: CoActivationSet[] = [];
			const sources: CoActivationSourceStatus[] = [];
			const configAssetSets = request.configAssetSets ?? [];
			sets.push(...configAssetSets);
			sources.push(
				configAssetSets.length > 0
					? {
							source: "config_asset",
							status: "resolved",
							sets: configAssetSets.length,
							detail: "Player mappable input config assets in the scan."
						}
					: {
							source: "config_asset",
							status: "absent",
							detail: "The scan found no config asset with readable contexts."
						}
			);
			if (request.project !== undefined) {
				const resolved = yield* provide(resolveDefaultContextsFromConfig(request.project));
				sets.push(...resolved.sets);
				sources.push(resolved.status);
			}
			if (request.documentPath !== undefined) {
				const resolved = yield* readCoActivationDocument(request.documentPath);
				sets.push(...resolved.sets);
				sources.push(resolved.status);
			}
			return { sets, sources };
		});
		return EnhancedInputAnalysis.of({
			coActivation,
			blueprintUses: (report, options) =>
				provide(scanBlueprintInputActionUses(report, options)),
			platforms: (options) => provide(resolvePlatformViews(options))
		});
	})
);
