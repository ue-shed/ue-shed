import { Schema } from "effect";
import { resolveLocalizationGatherPath } from "./gather-path.js";
import type { LocalizationRecipe, RecipeFields } from "./schema.js";
import {
	LocalizationOperationError,
	LocalizationOperationPlan,
	LocalizationPlanningRequest,
	LocalizationOperation,
	type LocalizationPlannedFile,
	type LocalizationStepKind
} from "./operation-schema.js";

export function localizationOperationError(
	code: LocalizationOperationError["code"]
): LocalizationOperationError {
	const recovery = {
		missing_config:
			"Open the Localization Dashboard once to generate this target's operation configs.",
		target_not_found: "Run loc targets and select a listed target name.",
		unsupported_operation:
			"Choose an operation supported by this target's existing recipe steps, or generate separate Dashboard configs.",
		unsupported_config:
			"Use standard localization steps without platform splitting, gather-cache repair or custom commandlets; generate a separate reviewed recipe for other writes.",
		engine_not_found:
			"Install the project's engine or specify --engine-root with a complete installation.",
		engine_ambiguous: "Specify --engine-root to select one engine installation.",
		unsupported_engine: "Choose UE 4.27, 5.7 or 5.8.",
		project_locked:
			"Close the editor or release the lock, inspect partial output, then plan again before retrying.",
		timeout:
			"Inspect the private commandlet log and partial output; increase --timeout only after planning again.",
		cancelled:
			"The owned process has stopped. Inspect partial output and plan again before retrying.",
		termination_failed:
			"Stop the remaining owned process tree before retrying; inspect the private log.",
		commandlet_failed:
			"Inspect the private commandlet log and partial output, repair the target configuration, then plan again.",
		config_changed:
			"Refresh target discovery and review the new operation plan before running.",
		unsafe_path:
			"Use project-relative config and output paths without traversal, symlinks or engine-root substitutions.",
		project_missing: "Choose a project root containing one readable .uproject descriptor.",
		project_ambiguous: "Choose a project root containing exactly one .uproject descriptor.",
		commandlet_missing: "Repair the selected engine's commandlet executable before retrying.",
		launch_failed:
			"Check engine binaries and owned-process supervision, then retry with an explicit engine root.",
		io_failed:
			"Check project and private-log permissions; inspect partial output before retrying.",
		limit_exceeded:
			"Reduce the target, project audit or log size before retrying; partial output may already exist.",
		invalid_request:
			"Select a target and supported operation, with a timeout between 1 and 86400 seconds."
	} satisfies Record<LocalizationOperationError["code"], string>;
	return new LocalizationOperationError({
		code,
		message: `The localization operation could not complete (${code}).`,
		recovery: recovery[code],
		retrySafe: ![
			"commandlet_failed",
			"timeout",
			"cancelled",
			"termination_failed",
			"io_failed",
			"limit_exceeded"
		].includes(code),
		logExcerpt: []
	});
}

/** Paths inside a plan are project-relative; absolute paths occur only in process arguments. */
export function localizationRelativePath(path: string): string {
	const resolved = resolveLocalizationGatherPath(path);
	const normalized = (resolved.root === "project" ? resolved.path : path).replaceAll("\\", "/");
	if (
		!normalized ||
		/[\u0000\r\n";%:]/u.test(normalized) ||
		normalized.startsWith("/") ||
		normalized.split("/").includes("..")
	)
		throw localizationOperationError("unsafe_path");
	const result = normalized
		.split("/")
		.filter((part) => part !== "." && part !== "")
		.join("/");
	if (!result) throw localizationOperationError("unsafe_path");
	return result;
}
function effective(
	recipe: LocalizationRecipe,
	step: LocalizationRecipe["steps"][number]
): RecipeFields {
	// Empty parsed arrays mean an absent override. Scalar presence follows Unreal's section fallback.
	return {
		...recipe.common,
		...step.fields,
		CulturesToGenerate: step.fields.CulturesToGenerate.length
			? step.fields.CulturesToGenerate
			: recipe.common.CulturesToGenerate
	};
}
function stepKind(command: string, fields: RecipeFields): LocalizationStepKind {
	switch (command) {
		case "GatherTextFromSource":
			return "gather_source";
		case "GatherTextFromAssets":
			return "gather_assets";
		case "GatherTextFromMetaData":
			return "gather_metadata";
		case "GenerateGatherManifest":
			return "manifest";
		case "GenerateGatherArchive":
			return "archive";
		case "InternationalizationExport":
			if (fields.bImportLoc) return "import";
			if (fields.bExportLoc) return "export";
			throw localizationOperationError("unsupported_config");
		case "GenerateTextLocalizationResource":
			return "compile";
		case "GenerateTextLocalizationReport":
			return "reports";
		default:
			throw localizationOperationError("unsupported_config");
	}
}
function supports(recipe: LocalizationRecipe, operation: LocalizationOperation): boolean {
	const kinds = recipe.steps.map((step) =>
		stepKind(step.commandletClass, effective(recipe, step))
	);
	if (operation === "gather")
		return kinds.some((kind) => kind.startsWith("gather_")) && kinds.includes("manifest");
	if (operation === "sync")
		return (
			kinds.includes("import") &&
			kinds.includes("compile") &&
			kinds.indexOf("import") < kinds.indexOf("compile")
		);
	if (operation === "prepare")
		return (
			kinds.some((kind) => kind.startsWith("gather_")) &&
			kinds.includes("manifest") &&
			kinds.includes("export") &&
			kinds.indexOf("manifest") < kinds.indexOf("export")
		);
	if (operation === "import" || operation === "export")
		return recipe.steps.some((step) => {
			const fields = effective(recipe, step);
			return (
				step.commandletClass === "InternationalizationExport" &&
				(operation === "import" ? fields.bImportLoc === true : fields.bExportLoc === true)
			);
		});
	return kinds.includes(operation);
}
const suffixes = {
	gather: "Gather",
	import: "Import",
	export: "Export",
	compile: "Compile",
	reports: "GenerateReports"
} satisfies Record<Exclude<LocalizationOperation, "sync" | "prepare">, string>;

/** Runs existing recipes intact. No dry-run Preview flag and no source-control flags. */
export function planLocalizationOperation(
	input: LocalizationPlanningRequest
): LocalizationOperationPlan {
	const decoded = Schema.decodeUnknownResult(LocalizationPlanningRequest)(input);
	if (decoded._tag === "Failure") throw localizationOperationError("invalid_request");
	const request = decoded.success;
	const { target, operation } = request;
	let recipes: readonly LocalizationRecipe[];
	if (target.source === "dashboard_settings") {
		const operations: readonly LocalizationOperation[] =
			operation === "sync"
				? ["import", "compile"]
				: operation === "prepare"
					? ["gather", "export"]
					: [operation];
		recipes = operations.map((item) => {
			if (item === "sync" || item === "prepare")
				throw localizationOperationError("invalid_request");
			const name = `Config/Localization/${target.name}_${suffixes[item]}.ini`;
			const recipe = target.configs.find(
				(config) => config.relativePath.replaceAll("\\", "/") === name
			);
			if (!recipe) throw localizationOperationError("missing_config");
			if (!supports(recipe, item)) throw localizationOperationError("unsupported_operation");
			return recipe;
		});
	} else {
		const matching = target.configs.filter((recipe) => supports(recipe, operation));
		if (matching.length !== 1)
			throw localizationOperationError(
				matching.length ? "unsupported_config" : "unsupported_operation"
			);
		recipes = matching;
	}
	if (recipes.length > 64) throw localizationOperationError("limit_exceeded");
	const files = new Map<string, LocalizationPlannedFile>();
	const steps: LocalizationOperationPlan["steps"][number][] = [];
	for (const recipe of recipes) {
		const config = localizationRelativePath(recipe.relativePath);
		for (const step of recipe.steps) {
			const fields = effective(recipe, step);
			if (
				(fields.PlatformSplitMode &&
					!["None", "ELocTextPlatformSplitMode::None"].includes(
						fields.PlatformSplitMode
					)) ||
				fields.FixStaleGatherCache ||
				fields.FixMissingGatherCache ||
				fields.FixPackageLocalizationIdConflict ||
				fields.ReportStaleGatherCache
			)
				throw localizationOperationError("unsupported_config");
			const kind = stepKind(step.commandletClass, fields);
			const portable = step.commandletClass === "InternationalizationExport";
			const foreignCultures = fields.CulturesToGenerate.filter(
				(culture) => culture !== fields.NativeCulture
			);
			const poCultures =
				fields.bUseCultureDirectory === false
					? foreignCultures.length
						? foreignCultures
						: fields.NativeCulture
							? [fields.NativeCulture]
							: []
					: [
							...new Set([
								...(fields.NativeCulture ? [fields.NativeCulture] : []),
								...foreignCultures
							])
						];
			if (
				portable &&
				(!fields.NativeCulture ||
					(fields.bUseCultureDirectory === false && poCultures.length !== 1))
			)
				throw localizationOperationError("unsupported_config");
			steps.push({
				index: steps.length,
				config,
				sectionIndex: step.index,
				commandletClass: step.commandletClass,
				kind
			});
			if (steps.length > 1024) throw localizationOperationError("limit_exceeded");
			const add = (
				fileKind: LocalizationPlannedFile["kind"],
				name: string | undefined,
				cultural = false,
				cultureDirectory = true,
				cultures = fields.CulturesToGenerate
			) => {
				if (!fields.DestinationPath || !name)
					throw localizationOperationError("unsupported_config");
				const directory = localizationRelativePath(fields.DestinationPath);
				const filename = localizationRelativePath(name);
				if (cultural && cultures.length === 0)
					throw localizationOperationError("unsupported_config");
				for (const culture of cultural ? cultures : [undefined]) {
					const path = localizationRelativePath(
						`${directory}/${culture && cultureDirectory ? `${culture}/` : ""}${filename}`
					);
					const file: LocalizationPlannedFile = { relativePath: path, kind: fileKind };
					if (culture !== undefined) Object.assign(file, { culture });
					files.set(path, file);
					if (files.size > 100_000) throw localizationOperationError("limit_exceeded");
				}
			};
			if (kind === "manifest") add("manifest", fields.ManifestName);
			if (kind === "archive") add("archive", fields.ArchiveName, true);
			if (portable && fields.bImportLoc)
				add("archive", fields.ArchiveName, true, true, poCultures);
			if (portable && fields.bExportLoc)
				add(
					"po",
					fields.PortableObjectName,
					true,
					fields.bUseCultureDirectory ?? true,
					poCultures
				);
			if (kind === "compile") {
				add("locres", fields.ResourceName, true);
				if (!fields.ResourceName) throw localizationOperationError("unsupported_config");
				const resourceFilename = localizationRelativePath(fields.ResourceName)
					.split("/")
					.at(-1);
				if (!resourceFilename) throw localizationOperationError("unsupported_config");
				add("locmeta", `${resourceFilename.replace(/\.[^.]*$/u, "")}.locmeta`);
			}
			if (kind === "reports") {
				if (fields.bWordCountReport) add("word_count", fields.WordCountReportName);
				if (fields.bConflictReport) {
					let name = fields.ConflictReportName;
					if (request.engine === "5.8" && name && !/\.(?:txt|csv)$/u.test(name))
						name = `${name.replace(/\.[^./]*$/u, "")}.csv`;
					add("conflicts", name);
				}
			}
		}
	}
	const configs = recipes.map((recipe) => localizationRelativePath(recipe.relativePath));
	// GatherText resolves relative config paths against ProjectDir in all three supported engines.
	const argumentsList = [
		request.projectDescriptor,
		"-run=GatherText",
		`-Config=${configs.join(";")}`,
		"-unattended",
		"-nosplash",
		"-NullRHI",
		`-abslog=${request.logPath}`
	];
	return LocalizationOperationPlan.make({
		schemaVersion: 1,
		operation,
		target: target.name,
		engine: request.engine,
		projectDescriptor: request.projectDescriptor,
		logPath: request.logPath,
		configs,
		arguments: argumentsList,
		steps,
		files: [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
		wholeRecipe: target.source === "config_only",
		auditExcludedDirectories: [
			"Saved",
			"Intermediate",
			"DerivedDataCache",
			"Binaries",
			".git",
			".vs",
			"node_modules"
		]
	});
}

export function availableLocalizationOperations(
	target: LocalizationPlanningRequest["target"]
): readonly LocalizationOperation[] {
	return LocalizationOperation.literals.filter((operation) => {
		try {
			planLocalizationOperation({
				target,
				operation,
				engine: "5.7",
				projectDescriptor: "Project.uproject",
				logPath: "Commandlet.log"
			});
			return true;
		} catch (error) {
			if (error instanceof LocalizationOperationError) return false;
			throw error;
		}
	});
}
