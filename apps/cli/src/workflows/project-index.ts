import {
	AssetReader,
	PROJECT_INDEX_MAX_PAGE_SIZE,
	ProjectIndex,
	ProjectIndexCursor,
	ProjectIndexQuery,
	projectIndexProcessLayerFromReader
} from "@ue-shed/unreal-assets";
import { Effect, Layer, Stream } from "effect";
import { CliCommandError, messageOf, printJson } from "../cli-runtime.js";
import { observeCliOperation, readerLayer } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type Command<Tag extends CliCommand["_tag"]> = Extract<CliCommand, { readonly _tag: Tag }>;
type TargetCommand = Command<
	| "ProjectIndexStatus"
	| "ProjectIndexRefresh"
	| "ProjectIndexRebuild"
	| "ProjectIndexMaps"
	| "ProjectIndexQuery"
>;

function projectIndexLayer(command: TargetCommand) {
	return Layer.unwrap(
		Effect.gen(function* () {
			const reader = yield* AssetReader;
			const configuration = yield* reader.configuration();
			return projectIndexProcessLayerFromReader({
				...configuration,
				cacheRoot: command.cacheRoot
			});
		})
	).pipe(Layer.provide(readerLayer(command.reader)));
}

function mapError(cause: unknown): CliCommandError {
	return new CliCommandError({ message: messageOf(cause) });
}

function withIndex<A, E>(command: TargetCommand, effect: Effect.Effect<A, E, ProjectIndex>) {
	return effect.pipe(Effect.provide(projectIndexLayer(command)), Effect.mapError(mapError));
}

const readySummary = Effect.fn("Cli.project_index.ready_summary")(function* (projectRoot: string) {
	const index = yield* ProjectIndex;
	const status = yield* index.status({ projectRoot });
	if (status.status === "absent") {
		return yield* new CliCommandError({
			message: "Project Index is absent; run project-index refresh first."
		});
	}
	return status.summary;
});

export const runProjectIndexStatus = Effect.fn("Cli.workflow.project_index_status")(
	(command: Command<"ProjectIndexStatus">) =>
		observeCliOperation(
			command._tag,
			withIndex(
				command,
				Effect.flatMap(ProjectIndex, (index) =>
					index.status({ projectRoot: command.projectRoot })
				)
			).pipe(Effect.flatMap(printJson))
		)
);

function runMutation(command: Command<"ProjectIndexRefresh"> | Command<"ProjectIndexRebuild">) {
	return observeCliOperation(
		command._tag,
		withIndex(
			command,
			Effect.flatMap(ProjectIndex, (index) =>
				(command._tag === "ProjectIndexRefresh" ? index.refresh : index.rebuild)({
					projectRoot: command.projectRoot
				}).pipe(
					Stream.runCollect,
					Effect.map((events) => Array.from(events))
				)
			)
		).pipe(Effect.flatMap(printJson))
	);
}

export const runProjectIndexRefresh = Effect.fn("Cli.workflow.project_index_refresh")(
	(command: Command<"ProjectIndexRefresh">) => runMutation(command)
);

export const runProjectIndexRebuild = Effect.fn("Cli.workflow.project_index_rebuild")(
	(command: Command<"ProjectIndexRebuild">) => runMutation(command)
);

function pageBase(command: Command<"ProjectIndexMaps"> | Command<"ProjectIndexQuery">) {
	if (command.limit > PROJECT_INDEX_MAX_PAGE_SIZE) {
		return Effect.fail(
			new CliCommandError({
				message: `--limit cannot exceed ${PROJECT_INDEX_MAX_PAGE_SIZE}.`
			})
		);
	}
	return Effect.gen(function* () {
		const summary = yield* readySummary(command.projectRoot);
		return {
			expectedGeneration: summary.generation,
			limit: command.limit,
			projectId: summary.projectId,
			...(command.cursor === undefined
				? undefined
				: { cursor: ProjectIndexCursor.make(command.cursor) })
		};
	});
}

export const runProjectIndexMaps = Effect.fn("Cli.workflow.project_index_maps")(
	(command: Command<"ProjectIndexMaps">) =>
		observeCliOperation(
			command._tag,
			withIndex(
				command,
				Effect.gen(function* () {
					const index = yield* ProjectIndex;
					return yield* index.query(
						ProjectIndexQuery.cases.Maps.make(yield* pageBase(command))
					);
				})
			).pipe(Effect.flatMap(printJson))
		)
);

export const runProjectIndexQuery = Effect.fn("Cli.workflow.project_index_query")(
	(command: Command<"ProjectIndexQuery">) =>
		observeCliOperation(
			command._tag,
			withIndex(
				command,
				Effect.gen(function* () {
					const index = yield* ProjectIndex;
					const base = yield* pageBase(command);
					const request = (() => {
						switch (command.kind) {
							case "exact-class":
								return ProjectIndexQuery.cases.ExactClasses.make({
									...base,
									values: command.values
								});
							case "class-prefix":
								return ProjectIndexQuery.cases.ClassPrefixes.make({
									...base,
									values: command.values
								});
							case "class-name-suffix":
								return ProjectIndexQuery.cases.ClassNameSuffixes.make({
									...base,
									values: command.values
								});
							case "serialized-name":
								return ProjectIndexQuery.cases.SerializedNames.make({
									...base,
									values: command.values
								});
						}
					})();
					return yield* index.query(request);
				})
			).pipe(Effect.flatMap(printJson))
		)
);
