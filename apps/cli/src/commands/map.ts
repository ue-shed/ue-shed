import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect } from "effect";
import { CliCommandError } from "../cli-runtime.js";
import { runMapHistory } from "../workflows/map.js";
import { optionalFlag, optionalValue, positiveIntegerFlag } from "./options.js";

const mapHistoryCommand = Command.make(
	"history",
	{
		projectRoot: Argument.string("project-root"),
		mapPath: Argument.string("map-path"),
		since: Flag.string("since"),
		until: optionalFlag("until"),
		mode: Flag.choice("mode", ["deep", "fast"]).pipe(Flag.optional),
		actorGuid: optionalFlag("actor-guid"),
		actorPackage: optionalFlag("actor-package"),
		actorPath: optionalFlag("actor-path"),
		actorClass: optionalFlag("actor-class"),
		maxChangelists: positiveIntegerFlag(
			"max-changelists",
			"--max-changelists requires a positive integer"
		).pipe(Flag.optional),
		maxPackages: positiveIntegerFlag(
			"max-packages",
			"--max-packages requires a positive integer"
		).pipe(Flag.optional),
		maxMaterializedFiles: positiveIntegerFlag(
			"max-materialized-files",
			"--max-materialized-files requires a positive integer"
		).pipe(Flag.optional),
		concurrency: positiveIntegerFlag(
			"concurrency",
			"--concurrency requires a positive integer"
		).pipe(Flag.optional),
		maxDurationMs: positiveIntegerFlag(
			"max-duration-ms",
			"--max-duration-ms requires a positive integer"
		).pipe(Flag.optional)
	},
	({
		projectRoot,
		mapPath,
		since,
		until,
		mode,
		actorGuid,
		actorPackage,
		actorPath,
		actorClass,
		maxChangelists,
		maxPackages,
		maxMaterializedFiles,
		concurrency,
		maxDurationMs
	}) => {
		const modeValue = optionalValue(mode);
		const actorGuidValue = optionalValue(actorGuid);
		const actorPackageValue = optionalValue(actorPackage);
		const actorPathValue = optionalValue(actorPath);
		const actorClassValue = optionalValue(actorClass);
		const untilValue = optionalValue(until);
		const concurrencyValue = optionalValue(concurrency);
		const maxChangelistsValue = optionalValue(maxChangelists);
		const maxDurationMsValue = optionalValue(maxDurationMs);
		const maxMaterializedFilesValue = optionalValue(maxMaterializedFiles);
		const maxPackagesValue = optionalValue(maxPackages);
		const hasActorTarget =
			actorGuidValue !== undefined ||
			actorPackageValue !== undefined ||
			actorPathValue !== undefined ||
			actorClassValue !== undefined;
		if ((modeValue ?? "deep") === "deep" && hasActorTarget) {
			return Effect.fail(
				new CliCommandError({
					message: "map history Investigation Target flags require --mode fast"
				})
			);
		}
		if (modeValue === "fast") {
			const hasGuidTarget = actorGuidValue !== undefined;
			const hasPathTarget = actorPackageValue !== undefined || actorPathValue !== undefined;
			const hasCompletePathTarget =
				actorPackageValue !== undefined && actorPathValue !== undefined;
			const targetKinds =
				Number(hasGuidTarget) +
				Number(hasCompletePathTarget) +
				Number(actorClassValue !== undefined);
			if (targetKinds !== 1 || (hasPathTarget && !hasCompletePathTarget)) {
				return Effect.fail(
					new CliCommandError({
						message:
							"map history --mode fast requires exactly one target: --actor-guid <guid>, --actor-package <package> with --actor-path <path>, or --actor-class <class-path>"
					})
				);
			}
		}
		return runMapHistory({
			_tag: "MapHistory",
			...(actorClassValue === undefined ? {} : { actorClass: actorClassValue }),
			...(actorGuidValue === undefined ? {} : { actorGuid: actorGuidValue }),
			...(actorPackageValue === undefined ? {} : { actorPackage: actorPackageValue }),
			...(actorPathValue === undefined ? {} : { actorPath: actorPathValue }),
			...(concurrencyValue === undefined ? {} : { concurrency: concurrencyValue }),
			mapPath,
			...(maxChangelistsValue === undefined ? {} : { maxChangelists: maxChangelistsValue }),
			...(maxDurationMsValue === undefined ? {} : { maxDurationMs: maxDurationMsValue }),
			...(maxMaterializedFilesValue === undefined
				? {}
				: { maxMaterializedFiles: maxMaterializedFilesValue }),
			...(maxPackagesValue === undefined ? {} : { maxPackages: maxPackagesValue }),
			...(modeValue === undefined ? {} : { mode: modeValue }),
			projectRoot,
			since,
			...(untilValue === undefined ? {} : { until: untilValue })
		});
	}
).pipe(Command.withDescription("Read Perforce-backed saved map history."));

export const mapCommand = Command.make("map").pipe(
	Command.withDescription("Inspect saved map history."),
	Command.withSubcommands([mapHistoryCommand])
);
