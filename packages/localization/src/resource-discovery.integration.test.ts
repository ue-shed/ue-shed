import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { LocalizationEvidence, LocalizationEvidenceNodeLive } from "./service.js";
import { discoverLocalizationTargets } from "./targets.js";

/**
 * A project shaped like one that ships only compiled resources: a Dashboard target with no gather
 * configs, a `.locres` under Unreal's runtime convention, a resource-only target the Dashboard
 * does not name, and files that do not follow the convention.
 */
const project = Effect.acquireRelease(
	Effect.promise(async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-resource-discovery-"));
		const files = {
			"Config/DefaultEditor.ini": [
				"[/Script/Localization.LocalizationSettings]",
				'+GameTargetsSettings=(Name="Game",Guid=0123456789ABCDEF0123456789ABCDEF,' +
					"TargetDependencies=,AdditionalManifestDependencies=,RequiredModuleNames=," +
					"GatherFromTextFiles=(IsEnabled=False,SearchDirectories=,ExcludePathWildcards=," +
					'FileExtensions=((Pattern="h"))),GatherFromPackages=(IsEnabled=True,' +
					'IncludePathWildcards=((PathRoot=Project,Pattern="Content/Text/*")),' +
					'ExcludePathWildcards=,FileExtensions=((Pattern="uasset"))),' +
					"GatherFromMetaData=(IsEnabled=False,IncludePathWildcards=,ExcludePathWildcards=," +
					"KeySpecifications=),NativeCultureIndex=0," +
					'SupportedCulturesStatistics=((CultureName="en"),(CultureName="id")))',
				""
			].join("\n"),
			"Content/Localization/Game/id/Game.locres": "resource",
			"Content/Localization/Extra/de/Extra.locres": "resource",
			"Content/Localization/Extra/fr/Other.locres": "not the target's name",
			"Content/Localization/Game/Game.locres": "not in a culture folder"
		} satisfies Record<string, string>;
		for (const [path, text] of Object.entries(files)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), text);
		}
		return root;
	}),
	(root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
);

it.effect("discovers resource-only targets in a project with no gather configs", () =>
	Effect.gen(function* () {
		const projectRoot = yield* project;
		const discovery = yield* (yield* LocalizationEvidence).discover({ projectRoot });
		expect(discovery.diagnostics).toEqual([]);
		const game = discovery.targets.find((target) => target.name === "Game");
		expect(game?.source).toBe("dashboard_settings");
		expect(game?.resourcesDiscovered).toBe(true);
		expect(game?.nativeCulture).toBe("en");
		expect(game?.cultures).toEqual(["en", "id"]);
		expect(game?.outputPaths.resources).toEqual({
			id: "Content/Localization/Game/id/Game.locres"
		});
		expect(game?.outputPaths.manifest).toBeNull();
		const extra = discovery.targets.find((target) => target.name === "Extra");
		expect(extra).toMatchObject({
			source: "resource_files",
			resourcesDiscovered: true,
			nativeCulture: null,
			cultures: ["de"],
			configs: [],
			outputPaths: {
				manifest: null,
				archives: {},
				portableObjects: {},
				resources: { de: "Content/Localization/Extra/de/Extra.locres" }
			}
		});
	}).pipe(Effect.scoped, Effect.provide(LocalizationEvidenceNodeLive))
);

it("keeps configured resource paths when the project has gather configs", () => {
	const result = discoverLocalizationTargets({
		configs: [
			{
				relativePath: "Config/Localization/Game.ini",
				text: [
					"[CommonSettings]",
					"ManifestName=Game.manifest",
					"NativeCulture=en",
					"CulturesToGenerate=en",
					"[GatherTextStep0]",
					"CommandletClass=GatherTextFromAssets",
					"IncludePathFilters=Content/Text/*",
					"PackageFileNameFilters=*.uasset",
					""
				].join("\n")
			}
		],
		resources: ["Content/Localization/Other/de/Other.locres"]
	});
	if (result._tag === "Failure") throw result.failure;
	expect(result.success.targets.map((target) => target.name)).toEqual(["Game"]);
	expect(result.success.targets[0]?.resourcesDiscovered).toBeUndefined();
});
