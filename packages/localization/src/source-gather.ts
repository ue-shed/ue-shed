import { EngineInstallationDiscovery } from "@ue-shed/engine";
import type { GameTextContract } from "@ue-shed/protocol";
import { Effect, Option } from "effect";
import { localizationProjectDescriptor } from "./operation-io.js";
import type { LocalizationTarget } from "./schema.js";

/** The `GatherTextFromSource` behaviour a code scan reproduces: 4.27, 5.0 to 5.7, or 5.8. */
export type SourceGatherEngine = GameTextContract.EngineLine;

/** The source gather behaviour of an engine version; none before 4.27. */
export const sourceGatherEngine = (major: number, minor: number): SourceGatherEngine | undefined =>
	major === 4 && minor === 27 ? "4.27" : major === 5 ? (minor <= 7 ? "5.7" : "5.8") : undefined;

/**
 * A target's `GatherTextFromSource` steps. A step without a value takes `CommonSettings`' value,
 * as Unreal's commandlets read their config.
 */
export const sourceGatherSteps = (target: LocalizationTarget): GameTextContract.GatherStep[] =>
	target.configs.flatMap((recipe) =>
		recipe.steps
			.filter((step) => step.commandletClass.toLowerCase() === "gathertextfromsource")
			.map((step) => {
				const list = (
					field: "SearchDirectoryPaths" | "ExcludePathFilters" | "FileNameFilters"
				) => (step.fields[field].length > 0 ? step.fields[field] : recipe.common[field]);
				const editorOnly =
					step.fields.ShouldGatherFromEditorOnlyData ??
					recipe.common.ShouldGatherFromEditorOnlyData;
				return {
					searchDirectoryPaths: list("SearchDirectoryPaths"),
					excludePathFilters: list("ExcludePathFilters"),
					fileNameFilters: list("FileNameFilters"),
					gatherEditorOnly: editorOnly === true
				};
			})
	);

/**
 * The engine a project's code is read with: the installation its `.uproject` association names
 * (or `explicitRoot`), as the editor would open it. Undefined when that engine is not installed,
 * is older than 4.27, or the folder holds no single `.uproject`; the reason is on the span.
 */
export const projectSourceGatherEngine = Effect.fn("Localization.sourceGatherEngine")(function* (
	projectRoot: string,
	explicitRoot?: string
) {
	const discovery = yield* EngineInstallationDiscovery;
	const descriptor = yield* Effect.tryPromise({
		try: () => localizationProjectDescriptor(projectRoot),
		catch: (cause) => cause
	}).pipe(Effect.option);
	if (Option.isNone(descriptor)) {
		yield* Effect.annotateCurrentSpan({ "code.unavailable": "no single .uproject" });
		return undefined;
	}
	const installation = yield* discovery
		.resolve({
			projectDescriptor: descriptor.value,
			...(explicitRoot === undefined ? undefined : { explicitRoot })
		})
		.pipe(Effect.option);
	if (Option.isNone(installation)) {
		yield* Effect.annotateCurrentSpan({ "code.unavailable": "engine not installed" });
		return undefined;
	}
	const engine = sourceGatherEngine(
		installation.value.version.major,
		installation.value.version.minor
	);
	if (engine === undefined) {
		yield* Effect.annotateCurrentSpan({ "code.unavailable": "engine older than 4.27" });
		return undefined;
	}
	return { engine, engineRoot: installation.value.root };
});
