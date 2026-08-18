import { basename, extname, join } from "node:path";
import {
	EngineInstallationDiscovery,
	EngineInstallationDiscoveryLive,
	type EngineInstallationError
} from "@ue-shed/engine-discovery";
import { Context, Effect, Layer, Result, Schema } from "effect";
import {
	ConfigFileAccess,
	ConfigFileAccessLive,
	type ConfigFileAccessError
} from "./file-access.js";
import {
	buildConfigHierarchy,
	resolveConfigProject,
	resolvePlatformChain,
	type ConfigHierarchyLayer,
	type ConfigProject
} from "./hierarchy.js";
import {
	compareConfigExplanations,
	foldConfigCommands,
	type ParsedConfigCommand
} from "./merge.js";
import { configRedirectAffects, parseConfigFile } from "./parser.js";
import {
	ConfigCompareRequest,
	ConfigExplainRequest,
	ConfigExplorerPublicError,
	ConfigFamily,
	type ConfigAuthorityCoverage,
	type ConfigComparison,
	type ConfigDiagnostic,
	type ConfigExplanation,
	type ConfigLayerCoverage
} from "./schema.js";

export class ConfigExplorerError extends Schema.TaggedErrorClass<ConfigExplorerError>()(
	"ConfigExplorerError",
	ConfigExplorerPublicError.fields
) {}

export interface ConfigExplorerApi {
	readonly explain: (
		request: ConfigExplainRequest
	) => Effect.Effect<ConfigExplanation, ConfigExplorerError>;
	readonly compare: (
		request: ConfigCompareRequest
	) => Effect.Effect<ConfigComparison, ConfigExplorerError>;
}

export class ConfigExplorer extends Context.Service<ConfigExplorer, ConfigExplorerApi>()(
	"@ue-shed/config-explorer/ConfigExplorer"
) {}

const authorities: readonly ConfigAuthorityCoverage[] = [
	{
		authority: "saved_generated",
		status: "excluded",
		detail: "Project Saved/Config generated destination files are not read."
	},
	{
		authority: "user_private",
		status: "excluded",
		detail: "Application, user, and project User*.ini layers are not probed."
	},
	{
		authority: "live_cvars",
		status: "excluded",
		detail: "Live console variables require separate running-process authority."
	},
	{
		authority: "device_profiles",
		status: "excluded",
		detail: "Device Profile selection and CVar application are a separate resolver."
	},
	{
		authority: "command_line",
		status: "excluded",
		detail: "Command-line config and CVar overrides are invocation-specific."
	},
	{
		authority: "cooked_staged",
		status: "excluded",
		detail: "Cooked, staged, and binary config are outside source evidence."
	},
	{
		authority: "dynamic_plugins",
		status: "unsupported",
		detail: "Plugin, Game Feature, hotfix, and dynamic layers are not resolved."
	},
	{
		authority: "runtime_mutation",
		status: "excluded",
		detail: "Code defaults, environment changes, and runtime writes are not saved-source evidence."
	}
];

function error(
	code: ConfigExplorerError["code"],
	message: string,
	recovery: string,
	retrySafe = true,
	candidates?: readonly string[]
): ConfigExplorerError {
	return new ConfigExplorerError({
		code,
		message,
		recovery,
		retrySafe,
		...(candidates === undefined ? undefined : { candidates: [...candidates] })
	});
}

function engineError(cause: EngineInstallationError): ConfigExplorerError {
	return error(
		"engine_discovery_incomplete",
		cause.message,
		cause.recovery,
		cause.retrySafe,
		cause.candidates
	);
}

function projectError(_cause: ConfigFileAccessError): ConfigExplorerError {
	return error(
		"invalid_project",
		"The selected project could not be resolved to exactly one readable .uproject descriptor.",
		"Pass a .uproject path or a project root containing exactly one descriptor.",
		false
	);
}

function platformError(_cause: ConfigFileAccessError): ConfigExplorerError {
	return error(
		"invalid_platform",
		"The selected platform metadata is missing, unreadable, or has an invalid parent chain.",
		"Choose a platform with readable DataDrivenPlatformInfo.ini evidence.",
		false
	);
}

function familyFromFilename(filename: string): string | undefined {
	const match = /^(?:Base|Default)(.+)\.ini$/iu.exec(filename);
	return match?.[1];
}

function discoverFamilies(options: {
	readonly engineRoot: string;
	readonly project: ConfigProject;
}): Effect.Effect<readonly string[], ConfigExplorerError, ConfigFileAccess> {
	return Effect.gen(function* () {
		const files = yield* ConfigFileAccess;
		const directories = [
			join(options.engineRoot, "Engine", "Config"),
			join(options.project.root, "Config")
		];
		const names = yield* Effect.forEach(directories, (directory) =>
			files.list(directory).pipe(
				Effect.map((entries) =>
					entries.filter((entry) => entry.kind === "file").map((entry) => entry.name)
				),
				Effect.catch(() => Effect.succeed([]))
			)
		);
		return [
			...new Map(
				names
					.flatMap((entries) => entries)
					.flatMap((name) => {
						const family = familyFromFilename(name);
						return family === undefined
							? []
							: [[family.toLocaleLowerCase(), family] as const];
					})
			).values()
		].sort((left, right) => left.localeCompare(right));
	});
}

interface LoadedHierarchy {
	readonly commands: readonly ParsedConfigCommand[];
	readonly diagnostics: readonly ConfigDiagnostic[];
	readonly coverage: readonly ConfigLayerCoverage[];
}

function loadConfigRedirectCoverage(options: {
	readonly engineRoot: string;
	readonly project: ConfigProject;
	readonly section: ConfigExplainRequest["section"];
	readonly key: ConfigExplainRequest["key"];
}): Effect.Effect<LoadedHierarchy, never, ConfigFileAccess> {
	return Effect.gen(function* () {
		const files = yield* ConfigFileAccess;
		const candidates = [
			{
				path: join(options.engineRoot, "Engine", "Config", "ConfigRedirects.ini"),
				source: { scope: "engine" as const, path: "Engine/Config/ConfigRedirects.ini" }
			},
			{
				path: join(options.project.root, "Config", "ConfigRedirects.ini"),
				source: { scope: "project" as const, path: "Config/ConfigRedirects.ini" }
			}
		];
		const coverage: ConfigLayerCoverage[] = [];
		const diagnostics: ConfigDiagnostic[] = [];
		for (let order = 0; order < candidates.length; order++) {
			const candidate = candidates[order]!;
			if (!(yield* files.exists(candidate.path))) {
				coverage.push({
					order,
					layer: "ConfigRedirects",
					source: candidate.source,
					status: "missing"
				});
				continue;
			}
			const loaded = yield* Effect.result(files.readText(candidate.path));
			if (Result.isFailure(loaded)) {
				coverage.push({
					order,
					layer: "ConfigRedirects",
					source: candidate.source,
					status: "unreadable",
					detail: "The redirect file exists but could not be read."
				});
				continue;
			}
			const relevant = configRedirectAffects({
				text: loaded.success,
				section: options.section,
				key: options.key
			});
			coverage.push({
				order,
				layer: "ConfigRedirects",
				source: candidate.source,
				status: relevant ? "unsupported" : "read",
				...(relevant
					? { detail: "A section or key redirect can affect the selected identity." }
					: undefined)
			});
			if (relevant) {
				diagnostics.push({
					code: "unsupported_config_redirect",
					message:
						"Config redirects can rename the selected section or key and are not applied in this slice.",
					source: candidate.source
				});
			}
		}
		return { commands: [], coverage, diagnostics };
	});
}

function loadHierarchy(options: {
	readonly layers: readonly ConfigHierarchyLayer[];
	readonly section: ConfigExplainRequest["section"];
	readonly key: ConfigExplainRequest["key"];
}): Effect.Effect<LoadedHierarchy, never, ConfigFileAccess> {
	return Effect.gen(function* () {
		const files = yield* ConfigFileAccess;
		const commands: ParsedConfigCommand[] = [];
		const diagnostics: ConfigDiagnostic[] = [];
		const coverage: ConfigLayerCoverage[] = [];
		for (let order = 0; order < options.layers.length; order++) {
			const candidate = options.layers[order]!;
			if (!(yield* files.exists(candidate.path))) {
				coverage.push({
					order,
					layer: candidate.name,
					source: candidate.source,
					status: "missing"
				});
				continue;
			}
			const loaded = yield* Effect.result(files.readText(candidate.path));
			if (Result.isFailure(loaded)) {
				coverage.push({
					order,
					layer: candidate.name,
					source: candidate.source,
					status: "unreadable",
					detail: "The file exists but could not be read."
				});
				continue;
			}
			const parsed = parseConfigFile({
				text: loaded.success,
				source: candidate.source,
				section: options.section,
				key: options.key
			});
			commands.push(...parsed.commands);
			diagnostics.push(...parsed.diagnostics);
			coverage.push({
				order,
				layer: candidate.name,
				source: candidate.source,
				status: parsed.diagnostics.length === 0 ? "read" : "unsupported",
				...(parsed.diagnostics.length === 0
					? undefined
					: { detail: "Selected-key syntax is not fully supported in this layer." })
			});
		}
		return { commands, diagnostics, coverage };
	});
}

function chooseFamily(options: {
	readonly requested?: ConfigExplainRequest["family"];
	readonly families: readonly string[];
	readonly hierarchyFor: (family: string) => readonly ConfigHierarchyLayer[];
	readonly section: ConfigExplainRequest["section"];
	readonly key: ConfigExplainRequest["key"];
}): Effect.Effect<string, ConfigExplorerError, ConfigFileAccess> {
	if (options.requested !== undefined) return Effect.succeed(options.requested);
	return Effect.gen(function* () {
		const matched: string[] = [];
		for (const family of options.families) {
			const loaded = yield* loadHierarchy({
				// Base.ini contributes to every family and therefore cannot identify one.
				layers: options
					.hierarchyFor(family)
					.filter((layer) => layer.name !== "AbsoluteBase"),
				section: options.section,
				key: options.key
			});
			if (loaded.commands.length > 0 || loaded.diagnostics.length > 0) matched.push(family);
		}
		if (matched.length === 1) return matched[0]!;
		return yield* error(
			"ambiguous_config_family",
			matched.length === 0
				? "The selected section/key does not identify a config family."
				: "The selected section/key occurs in more than one config family.",
			"Pass an explicit --family value.",
			false,
			matched.length === 0 ? options.families : matched
		);
	});
}

export const ConfigExplorerLive = Layer.effect(
	ConfigExplorer,
	Effect.gen(function* () {
		const files = yield* ConfigFileAccess;
		const engines = yield* EngineInstallationDiscovery;

		const explain = Effect.fn("ConfigExplorer.explain")(function* (
			input: ConfigExplainRequest
		) {
			const request = yield* Schema.decodeUnknownEffect(ConfigExplainRequest)(input).pipe(
				Effect.mapError(() =>
					error(
						"invalid_request",
						"The config explanation request is invalid.",
						"Provide non-empty project, platform, section, and key values.",
						false
					)
				)
			);
			const project = yield* resolveConfigProject(request.project).pipe(
				Effect.provideService(ConfigFileAccess, files),
				Effect.mapError(projectError)
			);
			const engine = yield* engines
				.resolve({
					projectDescriptor: project.descriptor,
					...(request.engineRoot === undefined
						? undefined
						: { explicitRoot: request.engineRoot })
				})
				.pipe(Effect.mapError(engineError));
			const platforms = yield* resolvePlatformChain({
				engineRoot: engine.root,
				projectRoot: project.root,
				platform: request.platform
			}).pipe(Effect.provideService(ConfigFileAccess, files), Effect.mapError(platformError));
			const families = yield* discoverFamilies({ engineRoot: engine.root, project }).pipe(
				Effect.provideService(ConfigFileAccess, files)
			);
			const hierarchyFor = (family: string) =>
				buildConfigHierarchy({
					engineRoot: engine.root,
					projectRoot: project.root,
					family,
					platforms
				});
			const family = yield* chooseFamily({
				...(request.family === undefined ? undefined : { requested: request.family }),
				families,
				hierarchyFor,
				section: request.section,
				key: request.key
			}).pipe(Effect.provideService(ConfigFileAccess, files));
			const redirects = yield* loadConfigRedirectCoverage({
				engineRoot: engine.root,
				project,
				section: request.section,
				key: request.key
			}).pipe(Effect.provideService(ConfigFileAccess, files));
			const loaded = yield* loadHierarchy({
				layers: hierarchyFor(family),
				section: request.section,
				key: request.key
			}).pipe(Effect.provideService(ConfigFileAccess, files));
			const folded = foldConfigCommands(loaded.commands);
			const coverage = [
				...redirects.coverage,
				...loaded.coverage.map((layer) => ({
					...layer,
					order: layer.order + redirects.coverage.length
				}))
			];
			const diagnostics = [...redirects.diagnostics, ...loaded.diagnostics];
			const partial = coverage.some(
				(layer) => layer.status === "unreadable" || layer.status === "unsupported"
			);
			const explanation: ConfigExplanation = {
				schemaVersion: 1,
				status: partial ? ("partial" as const) : ("complete" as const),
				project: { descriptor: basename(project.descriptor, extname(project.descriptor)) },
				platform: request.platform,
				family: ConfigFamily.make(family),
				section: request.section,
				key: request.key,
				effectiveValue: folded.effectiveValue,
				contributions: folded.contributions,
				layers: coverage,
				authorities,
				diagnostics
			};
			return explanation;
		});

		const compare = Effect.fn("ConfigExplorer.compare")(function* (
			input: ConfigCompareRequest
		) {
			const request = yield* Schema.decodeUnknownEffect(ConfigCompareRequest)(input).pipe(
				Effect.mapError(() =>
					error(
						"invalid_request",
						"The config comparison request is invalid.",
						"Provide explicit left and right platforms.",
						false
					)
				)
			);
			const common = {
				project: request.project,
				section: request.section,
				key: request.key,
				...(request.engineRoot === undefined
					? undefined
					: { engineRoot: request.engineRoot }),
				...(request.family === undefined ? undefined : { family: request.family })
			};
			const [left, right] = yield* Effect.all(
				[
					explain({ ...common, platform: request.leftPlatform }),
					explain({ ...common, platform: request.rightPlatform })
				],
				{ concurrency: 2 }
			);
			return compareConfigExplanations({ left, right });
		});

		return ConfigExplorer.of({ explain, compare });
	})
);

export const ConfigExplorerNodeLive = ConfigExplorerLive.pipe(
	Layer.provide(ConfigFileAccessLive),
	Layer.provide(EngineInstallationDiscoveryLive)
);

export function makeConfigExplorerTestLayer(
	service: ConfigExplorerApi
): Layer.Layer<ConfigExplorer> {
	return Layer.succeed(ConfigExplorer, ConfigExplorer.of(service));
}
