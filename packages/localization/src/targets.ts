import {
	ConfigKey,
	ConfigSection,
	foldConfigCommands,
	parseConfigFile,
	type ParsedConfigCommand
} from "@ue-shed/config-explorer/browser";
import { Result, Schema } from "effect";
import { immutable, limitsFor, localizationError, parseResult, validate } from "./decode.js";
import {
	DashboardSettings,
	LocalizationRecipe,
	LocalizationTarget,
	LocalizationTargetDiscovery,
	LocalizationTargetName,
	LocalizationTargetSettings,
	RecipeFields,
	type LocalizationLimits,
	type LocalizationOutputPaths
} from "./schema.js";

type StructValue = typeof Schema.Json.Type;

/** Unreal property text is a separate grammar from INI; INI remains Config Explorer's boundary. */
export function parseStructText(text: string, options?: LocalizationLimits) {
	return parseResult(() => {
		const limits = limitsFor(options);
		if (new TextEncoder().encode(text).length > limits.maxFileBytes)
			throw localizationError("limit_exceeded");
		let cursor = 0;
		let values = 0;
		const whitespace = () => {
			while (/\s/u.test(text[cursor] ?? "") && cursor < text.length) cursor++;
		};
		const fail = (): never => {
			throw localizationError("malformed_struct");
		};
		function read(depth: number): StructValue {
			if (depth > limits.maxDepth || ++values > limits.maxEntries)
				throw localizationError("limit_exceeded");
			whitespace();
			if (text[cursor] === '"') {
				cursor++;
				let result = "";
				while (cursor < text.length) {
					const character = text[cursor++];
					if (character === '"') return result;
					if (character === "\\") {
						const escaped = text[cursor++];
						if (escaped === undefined) fail();
						result +=
							escaped === "n"
								? "\n"
								: escaped === "r"
									? "\r"
									: escaped === "t"
										? "\t"
										: escaped;
					} else result += character;
				}
				return fail();
			}
			if (text[cursor] === "(") {
				cursor++;
				whitespace();
				if (text[cursor] === ")") {
					cursor++;
					return [];
				}
				const isObject = /^[A-Za-z_][A-Za-z0-9_]*\s*=/u.test(text.slice(cursor));
				const object: Record<string, StructValue> = {};
				const array: StructValue[] = [];
				while (cursor < text.length) {
					whitespace();
					if (isObject) {
						const key = /^[A-Za-z_][A-Za-z0-9_]*\s*=/u.exec(text.slice(cursor));
						if (key === null) return fail();
						const name = key[0].slice(0, -1).trim();
						if (Object.hasOwn(object, name)) return fail();
						cursor += key[0].length;
						Object.defineProperty(object, name, {
							value: read(depth + 1),
							enumerable: true
						});
					} else array.push(read(depth + 1));
					whitespace();
					if (text[cursor] === ")") {
						cursor++;
						return isObject ? object : array;
					}
					if (text[cursor++] !== ",") return fail();
				}
				return fail();
			}
			const start = cursor;
			while (cursor < text.length && text[cursor] !== "," && text[cursor] !== ")") cursor++;
			const scalar = text.slice(start, cursor).trim();
			if (scalar === "") return [];
			if (/^[+-]?\d+$/u.test(scalar) && scalar.length < 10) return Number(scalar);
			if (/^true$/iu.test(scalar)) return true;
			if (/^false$/iu.test(scalar)) return false;
			if (!/^[A-Za-z0-9_:/.'-]+$/u.test(scalar)) return fail();
			return scalar;
		}
		const value = read(0);
		whitespace();
		if (cursor !== text.length) fail();
		return immutable(value);
	});
}

function configCommands(text: string, section: string, key: string) {
	const parsed = parseConfigFile({
		text,
		source: { scope: "project", path: "config" },
		section: ConfigSection.make(section),
		key: ConfigKey.make(key)
	});
	if (parsed.diagnostics.length > 0) throw localizationError("malformed_ini");
	return parsed.commands;
}

function values(commands: readonly ParsedConfigCommand[], repeated = false): readonly string[] {
	// UE GetArray reads repeated unprefixed entries in authored recipes. The Dashboard uses
	// config hierarchy operations; those are folded unchanged by Config Explorer.
	const effective = foldConfigCommands(
		repeated
			? commands.map((command) => ({
					...command,
					operation: command.operation === "set" ? "append" : command.operation
				}))
			: commands
	).effectiveValue;
	return effective.kind === "array"
		? effective.values
		: effective.kind === "scalar"
			? [effective.value]
			: [];
}

export function parseDashboardTargets(text: string, options?: LocalizationLimits) {
	return parseResult(() => {
		const limits = limitsFor(options);
		if (new TextEncoder().encode(text).length > limits.maxFileBytes)
			throw localizationError("limit_exceeded");
		const raw = values(
			configCommands(
				text.replace(/^\uFEFF/u, ""),
				"/Script/Localization.LocalizationSettings",
				"GameTargetsSettings"
			)
		);
		if (raw.length > limits.maxEntries) throw localizationError("limit_exceeded");
		const targets: LocalizationTargetSettings[] = [];
		const diagnostics: LocalizationTargetDiscovery["diagnostics"][number][] = [];
		for (const [targetIndex, value] of raw.entries()) {
			const result = parseResult(() => {
				const struct = parseStructText(value, limits);
				if (Result.isFailure(struct)) throw struct.failure;
				const settings = validate(
					DashboardSettings,
					struct.success,
					"malformed_struct",
					true
				);
				const cultures = settings.SupportedCulturesStatistics.map(
					({ CultureName }) => CultureName
				);
				const nativeCulture =
					settings.NativeCultureIndex === -1
						? null
						: cultures[settings.NativeCultureIndex];
				if (nativeCulture === undefined || new Set(cultures).size !== cultures.length)
					throw localizationError("malformed_struct");
				return validate(LocalizationTargetSettings, {
					name: settings.Name,
					guid: settings.Guid,
					cultures,
					nativeCulture,
					settings
				});
			});
			if (Result.isFailure(result)) diagnostics.push({ targetIndex, error: result.failure });
			else targets.push(result.success);
		}
		return immutable({ targets, diagnostics });
	});
}

const arrayFields = new Set([
	"CulturesToGenerate",
	"SearchDirectoryPaths",
	"IncludePathFilters",
	"ExcludePathFilters",
	"FileNameFilters",
	"PackageFileNameFilters",
	"ExcludeClasses"
]);
const booleanFields = new Set([
	"bUseCultureDirectory",
	"bImportLoc",
	"bExportLoc",
	"ShouldExcludeDerivedClasses",
	"ShouldGatherFromEditorOnlyData",
	"SkipGatherCache"
]);
function recipeFields(text: string, section: string) {
	const fields: Record<string, RecipeFields[keyof RecipeFields]> = {};
	for (const key of Object.keys(RecipeFields.fields)) {
		const found = values(configCommands(text, section, key), arrayFields.has(key));
		if (arrayFields.has(key)) fields[key] = found;
		else if (found.length > 0) {
			const last = found.at(-1) ?? "";
			fields[key] = booleanFields.has(key)
				? /^true$/iu.test(last)
					? true
					: /^false$/iu.test(last)
						? false
						: last
				: key === "POFormat" || key === "LocalizedTextCollapseMode"
					? (last.split("::").at(-1) ?? "")
					: last;
		}
	}
	const decoded = Schema.decodeUnknownResult(RecipeFields)(fields);
	if (Result.isFailure(decoded)) throw localizationError("malformed_ini");
	return decoded.success;
}

export function parseLocalizationRecipe(
	text: string,
	relativePath: string,
	options?: LocalizationLimits
) {
	return parseResult(() => {
		const limits = limitsFor(options);
		if (new TextEncoder().encode(text).length > limits.maxFileBytes)
			throw localizationError("limit_exceeded");
		const normalized = text.replace(/^\uFEFF/u, "");
		// Enumerate section names only; Config Explorer parses every selected value and operation.
		const sections = [...normalized.matchAll(/^\s*\[GatherTextStep(\d+)\]\s*$/gimu)].map(
			(match) => Number(match[1])
		);
		if (sections.length > limits.maxEntries) throw localizationError("limit_exceeded");
		const steps = [...new Set(sections)]
			.sort((a, b) => a - b)
			.map((index) => ({
				index,
				commandletClass: validate(
					Schema.NonEmptyString,
					values(
						configCommands(normalized, `GatherTextStep${index}`, "CommandletClass")
					).at(-1),
					"malformed_ini"
				),
				fields: recipeFields(normalized, `GatherTextStep${index}`)
			}));
		if (steps.length === 0) throw localizationError("malformed_ini");
		return immutable(
			validate(
				LocalizationRecipe,
				{ relativePath, common: recipeFields(normalized, "CommonSettings"), steps },
				"malformed_ini"
			)
		);
	});
}

function joined(directory: string, filename: string): string {
	return `${directory.replace(/[/\\]+$/u, "")}/${filename}`.replaceAll("\\", "/");
}

const OutputCandidate = Schema.Struct({
	kind: Schema.Literals(["manifest", "archive", "po", "resource", "wordCount", "conflicts"]),
	path: Schema.String,
	priority: Schema.Int,
	cultures: RecipeFields.fields.CulturesToGenerate,
	cultureDirectory: Schema.Boolean
});
type OutputCandidate = typeof OutputCandidate.Type;

function outputPaths(
	configs: readonly LocalizationRecipe[],
	cultures: LocalizationTarget["cultures"]
): LocalizationOutputPaths {
	const candidates: OutputCandidate[] = [];
	for (const config of configs) {
		for (const step of config.steps) {
			const fields: RecipeFields = {
				...config.common,
				...step.fields,
				CulturesToGenerate:
					step.fields.CulturesToGenerate.length === 0
						? config.common.CulturesToGenerate
						: step.fields.CulturesToGenerate
			};
			const input = fields.SourcePath ?? fields.DestinationPath;
			const output = fields.DestinationPath ?? fields.SourcePath;
			if (input === undefined || output === undefined) continue;
			const add = (
				kind: OutputCandidate["kind"],
				directory: string,
				filename: string | undefined,
				priority: number
			) => {
				if (filename !== undefined)
					candidates.push({
						kind,
						path: joined(directory, filename),
						priority,
						cultures: fields.CulturesToGenerate,
						cultureDirectory: fields.bUseCultureDirectory ?? true
					});
			};
			const command = step.commandletClass;
			const gatherManifest = command === "GenerateGatherManifest";
			const gatherArchive = command === "GenerateGatherArchive";
			const portableObject = command === "InternationalizationExport";
			const resource = command === "GenerateTextLocalizationResource";
			const report = command === "GenerateTextLocalizationReport";
			add(
				"manifest",
				gatherManifest ? output : input,
				fields.ManifestName,
				gatherManifest ? 0 : 2
			);
			add(
				"archive",
				gatherArchive || (portableObject && fields.bImportLoc) ? output : input,
				fields.ArchiveName,
				gatherArchive ? 0 : portableObject || resource ? 1 : 2
			);
			add(
				"po",
				portableObject && fields.bImportLoc ? input : output,
				fields.PortableObjectName,
				portableObject ? (fields.bExportLoc ? 0 : 1) : 2
			);
			add("resource", output, fields.ResourceName, resource ? 0 : 2);
			add("wordCount", output, fields.WordCountReportName, report ? 0 : 2);
			add("conflicts", output, fields.ConflictReportName, report ? 0 : 2);
		}
	}
	const select = (
		kind: OutputCandidate["kind"],
		culture?: LocalizationTarget["cultures"][number]
	): string | null => {
		const matching = candidates.filter(
			(candidate) =>
				candidate.kind === kind &&
				(culture === undefined ||
					candidate.cultures.length === 0 ||
					candidate.cultures.includes(culture))
		);
		const priority = Math.min(...matching.map((candidate) => candidate.priority));
		const unique = [
			...new Set(
				matching
					.filter((candidate) => candidate.priority === priority)
					.map((candidate) =>
						culture === undefined || !candidate.cultureDirectory
							? candidate.path
							: candidate.path.replace(/\/([^/]+)$/u, `/${culture}/$1`)
					)
			)
		];
		if (unique.length > 1) throw localizationError("ambiguous_config");
		return unique[0] ?? null;
	};
	const byCulture = (kind: OutputCandidate["kind"]) =>
		Object.fromEntries(
			cultures.flatMap((culture) => {
				const path = select(kind, culture);
				return path === null ? [] : [[culture, path]];
			})
		);
	const manifest = select("manifest");
	const resource = select("resource");
	return {
		manifest,
		archives: byCulture("archive"),
		portableObjects: byCulture("po"),
		resources: byCulture("resource"),
		locmeta:
			resource?.replace(/\.locres$/iu, ".locmeta") ??
			manifest?.replace(/\.manifest$/iu, ".locmeta") ??
			null,
		wordCount: select("wordCount"),
		conflicts: select("conflicts")
	};
}

export const LocalizationConfigInput = Schema.Struct({
	relativePath: Schema.String,
	text: Schema.String
});
export type LocalizationConfigInput = typeof LocalizationConfigInput.Type;

export function discoverLocalizationTargets(input: {
	readonly dashboardText?: string;
	readonly configs: readonly LocalizationConfigInput[];
	readonly limits?: LocalizationLimits;
}) {
	return parseResult(() => {
		const limits = limitsFor(input.limits);
		if (input.configs.length > limits.maxFiles) throw localizationError("limit_exceeded");
		const dashboard = parseDashboardTargets(input.dashboardText ?? "", limits);
		if (Result.isFailure(dashboard)) throw dashboard.failure;
		const diagnostics = [...dashboard.success.diagnostics];
		const recipes = new Map<string, LocalizationRecipe[]>();
		for (const [configIndex, config] of input.configs.entries()) {
			const result = parseLocalizationRecipe(config.text, config.relativePath, limits);
			if (Result.isFailure(result)) {
				diagnostics.push({ configIndex, error: result.failure });
				continue;
			}
			const recipe = result.success;
			const manifest =
				recipe.common.ManifestName ??
				recipe.steps.find((step) => step.fields.ManifestName !== undefined)?.fields
					.ManifestName;
			if (manifest === undefined || !manifest.endsWith(".manifest")) {
				diagnostics.push({ configIndex, error: localizationError("malformed_ini") });
				continue;
			}
			const name = manifest.slice(0, -".manifest".length);
			recipes.set(name, [...(recipes.get(name) ?? []), recipe]);
		}
		const names = new Set([
			...dashboard.success.targets.map((target) => target.name),
			...recipes.keys()
		]);
		const targets: LocalizationTarget[] = [];
		for (const [targetIndex, name] of [...names].sort().entries()) {
			const result = parseResult(() => {
				const configured = dashboard.success.targets.find((target) => target.name === name);
				const configs = recipes.get(name) ?? [];
				const cultures = configured?.cultures ?? [
					...new Set(
						configs.flatMap((config) => [
							...config.common.CulturesToGenerate,
							...config.steps.flatMap((step) => step.fields.CulturesToGenerate)
						])
					)
				];
				const native = [
					...new Set(
						configs
							.flatMap((config) => [
								config.common.NativeCulture,
								...config.steps.map((step) => step.fields.NativeCulture)
							])
							.filter((value) => value !== undefined)
					)
				];
				if (native.length > 1) throw localizationError("ambiguous_config");
				const formats = [
					...new Set(
						configs
							.flatMap((config) => [
								config.common.POFormat,
								...config.steps.map((step) => step.fields.POFormat)
							])
							.filter((value) => value !== undefined)
					)
				];
				if (formats.length > 1) throw localizationError("ambiguous_config");
				const collapseModes = [
					...new Set(
						configs
							.flatMap((config) => [
								config.common.LocalizedTextCollapseMode,
								...config.steps.map((step) => step.fields.LocalizedTextCollapseMode)
							])
							.filter((value) => value !== undefined)
					)
				];
				if (collapseModes.length > 1) throw localizationError("ambiguous_config");
				const target: LocalizationTarget = {
					name: validate(LocalizationTargetName, name),
					source: configured === undefined ? "config_only" : "dashboard_settings",
					nativeCulture:
						configured === undefined ? (native[0] ?? null) : configured.nativeCulture,
					cultures,
					configs,
					outputPaths: outputPaths(configs, cultures),
					poFormat:
						configured?.settings.ExportSettings?.POFormat ?? formats[0] ?? "Unreal",
					collapseMode:
						configured?.settings.ExportSettings?.CollapseMode ??
						collapseModes[0] ??
						"IdenticalTextIdAndSource"
				};
				if (configured !== undefined) Object.assign(target, { dashboard: configured });
				return validate(LocalizationTarget, target);
			});
			if (Result.isFailure(result)) diagnostics.push({ targetIndex, error: result.failure });
			else targets.push(result.success);
		}
		return immutable(
			validate(LocalizationTargetDiscovery, { schemaVersion: 1, targets, diagnostics })
		);
	});
}
