import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { discoverLocalizationTargets } from "./targets.js";
import { availableLocalizationOperations, planLocalizationOperation } from "./operation-plan.js";
import {
	LocalizationOperation,
	LocalizationOperationPlan,
	CultureCode,
	type LocalizationTarget,
	type RecipeFields
} from "./browser.js";
import { parseLocalizationProgress, localizationExitFailure } from "./operation-progress.js";

function targetAt(fixture: string, name: string): LocalizationTarget {
	const root = resolve("fixtures", fixture);
	const result = discoverLocalizationTargets({
		dashboardText:
			fixture === "unreal-project"
				? readFileSync(resolve(root, "Config/DefaultEditor.ini"), "utf8")
				: "",
		configs: readdirSync(resolve(root, "Config/Localization"))
			.filter((file) => file.endsWith(".ini"))
			.map((file) => ({
				relativePath: `Config/Localization/${file}`,
				text: readFileSync(resolve(root, "Config/Localization", file), "utf8")
			}))
	});
	if (Result.isFailure(result)) throw result.failure;
	const target = result.success.targets.find((target) => target.name === name);
	if (!target) throw new Error("Fixture target missing.");
	return target;
}
const dashboard = targetAt("unreal-project", "FixtureGame");
const legacy = targetAt("unreal-427-localization", "Fixture427");
const base = {
	engine: "5.7",
	projectDescriptor: "Project.uproject",
	logPath: "Private/Commandlet.log"
} satisfies Pick<
	Parameters<typeof planLocalizationOperation>[0],
	"engine" | "projectDescriptor" | "logPath"
>;

describe("localization operation plans", () => {
	it("selects Dashboard configs and all gather/report writes", () => {
		expect(availableLocalizationOperations(dashboard)).toEqual(LocalizationOperation.literals);
		const plan = planLocalizationOperation({ ...base, target: dashboard, operation: "gather" });
		expect(plan.configs).toEqual(["Config/Localization/FixtureGame_Gather.ini"]);
		expect(plan.steps.map((step) => step.kind)).toEqual([
			"gather_source",
			"gather_assets",
			"manifest",
			"archive",
			"reports"
		]);
		expect(plan.files.map((file) => file.relativePath)).toEqual(
			[
				"Content/Localization/FixtureGame/de/FixtureGame.archive",
				"Content/Localization/FixtureGame/en/FixtureGame.archive",
				"Content/Localization/FixtureGame/fr/FixtureGame.archive",
				"Content/Localization/FixtureGame/FixtureGame_Conflicts.txt",
				"Content/Localization/FixtureGame/FixtureGame.csv",
				"Content/Localization/FixtureGame/FixtureGame.manifest"
			].sort((a, b) => a.localeCompare(b))
		);
		expect(plan.wholeRecipe).toBe(false);
	});
	it.each(["4.27", "5.7", "5.8"])(
		"uses only shared switches for %s and orders sync import before compile",
		(engine) => {
			const supported = Schema.decodeUnknownSync(LocalizationOperationPlan.fields.engine)(
				engine
			);
			const plan = planLocalizationOperation({
				...base,
				target: dashboard,
				operation: "sync",
				engine: supported
			});
			expect(plan.arguments).toEqual([
				"Project.uproject",
				"-run=GatherText",
				"-Config=Config/Localization/FixtureGame_Import.ini;Config/Localization/FixtureGame_Compile.ini",
				"-unattended",
				"-nosplash",
				"-NullRHI",
				"-abslog=Private/Commandlet.log"
			]);
			expect(plan.steps.map((step) => step.kind)).toEqual(["import", "compile"]);
			expect(plan.files.filter((file) => file.kind === "archive")).toHaveLength(3);
			expect(plan.files.filter((file) => file.kind === "locres")).toHaveLength(3);
			expect(
				plan.files
					.filter((file) => file.kind === "locmeta")
					.map((file) => file.relativePath)
			).toEqual(["Content/Localization/FixtureGame/FixtureGame.locmeta"]);
			expect(plan.arguments.join(" ")).not.toMatch(
				/EnableSCC|DisableSCCSubmit|Preview|GatherType|ConfigList/
			);
		}
	);
	it("offers only supported recipe operations, explicitly retaining all recipe effects", () => {
		expect(availableLocalizationOperations(legacy)).toEqual([
			"gather",
			"export",
			"compile",
			"reports"
		]);
		for (const operation of availableLocalizationOperations(legacy)) {
			const plan = planLocalizationOperation({
				...base,
				engine: "4.27",
				target: legacy,
				operation
			});
			expect(plan.configs).toEqual(["Config/Localization/Fixture427.ini"]);
			expect(plan.wholeRecipe).toBe(true);
			expect(plan.steps).toHaveLength(6);
			expect(plan.files).toHaveLength(13);
		}
		expect(() =>
			planLocalizationOperation({ ...base, target: legacy, operation: "import" })
		).toThrowError(expect.objectContaining({ code: "unsupported_operation" }));
	});
	it("derives overridden names, destination, culture layout and enabled reports", () => {
		const target = {
			...dashboard,
			configs: dashboard.configs.map((recipe) => ({
				...recipe,
				steps: recipe.steps.map((step) => ({
					...step,
					fields: {
						...step.fields,
						DestinationPath: "Translations",
						CulturesToGenerate: [Schema.decodeUnknownSync(CultureCode)("de")],
						bUseCultureDirectory: false,
						ResourceName: "Nested/Runtime.bin",
						bConflictReport: false,
						bWordCountReport: false
					}
				}))
			}))
		};
		const compiled = planLocalizationOperation({ ...base, target, operation: "compile" });
		expect(compiled.files.map((file) => file.relativePath)).toContain(
			"Translations/Runtime.locmeta"
		);
		expect(compiled.files.map((file) => file.relativePath)).toContain(
			"Translations/de/Nested/Runtime.bin"
		);
		const exported = planLocalizationOperation({ ...base, target, operation: "export" });
		expect(exported.files.map((file) => file.relativePath)).toEqual([
			"Translations/FixtureGame.po"
		]);
		expect(planLocalizationOperation({ ...base, target, operation: "reports" }).files).toEqual(
			[]
		);
	});
	it("includes the native PO/archive writes and enforces flat single-culture mode", () => {
		const target = {
			...dashboard,
			configs: dashboard.configs.map((recipe) => ({
				...recipe,
				common: {
					...recipe.common,
					CulturesToGenerate: [Schema.decodeUnknownSync(CultureCode)("de")]
				}
			}))
		};
		expect(
			planLocalizationOperation({ ...base, target, operation: "import" }).files.map(
				(file) => file.culture
			)
		).toEqual(["de", "en"]);
		const flat = {
			...dashboard,
			configs: dashboard.configs.map((recipe) => ({
				...recipe,
				common: { ...recipe.common, bUseCultureDirectory: false }
			}))
		};
		expect(() =>
			planLocalizationOperation({ ...base, target: flat, operation: "export" })
		).toThrowError(expect.objectContaining({ code: "unsupported_config" }));
	});
	it("fails safely for missing configs, unsafe paths, custom steps and package repair", () => {
		expect(() =>
			planLocalizationOperation({
				...base,
				target: { ...dashboard, configs: [] },
				operation: "gather"
			})
		).toThrowError(
			expect.objectContaining({
				code: "missing_config",
				recovery: expect.stringContaining("Localization Dashboard")
			})
		);
		const patches: readonly Partial<RecipeFields>[] = [
			{ DestinationPath: "../Elsewhere" },
			{ FixStaleGatherCache: true },
			{ PlatformSplitMode: "Split" }
		];
		for (const fields of patches) {
			const target = {
				...dashboard,
				configs: dashboard.configs.map((recipe) => ({
					...recipe,
					common: { ...recipe.common, ...fields }
				}))
			};
			expect(() =>
				planLocalizationOperation({ ...base, target, operation: "compile" })
			).toThrowError(expect.objectContaining({ _tag: "LocalizationOperationError" }));
		}
		const custom = {
			...dashboard,
			configs: dashboard.configs.map((recipe) => ({
				...recipe,
				steps: recipe.steps.map((step) => ({ ...step, commandletClass: "CustomWriter" }))
			}))
		};
		expect(() =>
			planLocalizationOperation({ ...base, target: custom, operation: "compile" })
		).toThrowError(expect.objectContaining({ code: "unsupported_config" }));
	});
	it("parses captured modern boundaries and legacy boundaries without log text", () => {
		const plan = planLocalizationOperation({ ...base, target: dashboard, operation: "gather" });
		const lines = readFileSync(
			new URL("./test-fixtures/gather-text.log", import.meta.url),
			"utf8"
		)
			.trim()
			.split("\n");
		const events = lines.flatMap((line) => {
			const event = parseLocalizationProgress(line, plan);
			return event ? [event] : [];
		});
		expect(events.map((event) => [event.stepIndex, event.phase])).toEqual([
			[0, "started"],
			[0, "completed"],
			[1, "started"],
			[1, "completed"],
			[2, "started"],
			[2, "completed"],
			[3, "started"],
			[3, "completed"],
			[4, "started"],
			[4, "completed"]
		]);
		expect(JSON.stringify(events)).not.toContain("Config/");
		const oldPlan = planLocalizationOperation({
			...base,
			engine: "4.27",
			target: legacy,
			operation: "gather"
		});
		expect(
			parseLocalizationProgress(
				"LogGatherTextCommandlet: Display: Executing GatherTextStep3: InternationalizationExportCommandlet",
				oldPlan
			)
		).toMatchObject({ stepIndex: 3, phase: "started", kind: "export" });
		expect(
			parseLocalizationProgress(
				"LogGatherTextCommandlet: Display: Completed GatherTextStep3: InternationalizationExportCommandlet in 0.1 seconds",
				oldPlan
			)
		).toMatchObject({ phase: "completed" });
		expect(
			parseLocalizationProgress(
				"LogGatherTextCommandlet: Display: GatherText completed with exit code 0",
				oldPlan
			)
		).toBeNull();
	});
	it("keeps bounded private excerpts out of safe errors and detects a sharing violation", () => {
		const error = localizationExitFailure(
			1,
			Array.from({ length: 100 }, () => "private-term"),
			"private-log"
		);
		expect(error.logExcerpt).toHaveLength(40);
		expect(error.message + error.recovery).not.toMatch(/private-term|private-log/);
		expect(error.retrySafe).toBe(false);
		expect(localizationExitFailure(1, ["Sharing violation"], "log").code).toBe(
			"project_locked"
		);
	});
});
