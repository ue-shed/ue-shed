import { resolve } from "node:path";
import { ConfigExplorerNodeLive } from "@ue-shed/config-explorer";
import {
	buildInputAtlas,
	classifyInputConflicts,
	coActivationForPlatform,
	coActivationFromConfigAssets,
	defaultInputDeviceSets,
	discoverInputPlatforms,
	EnhancedInputService,
	EnhancedInputServiceLive,
	inputActionEdges,
	inputActionUsage,
	inputControlSheet,
	inputControlSheetCsv,
	inputControlSheetMarkdown,
	inputDeviceCoverage,
	inputKeyProfiles,
	platformContextPaths,
	readCoActivationDocument,
	readInputDeviceSetsDocument,
	resolveDefaultContextsFromConfig,
	resolvePlatformViews,
	scanBlueprintInputActionUses,
	type CoActivationSet,
	type CoActivationSourceStatus,
	type EnhancedInputReport
} from "@ue-shed/enhanced-input";
import { resolveScanTarget } from "@ue-shed/unreal-assets";
import { writeInvestigationFile } from "@ue-shed/unreal-assets/investigation-files";
import { Effect } from "effect";
import { observeCliOperation, readerLayer } from "../cli-operation.js";
import { CliCommandError, CliRuntime, isCliCommandError, json, printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";

type Command<Tag extends CliCommand["_tag"]> = Extract<CliCommand, { readonly _tag: Tag }>;

/**
 * Domain failures carry a message and recovery guidance; keep both. Reader configuration errors
 * carry only a message.
 */
interface GuidedFailure {
	readonly message: string;
	readonly recovery?: string;
	readonly retrySafe?: boolean;
}

const defaultRecovery =
	"Inspect the command context and original cause before deciding whether to retry.";

function cliFailure(error: GuidedFailure | CliCommandError): CliCommandError {
	if (isCliCommandError(error)) return error;
	const recovery = error.recovery ?? defaultRecovery;
	return new CliCommandError({
		cause: error,
		recovery,
		retrySafe: error.retrySafe ?? false,
		nextStep: "escalate",
		code: "cli_command_failed",
		message: error.recovery === undefined ? error.message : `${error.message} ${recovery}`
	});
}

/** Scans the project once. Every input command reads the same report. */
const scanReport = Effect.fn("Cli.input.scan")(
	function* (projectRoot: string, _reader?: string) {
		const target = yield* resolveScanTarget(projectRoot);
		const service = yield* EnhancedInputService;
		const report = yield* service.scan({
			projectRoot: target.projectRoot,
			...(target.paths.length > 0 ? { paths: target.paths } : undefined)
		});
		return { projectRoot: target.projectRoot, report };
	},
	(effect, _projectRoot, reader) =>
		effect.pipe(
			Effect.provide(EnhancedInputServiceLive),
			Effect.provide(readerLayer(reader)),
			Effect.mapError(cliFailure)
		)
);

function scanSummary(projectRoot: string, report: EnhancedInputReport) {
	return { projectRoot, status: report.status, coverage: report.coverage };
}

interface CoActivationOptions {
	readonly coActivation?: string;
	readonly platform?: string;
	readonly engineRoot?: string;
}

/**
 * Resolves the co-activation sources a command asked for. Config assets come free with the scan;
 * project defaults need `--platform`; a host document needs `--co-activation`.
 */
const coActivation = Effect.fn("Cli.input.coActivation")(function* (
	projectRoot: string,
	report: EnhancedInputReport,
	options: CoActivationOptions
) {
	const sets: CoActivationSet[] = [...coActivationFromConfigAssets(report)];
	const sources: CoActivationSourceStatus[] = [
		sets.length > 0
			? {
					source: "config_asset",
					status: "resolved",
					sets: sets.length,
					detail: "Player mappable input config assets in the scan."
				}
			: {
					source: "config_asset",
					status: "absent",
					detail: "The scan found no config asset with readable contexts."
				}
	];
	if (options.platform !== undefined) {
		const resolved = yield* resolveDefaultContextsFromConfig({
			project: projectRoot,
			platform: options.platform,
			...(options.engineRoot === undefined ? undefined : { engineRoot: options.engineRoot })
		}).pipe(Effect.provide(ConfigExplorerNodeLive));
		sets.push(...resolved.sets);
		sources.push(resolved.status);
	} else {
		sources.push({
			source: "project_default_contexts",
			status: "absent",
			detail: "Pass --platform to read the project's default contexts from config."
		});
	}
	if (options.coActivation !== undefined) {
		const resolved = yield* readCoActivationDocument(resolve(options.coActivation)).pipe(
			Effect.mapError(cliFailure)
		);
		sets.push(...resolved.sets);
		sources.push(resolved.status);
	} else {
		sources.push({
			source: "host_document",
			status: "absent",
			detail: "Pass --co-activation <file> to add host-declared sets."
		});
	}
	return { sets: coActivationForPlatform(sets, options.platform), sources };
});

function coActivationOptions(command: CoActivationOptions): CoActivationOptions {
	return {
		...(command.coActivation === undefined
			? undefined
			: { coActivation: command.coActivation }),
		...(command.platform === undefined ? undefined : { platform: command.platform }),
		...(command.engineRoot === undefined ? undefined : { engineRoot: command.engineRoot })
	};
}

export const runInputAtlas = Effect.fn("Cli.workflow.input_atlas")(
	(command: Command<"InputAtlas">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { projectRoot, report } = yield* scanReport(
					command.projectRoot,
					command.reader
				);
				return yield* printJson({
					schemaVersion: 1,
					kind: "enhanced_input_atlas",
					...scanSummary(projectRoot, report),
					atlas: buildInputAtlas(report),
					edges: inputActionEdges(report),
					diagnostics: report.diagnostics
				});
			})
		)
);

export const runInputConflicts = Effect.fn("Cli.workflow.input_conflicts")(
	(command: Command<"InputConflicts">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { projectRoot, report } = yield* scanReport(
					command.projectRoot,
					command.reader
				);
				const resolved = yield* coActivation(
					projectRoot,
					report,
					coActivationOptions(command)
				);
				const analysis = classifyInputConflicts(report, resolved.sets);
				return yield* printJson({
					schemaVersion: 1,
					kind: "enhanced_input_conflicts",
					...scanSummary(projectRoot, report),
					...(command.platform === undefined
						? undefined
						: { platform: command.platform }),
					sources: resolved.sources,
					...analysis
				});
			})
		)
);

export const runInputUnused = Effect.fn("Cli.workflow.input_unused")(
	(command: Command<"InputUnused">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { projectRoot, report } = yield* scanReport(
					command.projectRoot,
					command.reader
				);
				const blueprints = command.blueprints
					? yield* scanBlueprintInputActionUses(report, {
							projectRoot,
							maximumBlueprints: command.maximumBlueprints
						}).pipe(
							Effect.provide(readerLayer(command.reader)),
							Effect.mapError(cliFailure)
						)
					: undefined;
				return yield* printJson({
					schemaVersion: 1,
					kind: "enhanced_input_usage",
					...scanSummary(projectRoot, report),
					...inputActionUsage(
						report,
						blueprints === undefined
							? undefined
							: {
									blueprintUses: blueprints.uses,
									blueprintCoverage: blueprints.coverage
								}
					)
				});
			})
		)
);

export const runInputPlatforms = Effect.fn("Cli.workflow.input_platforms")(
	(command: Command<"InputPlatforms">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { projectRoot, report } = yield* scanReport(
					command.projectRoot,
					command.reader
				);
				const platforms =
					command.platforms.length > 0
						? command.platforms
						: yield* discoverInputPlatforms(projectRoot).pipe(
								Effect.mapError(cliFailure)
							);
				const views = yield* resolvePlatformViews({
					project: projectRoot,
					projectRoot,
					platforms,
					...(command.engineRoot === undefined
						? undefined
						: { engineRoot: command.engineRoot })
				}).pipe(
					Effect.provide(ConfigExplorerNodeLive),
					Effect.provide(readerLayer(command.reader))
				);
				const deviceSets =
					command.deviceSets === undefined
						? defaultInputDeviceSets
						: yield* readInputDeviceSetsDocument(resolve(command.deviceSets)).pipe(
								Effect.mapError(cliFailure)
							);
				return yield* printJson({
					schemaVersion: 1,
					kind: "enhanced_input_platforms",
					...scanSummary(projectRoot, report),
					platforms: views.map((view) => ({
						...view,
						contexts: platformContextPaths(report, view.redirects)
					})),
					keyProfiles: inputKeyProfiles(report),
					deviceSets,
					deviceCoverage: inputDeviceCoverage(report, deviceSets)
				});
			})
		)
);

export const runInputExport = Effect.fn("Cli.workflow.input_export")(
	(command: Command<"InputExport">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { projectRoot, report } = yield* scanReport(
					command.projectRoot,
					command.reader
				);
				const resolved = yield* coActivation(
					projectRoot,
					report,
					coActivationOptions(command)
				);
				const document = inputControlSheet(
					report,
					{
						projectRoot: resolve(projectRoot),
						generation: null,
						authority: "project_files"
					},
					{ conflicts: classifyInputConflicts(report, resolved.sets) }
				);
				const contents =
					command.format === "csv"
						? inputControlSheetCsv(document)
						: command.format === "markdown"
							? inputControlSheetMarkdown(document)
							: json(document);
				if (command.output !== undefined) {
					yield* writeInvestigationFile(command.output, contents).pipe(
						Effect.mapError(cliFailure)
					);
					return;
				}
				const runtime = yield* CliRuntime;
				yield* runtime.print(contents);
			})
		)
);
