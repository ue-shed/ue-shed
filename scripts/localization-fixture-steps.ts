import { localDerivedDataCacheArguments } from "./unreal-plugin-host.ts";
import { dirname, join } from "node:path";

/**
 * Each entry is a fresh editor process, so every fixture stage reads the packages the previous one
 * saved. Consecutive GatherText operations share one process: GatherText splits `-config` on `;`
 * and runs every config's steps in its phase order (manifests, archives, export, compile, reports),
 * the order these operations would run in separately. Report steps are the exception: GatherText
 * runs them as parallel tasks of one final phase, so two configs that write the same report must
 * not share a process (Gather and GenerateReports both write the word count CSV, and racing on it
 * fails the rename). Export and Compile leave the manifests and archives unchanged, so the
 * gather's report is the same when GenerateReports runs after them. The engine matrix compares the
 * resulting evidence with the committed oracles on every engine. Never gather/export after the
 * final two mutations.
 */
export function localizationFixtureSteps(project: string, evidence: string) {
	const common = [
		project,
		"-unattended",
		"-nop4",
		...localDerivedDataCacheArguments,
		"-nosplash",
		"-NullRHI"
	];
	const stage = (name: string) => [
		...common,
		"-run=UEShedBuildFixture",
		"-LocalizationOnly",
		`-LocalizationStage=${name}`
	];
	const operations = (...names: readonly string[]) => [
		...common,
		"-run=GatherText",
		`-config=${names
			.map((name) =>
				join(dirname(project), "Config", "Localization", `FixtureGame_${name}.ini`)
			)
			.join(";")}`
	];
	return [
		stage("Initial"),
		operations("Gather"),
		stage("Translate"),
		operations("Export", "Compile"),
		stage("Outdate"),
		operations("Gather", "Export", "Compile"),
		operations("GenerateReports"),
		stage("Unsynced"),
		stage("AfterGather"),
		[
			...common,
			"-run=UEShedBuildFixture",
			"-LocalizationOnly",
			"-VerifyOnly",
			`-LocalizationEvidence=${evidence}`
		]
	];
}

/**
 * The `Game` target's problem cases (fixture README, "Game Text problem cases"), each entry a
 * fresh editor process. The final two stages edit a PO file and a saved package after the last
 * gather; nothing runs after them.
 */
export function gameTextProblemsFixtureSteps(project: string) {
	const common = [
		project,
		"-unattended",
		"-nop4",
		...localDerivedDataCacheArguments,
		"-nosplash",
		"-NullRHI"
	];
	const stage = (name: string) => [
		...common,
		"-run=UEShedBuildFixture",
		"-GameTextProblemsOnly",
		`-GameTextProblemsStage=${name}`
	];
	const operation = (name: string) => [
		...common,
		"-run=GatherText",
		`-config=${join(dirname(project), "Config", "Localization", `Game_${name}.ini`)}`
	];
	return [
		stage("Initial"),
		operation("Gather"),
		stage("Translate"),
		operation("Export"),
		operation("Compile"),
		stage("Outdate"),
		operation("Gather"),
		operation("Export"),
		operation("Compile"),
		operation("GenerateReports"),
		stage("Unsynced"),
		stage("AfterGather")
	];
}

/**
 * The `GameTextActions` target's identity cases (fixture README, "Game Text identity cases"), each
 * entry a fresh editor process. `Branch` copies package files without loading them, so the copy is
 * a plain file copy. Evidence is recorded last, from the saved packages.
 */
export function gameTextActionsFixtureSteps(project: string, evidence: string) {
	const common = [
		project,
		"-unattended",
		"-nop4",
		...localDerivedDataCacheArguments,
		"-nosplash",
		"-NullRHI"
	];
	const stage = (name: string, ...extra: string[]) => [
		...common,
		"-run=UEShedBuildFixture",
		"-GameTextActionsOnly",
		`-GameTextActionsStage=${name}`,
		...extra
	];
	const operation = (name: string) => [
		...common,
		"-run=GatherText",
		`-config=${join(dirname(project), "Config", "Localization", `GameTextActions_${name}.ini`)}`
	];
	return [
		stage("Author"),
		stage("CopyInPackage"),
		stage("DuplicateAssets"),
		stage("Branch"),
		stage("EditBranch"),
		stage("Slice2"),
		operation("Gather"),
		operation("GenerateReports"),
		// Gather-only C++ text, into its own manifest so the asset gather above stays unchanged.
		operation("Source"),
		stage("Evidence", `-GameTextActionsEvidence=${evidence}`)
	];
}
