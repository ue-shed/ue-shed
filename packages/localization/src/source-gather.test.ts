import { describe, expect, it } from "@effect/vitest";
import { LocalizationTarget } from "./schema.js";
import { parseLocalizationRecipe } from "./index.js";
import { Result, Schema } from "effect";
import { sourceGatherEngine, sourceGatherSteps } from "./source-gather.js";

const recipe = (text: string) => {
	const parsed = parseLocalizationRecipe(text, "Config/Localization/Game_Gather.ini");
	if (Result.isFailure(parsed)) throw new Error("The recipe did not parse.");
	return parsed.success;
};

const target = (text: string): LocalizationTarget =>
	Schema.decodeUnknownSync(LocalizationTarget)({
		name: "Game",
		source: "config_only",
		nativeCulture: "en",
		cultures: ["en"],
		configs: [recipe(text)],
		outputPaths: {
			manifest: null,
			archives: {},
			portableObjects: {},
			resources: {},
			locmeta: null,
			wordCount: null,
			conflicts: null
		},
		poFormat: "Unreal",
		collapseMode: "IdenticalTextIdAndSource"
	});

describe("sourceGatherSteps", () => {
	it("takes CommonSettings for what a source step leaves out", () => {
		const steps = sourceGatherSteps(
			target(`[CommonSettings]
SearchDirectoryPaths=%LOCPROJECTROOT%Source
ExcludePathFilters=Config/Localization/*
FileNameFilters=*.h
ShouldGatherFromEditorOnlyData=true

[GatherTextStep0]
CommandletClass=GatherTextFromSource
FileNameFilters=*.cpp
FileNameFilters=*.ini

[GatherTextStep1]
CommandletClass=GatherTextFromAssets
SearchDirectoryPaths=%LOCPROJECTROOT%Content

[GatherTextStep2]
CommandletClass=gathertextfromsource
SearchDirectoryPaths=%LOCPROJECTROOT%Plugins
ShouldGatherFromEditorOnlyData=false
`)
		);
		expect(steps).toEqual([
			{
				searchDirectoryPaths: ["%LOCPROJECTROOT%Source"],
				excludePathFilters: ["Config/Localization/*"],
				fileNameFilters: ["*.cpp", "*.ini"],
				gatherEditorOnly: true
			},
			{
				searchDirectoryPaths: ["%LOCPROJECTROOT%Plugins"],
				excludePathFilters: ["Config/Localization/*"],
				fileNameFilters: ["*.h"],
				gatherEditorOnly: false
			}
		]);
	});
});

describe("sourceGatherEngine", () => {
	it("maps engine versions to the commandlet behaviour a scan reproduces", () => {
		expect(sourceGatherEngine(4, 27)).toBe("4.27");
		expect(sourceGatherEngine(4, 26)).toBeUndefined();
		expect(sourceGatherEngine(5, 3)).toBe("5.7");
		expect(sourceGatherEngine(5, 7)).toBe("5.7");
		expect(sourceGatherEngine(5, 8)).toBe("5.8");
	});
});
