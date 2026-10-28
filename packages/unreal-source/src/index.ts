import { Effect } from "effect";
import type { GameTextContract } from "@ue-shed/protocol";
import { LocalizationEvidence, type LocalizationTarget } from "@ue-shed/localization";
import { answerJson, NativeGameTextEngineClient } from "@ue-shed/unreal-assets";

export type SourceTextRequest = GameTextContract.SourceTextRequest;
export type SourceTextResult = GameTextContract.SourceTextResult;
export type SourceTarget = GameTextContract.SourceTarget;
export type GatherStep = GameTextContract.GatherStep;
export type EngineLine = GameTextContract.EngineLine;
export type SourcePlace = GameTextContract.SourcePlace;
export type SourceDiagnostic = GameTextContract.SourceDiagnostic;

/** The commandlet behaviour a scan reproduces for an engine version; none before 4.27. */
export const engineLine = (major: number, minor: number): EngineLine | undefined =>
	major === 4 && minor === 27 ? "4.27" : major === 5 ? (minor <= 7 ? "5.7" : "5.8") : undefined;

/**
 * A target's `GatherTextFromSource` steps. A step without a value takes `CommonSettings`' value,
 * as Unreal's commandlets read their config.
 */
export const sourceSteps = (target: LocalizationTarget): GatherStep[] =>
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

export interface SourceTextInput {
	readonly projectRoot: string;
	/** The engine installation root, holding `Engine/`; without it engine wrappers are missing. */
	readonly engineRoot?: string | undefined;
	readonly engine: EngineLine;
	/** Only these targets; every target with a source step when absent or empty. */
	readonly targets?: readonly string[] | undefined;
	/** Where the engine's wrappers are kept between scans. */
	readonly cacheRoot?: string | undefined;
}

/**
 * Scans the project's source as each localization target's `GatherTextFromSource` steps would.
 * Targets come from the project's localization configs; the scan runs in the native engine,
 * so file contents never cross into the host.
 */
export const scanSourceText = Effect.fn("UnrealSource.scan")(function* (input: SourceTextInput) {
	const evidence = yield* LocalizationEvidence;
	const discovery = yield* evidence.discover({ projectRoot: input.projectRoot });
	const wanted =
		input.targets === undefined || input.targets.length === 0
			? undefined
			: new Set(input.targets);
	const targets: SourceTarget[] = discovery.targets
		.filter((target) => wanted === undefined || wanted.has(target.name))
		.map((target) => ({ name: target.name, steps: sourceSteps(target) }))
		.filter((target) => target.steps.length > 0);
	const engine = yield* NativeGameTextEngineClient;
	const answer = yield* engine.execute({
		action: "source_text",
		request: {
			projectRoot: input.projectRoot,
			engineRoot: input.engineRoot ?? null,
			engine: input.engine,
			targets,
			cacheRoot: input.cacheRoot ?? null,
			refreshEngineWrappers: false
		}
	});
	const result = answerJson<SourceTextResult>(answer);
	if (result === undefined)
		return yield* Effect.die("The engine answered source_text without a result.");
	yield* Effect.annotateCurrentSpan({
		"unrealSource.targets": result.targets.length,
		"unrealSource.places": result.targets.reduce(
			(count, target) => count + target.places.length,
			0
		),
		"unrealSource.engineWrappers": result.engineWrappers,
		"unrealSource.engineWrappersMicros": result.profile.engineWrappersMicros,
		"unrealSource.scanMicros": result.profile.scanMicros
	});
	return { result, configDiagnostics: discovery.diagnostics };
});
