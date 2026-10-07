import { dirname, join } from "node:path";

// Each entry is a fresh editor process. Never gather/export after the final two mutations.
export function localizationFixtureSteps(project: string, evidence: string) {
	const common = [project, "-unattended", "-nop4", "-nosplash", "-NullRHI"];
	const stage = (name: string) => [
		...common,
		"-run=UEShedBuildFixture",
		"-LocalizationOnly",
		`-LocalizationStage=${name}`
	];
	const operation = (name: string) => [
		...common,
		"-run=GatherText",
		`-config=${join(dirname(project), "Config", "Localization", `FixtureGame_${name}.ini`)}`
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
