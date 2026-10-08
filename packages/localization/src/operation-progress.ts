import {
	LocalizationProgress,
	LocalizationOperationError,
	type LocalizationOperationPlan
} from "./operation-schema.js";
import { localizationOperationError } from "./operation-plan.js";

/** Parse only commandlet boundary records; never emit authored log text as progress. */
export function parseLocalizationProgress(
	line: string,
	plan: LocalizationOperationPlan,
	activeConfig?: string
): LocalizationProgress | null {
	if (!line.includes("LogGatherTextCommandlet:")) return null;
	const modern =
		/Executing (\w+)Commandlet(?: (took) [\d.]+ seconds)? \(params:.*-Section=GatherTextStep(\d+)/u.exec(
			line
		);
	const legacy = /(Executing|Completed) GatherTextStep(\d+): (\w+)Commandlet/u.exec(line);
	if (!modern && !legacy) return null;
	const command = modern?.[1] ?? legacy?.[3];
	const section = Number(modern?.[3] ?? legacy?.[2]);
	const phase = modern?.[2] || legacy?.[1] === "Completed" ? "completed" : "started";
	const config =
		/-Config="([^"]+)"/u.exec(line)?.[1] ??
		/-Config=([^\s)]+)/u.exec(line)?.[1] ??
		activeConfig;
	const candidates = plan.steps.filter(
		(step) =>
			step.sectionIndex === section &&
			step.commandletClass === command &&
			(config === undefined || config.replaceAll("\\", "/").endsWith(step.config))
	);
	if (candidates.length !== 1) return null;
	const step = candidates[0];
	if (!step) return null;
	return LocalizationProgress.make({
		schemaVersion: 1,
		type: "progress",
		phase,
		stepIndex: step.index,
		stepTotal: plan.steps.length,
		kind: step.kind
	});
}

/** Private excerpts belong to the explicit failure value, never its safe message or telemetry. */
export function localizationExitFailure(
	exitCode: number | null,
	lines: readonly string[],
	logPath: string
): LocalizationOperationError {
	const excerpt = lines.slice(-40).map((line) => line.slice(0, 2048));
	const locked = excerpt.some((line) =>
		/sharing violation|being used by another process/iu.test(line)
	);
	const error = localizationOperationError(locked ? "project_locked" : "commandlet_failed");
	return new LocalizationOperationError({
		code: error.code,
		message: error.message,
		recovery: error.recovery,
		retrySafe: false,
		logExcerpt: excerpt,
		logPath,
		exitCode
	});
}
