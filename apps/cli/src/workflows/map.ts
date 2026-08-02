import { DateTime, Duration, Effect, Option, Schema } from "effect";
import { CliCommandError, CliRuntime, printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type MapHistoryCommand = Extract<CliCommand, { readonly _tag: "MapHistory" }>;

const DEFAULT_MAP_HISTORY_LIMITS = {
	maxChangelists: 1_000,
	maxConcurrency: 4,
	maxDurationMs: 5 * 60_000,
	maxMaterializedFiles: 10_000,
	maxPackages: 10_000
} as const;

export const runMapHistory = Effect.fn("Cli.workflow.map_history")((command: MapHistoryCommand) =>
	observeCliOperation(
		command._tag,
		Effect.gen(function* () {
			const runtime = yield* CliRuntime;
			const {
				mapHistoryLiveLayer,
				PerforceFastMapHistory,
				PerforceFastMapHistoryQuery,
				PerforceMapHistory,
				PerforceMapHistoryQuery,
				readPerforceFastMapHistory,
				readPerforceMapHistory,
				UtcTimestamp
			} = yield* Effect.promise(() => import("@ue-shed/map-history"));
			const decodeUtcTimestamp = Schema.decodeUnknownOption(UtcTimestamp);
			const until =
				command.until === undefined
					? yield* DateTime.now
					: Option.getOrElse(decodeUtcTimestamp(command.until), () => undefined);
			if (until === undefined) {
				return yield* Effect.fail(
					new CliCommandError({ message: "--until must be an ISO-8601 UTC timestamp." })
				);
			}
			const asTimestamp = decodeUtcTimestamp(command.since);
			const duration = Duration.fromInput(command.since as Duration.Input);
			const since = Option.isSome(asTimestamp)
				? asTimestamp.value
				: Option.isSome(duration) &&
					  Duration.isFinite(duration.value) &&
					  Duration.toMillis(duration.value) > 0
					? DateTime.subtractDuration(until, duration.value)
					: undefined;
			if (since === undefined) {
				return yield* Effect.fail(
					new CliCommandError({
						message:
							"--since must be an ISO-8601 UTC timestamp or a positive Effect duration such as '7 days'."
					})
				);
			}
			const limits = {
				maxChangelists: command.maxChangelists ?? DEFAULT_MAP_HISTORY_LIMITS.maxChangelists,
				maxConcurrency: command.concurrency ?? DEFAULT_MAP_HISTORY_LIMITS.maxConcurrency,
				maxDurationMs: command.maxDurationMs ?? DEFAULT_MAP_HISTORY_LIMITS.maxDurationMs,
				maxMaterializedFiles:
					command.maxMaterializedFiles ?? DEFAULT_MAP_HISTORY_LIMITS.maxMaterializedFiles,
				maxPackages: command.maxPackages ?? DEFAULT_MAP_HISTORY_LIMITS.maxPackages
			};
			const range = { since: DateTime.formatIso(since), until: DateTime.formatIso(until) };
			if ((command.mode ?? "deep") === "fast") {
				const target =
					command.actorClass !== undefined
						? { classPath: command.actorClass, kind: "actor_class" as const }
						: command.actorGuid !== undefined
							? {
									identity: {
										actorGuid: command.actorGuid,
										kind: "actor_guid" as const
									},
									kind: "actor" as const
								}
							: {
									identity: {
										actorPath: command.actorPath ?? "",
										kind: "object_path" as const,
										packageName: command.actorPackage ?? ""
									},
									kind: "actor" as const
								};
				const query = yield* Schema.decodeUnknownEffect(PerforceFastMapHistoryQuery)({
					limits,
					mapPath: command.mapPath,
					mode: "fast",
					projectRoot: command.projectRoot,
					range,
					target
				}).pipe(
					Effect.mapError(
						() =>
							new CliCommandError({
								message:
									"Fast History requires a valid range and Investigation Target."
							})
					)
				);
				const history = yield* readPerforceFastMapHistory(query).pipe(
					Effect.provide(mapHistoryLiveLayer)
				);
				const encoded = yield* Schema.encodeUnknownEffect(PerforceFastMapHistory)(
					history
				).pipe(
					Effect.mapError(
						() =>
							new CliCommandError({
								message: "Fast History produced an invalid output document."
							})
					)
				);
				yield* printJson(encoded);
				if (
					history.completeness === "partial" ||
					history.revisions.some(
						(revision) => revision.unclassifiedPackageChanges.length > 0
					)
				) {
					yield* runtime.setExitCode(3);
				}
				return;
			}
			const query = yield* Schema.decodeUnknownEffect(PerforceMapHistoryQuery)({
				limits,
				mapPath: command.mapPath,
				projectRoot: command.projectRoot,
				range
			}).pipe(
				Effect.mapError(
					() =>
						new CliCommandError({
							message: "Map History requires a range ending at or after its start."
						})
				)
			);
			const history = yield* readPerforceMapHistory(query).pipe(
				Effect.provide(mapHistoryLiveLayer)
			);
			const encoded = yield* Schema.encodeUnknownEffect(PerforceMapHistory)(history).pipe(
				Effect.mapError(
					() =>
						new CliCommandError({
							message: "Map History produced an invalid output document."
						})
				)
			);
			yield* printJson(encoded);
			if (
				history.completeness === "partial" ||
				history.revisions.some((revision) => revision.unclassifiedPackageChanges.length > 0)
			) {
				yield* runtime.setExitCode(3);
			}
		})
	)
);
