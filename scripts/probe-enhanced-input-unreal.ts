// Checks the Enhanced Input scan v2 and analysis against packages a real Unreal Engine saved.
// For each requested engine (default 5.7 and 5.8) it builds a disposable project, runs
// scripts/unreal-enhanced-input-probe.py through Unreal's Python commandlet, then runs the CLI and
// asserts what the saved packages and config must yield. An engine that is not installed is
// reported as skipped, never as passed. The repository fixture is never touched.
//
//   node scripts/probe-enhanced-input-unreal.ts [5.7] [5.8]
//   UE_SHED_UNREAL_ENGINE_ROOT=<root> node scripts/probe-enhanced-input-unreal.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { ensureUassetExecutable } from "./native-tools.ts";
import { findUnrealEngine } from "./unreal-engines.ts";
import {
	localDerivedDataCacheArguments,
	repositoryRoot,
	runProcess,
	unrealEngineTools,
	unrealEngineVersion
} from "./unreal-plugin-host.ts";

const failures: string[] = [];
function check<Detail>(label: string, condition: boolean, detail?: Detail) {
	if (condition) console.log(`  ok    ${label}`);
	else {
		console.log(`  FAIL  ${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
		failures.push(label);
	}
}

/** Saved evidence: a value the package wrote, or the reason it is unavailable. */
const Evidence = <S extends Schema.Top>(value: S) =>
	Schema.Union([
		Schema.Struct({ status: Schema.Literal("available"), value }),
		Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String })
	]);
const Parameter = Schema.Struct({
	name: Schema.String,
	kind: Schema.String,
	value: Schema.optionalKey(Schema.Unknown)
});
const Instanced = Schema.Struct({
	objectPath: Schema.String,
	parameters: Schema.optionalKey(Schema.Array(Parameter))
});
const Settings = Evidence(
	Schema.Struct({ name: Evidence(Schema.String), displayName: Evidence(Schema.String) })
);
const Report = Schema.Struct({
	schemaVersion: Schema.Number,
	status: Schema.String,
	diagnostics: Schema.Array(Schema.Unknown),
	actions: Schema.Array(
		Schema.Struct({
			objectPath: Schema.String,
			consumeInput: Evidence(Schema.Boolean),
			triggerWhenPaused: Evidence(Schema.Boolean),
			reserveAllMappings: Evidence(Schema.Boolean),
			accumulationBehavior: Evidence(Schema.String),
			triggers: Schema.Array(Instanced),
			playerMappableKeySettings: Settings
		})
	),
	mappingContexts: Schema.Array(
		Schema.Struct({
			objectPath: Schema.String,
			mappings: Schema.Array(
				Schema.Struct({
					triggers: Schema.Array(Instanced),
					modifiers: Schema.Array(Instanced),
					settingBehavior: Evidence(Schema.String),
					playerMappableKeySettings: Settings
				})
			),
			profileOverrides: Schema.Array(Schema.Struct({ profileId: Schema.String })),
			registrationTrackingMode: Evidence(Schema.String),
			inputModeFilterOptions: Evidence(Schema.String)
		})
	),
	playerMappableConfigs: Schema.Array(
		Schema.Struct({
			configName: Evidence(Schema.String),
			contexts: Evidence(
				Schema.Array(
					Schema.Struct({
						context: Schema.NullOr(Schema.String),
						priority: Schema.Number
					})
				)
			)
		})
	)
});
const Atlas = Schema.Struct({
	edges: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String }))
});
const Conflicts = Schema.Struct({
	sources: Schema.Array(Schema.Struct({ source: Schema.String, status: Schema.String })),
	keys: Schema.Array(
		Schema.Struct({
			key: Schema.String,
			classes: Schema.Array(Schema.String),
			conflicts: Schema.Array(
				Schema.Struct({
					classification: Schema.String,
					consumption: Schema.optionalKey(Schema.String)
				})
			)
		})
	)
});
const Usage = Schema.Struct({ noKnownUse: Schema.Array(Schema.String) });
const ControlSheet = Schema.Struct({
	rows: Schema.Array(
		Schema.Struct({
			context: Schema.String,
			key: Schema.NullOr(Schema.String),
			displayName: Schema.NullOr(Schema.String),
			displayNameSource: Schema.String
		})
	)
});
const Platforms = Schema.Struct({
	platforms: Schema.Array(
		Schema.Struct({
			platform: Schema.String,
			redirects: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String }))
		})
	),
	keyProfiles: Schema.Array(Schema.String)
});

function cli<S extends Schema.Decoder<unknown>>(
	schema: S,
	args: readonly string[],
	executable: string
): S["Type"] {
	const result = spawnSync(
		process.execPath,
		[join(repositoryRoot, "scripts", "ue-shed.ts"), "input", ...args],
		{
			cwd: repositoryRoot,
			encoding: "utf8",
			env: { ...process.env, UE_SHED_UASSET_EXECUTABLE: executable },
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true
		}
	);
	if (result.status !== 0) {
		throw new Error(`ue-shed input ${args.join(" ")} failed:\n${result.stderr}`);
	}
	return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(result.stdout);
}

function writeProject(root: string, association: string) {
	writeFileSync(
		join(root, "EIProbe.uproject"),
		JSON.stringify(
			{
				FileVersion: 3,
				EngineAssociation: association,
				Plugins: [
					{ Name: "EnhancedInput", Enabled: true },
					{ Name: "PythonScriptPlugin", Enabled: true }
				]
			},
			null,
			"\t"
		)
	);
	mkdirSync(join(root, "Config", "Windows"), { recursive: true });
	writeFileSync(
		join(root, "Config", "DefaultInput.ini"),
		[
			"[/Script/EnhancedInput.EnhancedInputDeveloperSettings]",
			'+DefaultMappingContexts=(InputMappingContext="/Game/Probe/IMC_ProbeGameplay.IMC_ProbeGameplay",Priority=0,bAddImmediately=True,bRegisterWithUserSettings=False)',
			'+DefaultMappingContexts=(InputMappingContext="/Game/Probe/IMC_ProbeVehicle.IMC_ProbeVehicle",Priority=1,bAddImmediately=True,bRegisterWithUserSettings=False)',
			""
		].join("\r\n")
	);
	writeFileSync(
		join(root, "Config", "Windows", "WindowsInput.ini"),
		[
			"[EnhancedInputPlatformSettings_Windows EnhancedInputPlatformSettings]",
			"+InputData=/Game/Probe/BP_ProbePlatformData.BP_ProbePlatformData_C",
			""
		].join("\r\n")
	);
}

const path = (name: string) => `/Game/Probe/${name}.${name}`;

function probe(engineRoot: string, executable: string) {
	const version = unrealEngineVersion(engineRoot);
	if (version === undefined) throw new Error(`${engineRoot} has no Build.version.`);
	console.log(`\nUE ${version.label} (${engineRoot})`);
	const root = mkdtempSync(join(tmpdir(), "ue-shed-enhanced-input-probe-"));
	try {
		writeProject(root, version.label);
		runProcess(unrealEngineTools(engineRoot).editorCommandlet, [
			join(root, "EIProbe.uproject"),
			"-run=pythonscript",
			`-script=${join(repositoryRoot, "scripts", "unreal-enhanced-input-probe.py")}`,
			"-unattended",
			"-nop4",
			"-nosplash",
			"-NullRHI",
			...localDerivedDataCacheArguments
		]);

		const report = cli(Report, ["inspect", root], executable);
		check("scan writes schema 2", report.schemaVersion === 2);
		check("the config asset leaves the scan complete", report.status === "complete");
		check(
			"no unsupported_asset diagnostic",
			report.diagnostics.length === 0,
			report.diagnostics
		);
		const config = report.playerMappableConfigs[0];
		check(
			"config name",
			config?.configName.status === "available" && config.configName.value === "ProbeConfig",
			config
		);
		check(
			"config context priority",
			config?.contexts.status === "available" &&
				config.contexts.value[0]?.context === path("IMC_ProbeGameplay") &&
				config.contexts.value[0].priority === 2,
			config?.contexts
		);
		const fire = report.actions.find((action) => action.objectPath === path("IA_Fire"));
		const brake = report.actions.find((action) => action.objectPath === path("IA_Brake"));
		check(
			"action bTriggerWhenPaused",
			fire?.triggerWhenPaused.status === "available" && fire.triggerWhenPaused.value
		);
		check(
			"action bReserveAllMappings",
			fire?.reserveAllMappings.status === "available" && fire.reserveAllMappings.value
		);
		check("action accumulation behaviour", fire?.accumulationBehavior.status === "available");
		check(
			"action trigger parameter",
			(fire?.triggers[0]?.parameters ?? []).some(
				(parameter) => parameter.name === "Interval" && parameter.value === 0.25
			),
			fire?.triggers
		);
		check(
			"action mappable key settings",
			fire?.playerMappableKeySettings.status === "available" &&
				fire.playerMappableKeySettings.value.name.status === "available" &&
				fire.playerMappableKeySettings.value.name.value === "Fire",
			fire?.playerMappableKeySettings
		);
		check(
			"unsaved values stay unavailable",
			fire?.consumeInput.status === "unavailable" &&
				brake?.consumeInput.status === "available" &&
				!brake.consumeInput.value,
			[fire?.consumeInput, brake?.consumeInput]
		);
		const gameplay = report.mappingContexts.find(
			(context) => context.objectPath === path("IMC_ProbeGameplay")
		);
		const chordMapping = gameplay?.mappings[0];
		check(
			"chord trigger parameter",
			(chordMapping?.triggers[0]?.parameters ?? []).some(
				(parameter) =>
					parameter.name === "ChordAction" && parameter.value === path("IA_Aim")
			),
			chordMapping?.triggers
		);
		check("mapping setting behaviour", chordMapping?.settingBehavior.status === "available");
		check(
			"mapping mappable key settings",
			chordMapping?.playerMappableKeySettings.status === "available" &&
				chordMapping.playerMappableKeySettings.value.displayName.status === "available" &&
				chordMapping.playerMappableKeySettings.value.displayName.value === "Fire (combat)",
			chordMapping?.playerMappableKeySettings
		);
		const aimModifiers = gameplay?.mappings[1]?.modifiers ?? [];
		check(
			"modifier parameters",
			aimModifiers.length === 2 &&
				(aimModifiers[1]?.parameters ?? []).some(
					(parameter) => parameter.name === "Scalar" && parameter.kind === "vector"
				),
			aimModifiers
		);
		check(
			"profile overrides",
			gameplay?.profileOverrides[0]?.profileId === "LeftHanded",
			gameplay?.profileOverrides
		);
		check(
			"registration tracking mode",
			gameplay?.registrationTrackingMode.status === "available"
		);
		check("input mode filter options", gameplay?.inputModeFilterOptions.status === "available");

		const atlas = cli(Atlas, ["atlas", root], executable);
		check(
			"chord is an action-to-action edge",
			atlas.edges.some((edge) => edge.from === path("IA_Fire") && edge.to === path("IA_Aim")),
			atlas.edges
		);

		const conflicts = cli(Conflicts, ["conflicts", root, "--platform", "Windows"], executable);
		check(
			"project default contexts resolve through config",
			conflicts.sources.some(
				(source) =>
					source.source === "project_default_contexts" && source.status === "resolved"
			),
			conflicts.sources
		);
		const space = conflicts.keys.find((key) => key.key === "SpaceBar");
		check(
			"a higher action that saves bConsumeInput=false lets both fire",
			(space?.conflicts ?? []).some(
				(conflict) =>
					conflict.classification === "both_fire" &&
					conflict.consumption === "passes_through"
			),
			space?.conflicts
		);
		// Unreal does not save bConsumeInput=true (the class default), so a consuming higher action
		// reads as "may shadow", whatever the triggers.
		const rightMouse = conflicts.keys.find((key) => key.key === "RightMouseButton");
		check(
			"unsaved consumption may shadow, despite different triggers",
			rightMouse?.conflicts.some(
				(conflict) =>
					conflict.classification === "may_shadow" &&
					conflict.consumption === "not_serialized"
			) === true,
			rightMouse?.conflicts
		);
		const leftMouse = conflicts.keys.find((key) => key.key === "LeftMouseButton");
		check(
			"a chorded lower mapping under a pass-through action is qualified",
			leftMouse?.classes.includes("qualified") === true,
			leftMouse?.classes
		);

		const sheet = cli(ControlSheet, ["export", root, "--format", "json"], executable);
		const rowFor = (context: string, key: string) =>
			sheet.rows.find((row) => row.context === path(context) && row.key === key);
		check(
			"OverrideSettings selects the mapping's display name",
			rowFor("IMC_ProbeGameplay", "LeftMouseButton")?.displayName === "Fire (combat)" &&
				rowFor("IMC_ProbeGameplay", "LeftMouseButton")?.displayNameSource === "mapping",
			rowFor("IMC_ProbeGameplay", "LeftMouseButton")
		);
		check(
			"IgnoreSettings selects no display name",
			rowFor("IMC_ProbeVehicle", "J")?.displayName === null &&
				rowFor("IMC_ProbeVehicle", "J")?.displayNameSource === "ignored",
			rowFor("IMC_ProbeVehicle", "J")
		);
		// Unreal saves SettingBehavior even at its InheritSettingsFromAction default. IA_Jump has no
		// mappable key settings, so inheriting yields no name, and the sheet says why.
		const jumpBehavior = gameplay?.mappings[2]?.settingBehavior;
		check(
			"a default mapping saves InheritSettingsFromAction",
			jumpBehavior?.status === "available" &&
				jumpBehavior.value.endsWith("::InheritSettingsFromAction"),
			jumpBehavior
		);
		check(
			"inheriting from an action without settings yields no name, said so",
			rowFor("IMC_ProbeGameplay", "SpaceBar")?.displayName === null &&
				rowFor("IMC_ProbeGameplay", "SpaceBar")?.displayNameSource ===
					"settings_not_serialized",
			rowFor("IMC_ProbeGameplay", "SpaceBar")
		);

		const usage = cli(Usage, ["unused", root], executable);
		check(
			"an unmapped action has no known use",
			usage.noKnownUse.length === 1 && usage.noKnownUse[0] === path("IA_Unused"),
			usage.noKnownUse
		);

		const platforms = cli(Platforms, ["platforms", root], executable);
		const windows = platforms.platforms[0];
		check(
			"platform data redirect from the Blueprint class default",
			windows?.platform === "Windows" &&
				windows.redirects[0]?.from === path("IMC_ProbeVehicle") &&
				windows.redirects[0].to === path("IMC_ProbeGameplay"),
			platforms.platforms
		);
		check(
			"key profiles",
			platforms.keyProfiles.length === 1 && platforms.keyProfiles[0] === "LeftHanded",
			platforms.keyProfiles
		);
	} finally {
		if (process.env.UE_SHED_KEEP_PROBE_PROJECT === "1") console.log(`  kept ${root}`);
		else rmSync(root, { recursive: true, force: true });
	}
}

const executable = ensureUassetExecutable();
const explicit = process.env.UE_SHED_UNREAL_ENGINE_ROOT;
const versions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["5.7", "5.8"];
const skipped: string[] = [];
if (explicit !== undefined) probe(explicit, executable);
else {
	for (const version of versions) {
		const engineRoot = await findUnrealEngine([version]);
		if (engineRoot === undefined) {
			console.log(`\nUE ${version}: not installed, skipped`);
			skipped.push(version);
			continue;
		}
		probe(engineRoot, executable);
	}
}
if (skipped.length > 0) console.log(`\nSkipped (not installed): UE ${skipped.join(", UE ")}`);
if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed.`);
	process.exitCode = 1;
}
