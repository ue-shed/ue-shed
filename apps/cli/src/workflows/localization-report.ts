import { Effect, FileSystem, Metric, Result, Schema } from "effect";
import { LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import {
	LocalizationBaseline,
	LocalizationReportError,
	createLocalizationBaseline,
	decodeLocalizationBaselineJson,
	localizationProgressReport
} from "@ue-shed/game-text/corpus";
import { observeCliOperation } from "../cli-operation.js";
import { CliRuntime, printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";
import { loadLocalizationContext } from "./localization.js";

const isLocalizationReportError = Schema.is(LocalizationReportError);

export class LocalizationBaselineIOError extends Schema.TaggedError<LocalizationBaselineIOError>()(
	"LocalizationBaselineIOError",
	{
		retrySafe: Schema.Boolean,
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
		cause: Schema.optionalKey(Schema.Defect()),
		code: Schema.Literals([
			"baseline_exists",
			"baseline_unreadable",
			"baseline_unwritable",
			"invalid_baseline_destination",
			"baseline_limit"
		]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}
function ioError(
	code: LocalizationBaselineIOError["code"],
	cause?: unknown
): LocalizationBaselineIOError {
	return new LocalizationBaselineIOError({
		...(cause === undefined ? undefined : { cause }),
		retrySafe: false,
		nextStep: "fix_input",
		code,
		message: "The localization baseline file operation could not complete.",
		recovery:
			"Use a readable baseline under 32 MiB, or a new .json destination in a writable directory. Existing files are never overwritten."
	});
}
export const writeLocalizationBaseline = Effect.fn("Cli.localization.write_baseline")(function* (
	destination: string,
	baseline: LocalizationBaseline
) {
	if (!destination.toLowerCase().endsWith(".json"))
		return yield* Effect.fail(ioError("invalid_baseline_destination"));
	const fs = yield* FileSystem.FileSystem;
	const json = yield* Schema.encodeEffect(Schema.fromJsonString(LocalizationBaseline))(
		baseline
	).pipe(Effect.mapError((cause) => ioError("baseline_unwritable", cause)));
	if (new TextEncoder().encode(json).length > 32 * 1024 * 1024)
		return yield* Effect.fail(ioError("baseline_limit"));
	yield* fs
		.writeFileString(destination, `${json}\n`, { flag: "wx" })
		.pipe(
			Effect.mapError((error) =>
				ioError(
					error.reason._tag === "AlreadyExists"
						? "baseline_exists"
						: "baseline_unwritable",
					error
				)
			)
		);
});
export const readLocalizationBaseline = Effect.fn("Cli.localization.read_baseline")(function* (
	path: string
) {
	const fs = yield* FileSystem.FileSystem;
	const stat = yield* fs
		.stat(path)
		.pipe(Effect.mapError((cause) => ioError("baseline_unreadable", cause)));
	if (stat.size > 32 * 1024 * 1024) return yield* Effect.fail(ioError("baseline_limit"));
	const bytes = yield* fs
		.readFile(path)
		.pipe(Effect.mapError((cause) => ioError("baseline_unreadable", cause)));
	if (bytes.length > 32 * 1024 * 1024) return yield* Effect.fail(ioError("baseline_limit"));
	const text = yield* Effect.try({
		try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		catch: (cause) =>
			new LocalizationReportError({
				cause,
				retrySafe: false,
				nextStep: "fix_input",
				code: "invalid_baseline",
				message: "The baseline is not valid UTF-8.",
				recovery: "Regenerate a version-1 baseline as UTF-8 JSON."
			})
	});
	const decoded = decodeLocalizationBaselineJson(text);
	if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
	return decoded.success;
});
export const runLocalizationReport = Effect.fn("Cli.workflow.localization_report")(
	(command: Extract<CliCommand, { readonly _tag: "LocalizationReport" }>) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const result = yield* Effect.gen(function* () {
					const { corpus, join, evidence } = yield* loadLocalizationContext(command);
					const baseline = command.baseline
						? yield* readLocalizationBaseline(command.baseline)
						: undefined;
					const report = yield* Effect.try({
						try: () => localizationProgressReport(corpus, join, evidence, baseline),
						catch: (error) =>
							isLocalizationReportError(error)
								? error
								: new LocalizationReportError({
										cause: error,
										retrySafe: false,
										nextStep: "fix_input",
										code: "invalid_report_context",
										message:
											"The localization report could not be constructed.",
										recovery: "Refresh corpus and target evidence and retry."
									})
					});
					if (command.saveBaseline !== undefined) {
						const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
						const snapshot = yield* Effect.try({
							try: () =>
								createLocalizationBaseline(
									corpus,
									evidence,
									new Date(now).toISOString()
								),
							catch: (error) =>
								isLocalizationReportError(error)
									? error
									: new LocalizationReportError({
											cause: error,
											retrySafe: false,
											nextStep: "fix_input",
											code: "invalid_baseline",
											message: "The baseline could not be constructed.",
											recovery: "Refresh manifest evidence and retry."
										})
						});
						yield* writeLocalizationBaseline(command.saveBaseline, snapshot);
					}
					yield* Metric.update(
						Metric.counter("cli.localization.report.cultures"),
						report.cultures.length
					);
					return report;
				}).pipe(Effect.provide(LocalizationEvidenceNodeLive), Effect.result);
				if (Result.isFailure(result)) {
					yield* printJson({ schemaVersion: 1, status: "failed", error: result.failure });
					const runtime = yield* CliRuntime;
					yield* runtime.setExitCode(2);
					return;
				}
				yield* printJson(result.success);
			})
		)
);
