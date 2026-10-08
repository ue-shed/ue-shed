import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CultureCode, defaultLocalizationLimits } from "./schema.js";
import {
	discoverLocalizationTargets,
	parseDashboardTargets,
	parseLocalizationRecipe,
	parseStructText
} from "./targets.js";

const project = resolve("fixtures/unreal-project");
const legacy = resolve("fixtures/unreal-427-localization");
const culture = Schema.decodeUnknownSync(CultureCode);
const editor = readFileSync(resolve(project, "Config/DefaultEditor.ini"), "utf8");
const configs = readdirSync(resolve(project, "Config/Localization"))
	.filter((name) => name.endsWith(".ini"))
	.map((name) => ({
		relativePath: `Config/Localization/${name}`,
		text: readFileSync(resolve(project, "Config/Localization", name), "utf8")
	}));

function success<A, E>(result: Result.Result<A, E>): A {
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
}

describe("Unreal target settings and recipes", () => {
	it("reads the real remove/add Dashboard file and its native-index sentinel", () => {
		const parsed = success(parseDashboardTargets(editor));
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.targets.map((target) => target.name)).toEqual(["Game", "FixtureGame"]);
		expect(parsed.targets[0]?.nativeCulture).toBeNull();
		const target = parsed.targets[1];
		expect(target?.nativeCulture).toBe("en");
		expect(target?.cultures).toEqual(["en", "de", "fr"]);
		expect(target?.settings.GatherFromTextFiles.SearchDirectories).toEqual([
			{ Path: "Source/UEShedFixture" }
		]);
		expect(target?.settings.GatherFromPackages.IncludePathWildcards).toEqual([
			{ Pattern: "Content/Fixture/Localization/*" }
		]);
		expect(target?.settings.GatherFromPackages.ExcludePathWildcards).toEqual([
			{ Pattern: "Content/L10N/*" }
		]);
		expect(target?.settings.ExportSettings?.ShouldPersistCommentsOnExport).toBe(true);
		expect(target?.settings.CompileSettings?.ValidateFormatPatterns).toBe(true);
		expect(Object.isFrozen(parsed.targets)).toBe(true);
	});

	it("reuses INI +, -, ., ! operations over actual fixture struct text", () => {
		const fixture = editor
			.split(/\r?\n/u)
			.find((line) => line.startsWith('+GameTargetsSettings=(Name="FixtureGame"'))
			?.slice(1);
		expect(fixture).toBeDefined();
		const section = "[/Script/Localization.LocalizationSettings]\n";
		const duplicated = success(
			parseDashboardTargets(`${section}+${fixture}\n+${fixture}\n.${fixture}\n-${fixture}\n`)
		);
		expect(duplicated.targets).toHaveLength(1);
		expect(
			success(
				parseDashboardTargets(`${section}+${fixture}\n!GameTargetsSettings=ClearArray\n`)
			).targets
		).toEqual([]);
		expect(
			success(parseDashboardTargets(`${section}+${fixture}\n-${fixture}\n+${fixture}\n`))
				.targets
		).toHaveLength(1);
	});

	it("discovers all five generated operation recipes without inferring commandlets from names", () => {
		const discovery = success(discoverLocalizationTargets({ dashboardText: editor, configs }));
		expect(discovery.diagnostics).toEqual([]);
		const target = discovery.targets.find((item) => item.name === "FixtureGame");
		expect(target?.source).toBe("dashboard_settings");
		expect(target?.configs).toHaveLength(5);
		expect(
			target?.configs
				.find((recipe) => recipe.relativePath.endsWith("_Gather.ini"))
				?.steps.map((step) => step.commandletClass)
		).toEqual([
			"GatherTextFromSource",
			"GatherTextFromAssets",
			"GenerateGatherManifest",
			"GenerateGatherArchive",
			"GenerateTextLocalizationReport"
		]);
		expect(target?.outputPaths.portableObjects[culture("fr")]).toBe(
			"Content/Localization/FixtureGame/fr/FixtureGame.po"
		);
		expect(target?.outputPaths.wordCount).toBe(
			"Content/Localization/FixtureGame/FixtureGame.csv"
		);
	});

	it("describes a config-only 4.27 target with PO/resource names on steps", () => {
		const text = readFileSync(resolve(legacy, "Config/Localization/Fixture427.ini"), "utf8");
		const config = { relativePath: "Config/Localization/Fixture427.ini", text };
		const discovery = success(discoverLocalizationTargets({ configs: [config] }));
		expect(discovery.diagnostics).toEqual([]);
		const target = discovery.targets[0];
		expect(target?.name).toBe("Fixture427");
		expect(target?.source).toBe("config_only");
		expect(target?.dashboard).toBeUndefined();
		expect(target?.nativeCulture).toBe("en");
		expect(target?.cultures).toEqual(["en", "de", "fr"]);
		expect(target?.configs[0]?.steps[0]?.fields.SearchDirectoryPaths).toEqual([
			"FixtureSource"
		]);
		expect(target?.outputPaths.resources[culture("de")]).toBe(
			"Content/Localization/Fixture427/de/Fixture427.locres"
		);
		expect(target?.outputPaths.portableObjects[culture("fr")]).toBe(
			"Content/Localization/Fixture427/fr/Fixture427.po"
		);
	});

	it("retains malformed target failures while reading the other targets", () => {
		const parsed = success(
			parseDashboardTargets(`${editor}\n+GameTargetsSettings=(Name="Broken",Unknown=True)\n`)
		);
		expect(parsed.targets).toHaveLength(2);
		expect(parsed.diagnostics[0]?.error.code).toBe("malformed_struct");
		const unknown = success(
			parseDashboardTargets(
				editor.replace('Name="FixtureGame",', 'Unknown=True,Name="FixtureGame",')
			)
		);
		expect(unknown.targets).toHaveLength(1);
		expect(unknown.diagnostics[0]?.error.code).toBe("malformed_struct");
	});

	it("reads separate export destinations and explicitly disabled culture directories", () => {
		const text = readFileSync(resolve(legacy, "Config/Localization/Fixture427.ini"), "utf8");
		const gather = text.replace(/\[GatherTextStep3\][\s\S]*$/u, "");
		const exportRecipe = `[CommonSettings]
SourcePath=Content/Localization/Fixture427
DestinationPath=Translations
ManifestName=Fixture427.manifest
ArchiveName=Fixture427.archive
CulturesToGenerate=fr
[GatherTextStep0]
CommandletClass=InternationalizationExport
bExportLoc=true
bUseCultureDirectory=false
PortableObjectName=Fixture427.fr.po
`;
		const discovery = success(
			discoverLocalizationTargets({
				configs: [
					{ relativePath: "Config/Localization/Fixture427.ini", text: gather },
					{
						relativePath: "Config/Localization/Fixture427_Export_fr.ini",
						text: exportRecipe
					}
				]
			})
		);
		expect(discovery.diagnostics).toEqual([]);
		expect(discovery.targets[0]?.outputPaths.manifest).toBe(
			"Content/Localization/Fixture427/Fixture427.manifest"
		);
		expect(discovery.targets[0]?.outputPaths.portableObjects[culture("fr")]).toBe(
			"Translations/Fixture427.fr.po"
		);
		expect(discovery.targets[0]?.outputPaths.portableObjects[culture("en")]).toBeUndefined();
	});

	it("rejects malformed text, unsupported selected INI syntax, invalid index and bounded input", () => {
		expect(parseStructText('(Name="unterminated)')._tag).toBe("Failure");
		expect(parseStructText("(Name=One)junk")._tag).toBe("Failure");
		expect(parseStructText("(Name=One,Name=Two)")._tag).toBe("Failure");
		expect(
			parseStructText("(".repeat(80), { ...defaultLocalizationLimits, maxDepth: 4 })._tag
		).toBe("Failure");
		expect(
			parseStructText(editor, { ...defaultLocalizationLimits, maxFileBytes: 8 })._tag
		).toBe("Failure");
		expect(
			parseDashboardTargets(
				"[/Script/Localization.LocalizationSettings]\n+GameTargetsSettings"
			)._tag
		).toBe("Failure");
		const index = success(
			parseDashboardTargets(
				editor.replace(
					'NativeCultureIndex=0,SupportedCulturesStatistics=((CultureName="en"),(CultureName="de")',
					'NativeCultureIndex=9,SupportedCulturesStatistics=((CultureName="en"),(CultureName="de")'
				)
			)
		);
		expect(index.diagnostics[0]?.error.code).toBe("malformed_struct");
		expect(
			parseLocalizationRecipe("[GatherTextStep0]\nCommandletClass", "recipe.ini")._tag
		).toBe("Failure");
	});
});
