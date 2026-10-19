// Sequential, disposable UE4 acceptance. Invoked by test-unreal-game-text-actions.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Effect, Schema, Stream } from "effect";
import {
	CompanionCapabilityManifest,
	GameTextActionsResult,
	type GameTextAction
} from "../packages/protocol/src/index.ts";
import {
	assetReaderLayer,
	extractProjectTextPackages
} from "../packages/unreal-assets/dist/index.js";
import { ensureUassetExecutable } from "./native-tools.ts";
import {
	gameTextActionForOccurrence,
	verifyGameTextActions
} from "../packages/game-text/src/text-actions.ts";
import { isJsonObject, isJsonString, parseJson, parseJsonObject, type JsonValue } from "./json.ts";
import { GAME_TEXT_PLUGIN_IDS } from "./plugin-bundle.ts";
import {
	prepareUnrealPlugins,
	repositoryRoot,
	runProcess,
	unrealEngineTools
} from "./unreal-plugin-host.ts";

const engineRoot = process.env.UE_SHED_UNREAL_ENGINE_ROOT!;
const tools = unrealEngineTools(engineRoot);
const run = resolve(
	process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
		join(repositoryRoot, "out/game-text-actions", `4.27-${Date.now()}`)
);
mkdirSync(dirname(run), { recursive: true });
mkdirSync(run, { recursive: false });
const project = join(run, "project");
const fixture = join(repositoryRoot, "fixtures/legacy-unreal-project");
cpSync(fixture, project, {
	recursive: true,
	filter: (source) =>
		!["Binaries", "Intermediate", "Saved", "DerivedDataCache", "Generated"].includes(
			relative(fixture, source).split(sep)[0] ?? ""
		)
});
const projectFile = join(project, "UEShedLegacyFixture.uproject");
runProcess(tools.build, [
	"UEShedLegacyFixtureEditor",
	"Win64",
	"Development",
	`-Project=${projectFile}`,
	"-NoEngineChanges",
	"-NoHotReloadFromIDE",
	"-WaitMutex"
]);
const descriptors = prepareUnrealPlugins({
	engineRoot,
	projectPath: projectFile,
	tools,
	pluginIds: GAME_TEXT_PLUGIN_IDS,
	coreRuntimeOnly: true
});

function commandlet(name: string, args: readonly string[], label: string) {
	const result = spawnSync(
		tools.editorCommandlet,
		[
			projectFile,
			`-run=${name}`,
			...descriptors.map((descriptor) => `-PLUGIN=${descriptor}`),
			`-EnablePlugins=${GAME_TEXT_PLUGIN_IDS.join(",")}`,
			...args,
			"-Unattended",
			"-NoSound",
			"-NullRHI",
			"-NoSplash",
			`-abslog=${join(run, `${label}.log`)}`
		],
		{ encoding: "utf8", windowsHide: true, timeout: 600_000 }
	);
	writeFileSync(
		join(run, `${label}.stdout.log`),
		`${result.stdout ?? ""}\n${result.stderr ?? ""}`
	);
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${label}: inspect ${join(run, `${label}.log`)}`);
}

const manifestFile = join(run, "capabilities.json");
commandlet("UEShedGameText", [`-Manifest=${manifestFile}`], "capabilities");
const producer = Schema.decodeUnknownSync(CompanionCapabilityManifest)(
	parseJson(readFileSync(manifestFile, "utf8"))
);
assert.deepEqual(producer.capabilities, [
	"game-text.actions.v1",
	"game-text.actions.key-repairs.v1"
]);
const projectIdentity = parseJsonObject(readFileSync(manifestFile, "utf8")).projectRoot;
assert.ok(projectIdentity !== undefined && isJsonString(projectIdentity));
assert.equal(resolve(projectIdentity), resolve(project));
assert.equal(
	producer.identity?.plugins
		.flatMap((plugin) => plugin.loadedModules)
		.sort()
		.join(","),
	"UEShedCore,UEShedGameText"
);
assert.equal(producer.worldControlObjectPath, undefined);
assert.equal(producer.assetNavigationObjectPath, undefined);
assert.equal(producer.authoringObjectPath, undefined);

const Place = Schema.Struct({
	kind: Schema.Literals(["object", "data_table_cell", "graph_pin"]),
	operation: Schema.Literals(["split", "regenerate", "adopt"]),
	objectPath: Schema.NonEmptyString,
	packageFile: Schema.NonEmptyString,
	propertyPath: Schema.NonEmptyString,
	namespace: Schema.String,
	key: Schema.NonEmptyString,
	source: Schema.String,
	row: Schema.optionalKey(Schema.NonEmptyString),
	pinId: Schema.optionalKey(Schema.NonEmptyString),
	pinIndex: Schema.optionalKey(Schema.Int)
});
const json = (path: string) => {
	const bytes = readFileSync(path);
	const content =
		bytes[0] === 0xff && bytes[1] === 0xfe
			? bytes.subarray(2).toString("utf16le")
			: bytes.toString("utf8").replace(/^\uFEFF/u, "");
	return parseJson(content);
};
const readPlaces = (path: string) =>
	Schema.decodeUnknownSync(Schema.Struct({ places: Schema.Array(Place) }))(json(path)).places;
const baselineFile = join(run, "baseline.json");
commandlet("UEShedLegacyTextActions", ["-Create", `-Evidence=${baselineFile}`], "baseline");
// SAFETY: the fixture-owned commandlet emits exactly these nine places, validated below.
const baseline = readPlaces(baselineFile);
assert.equal(baseline.length, 9);
const files = [...new Set(baseline.map((place) => place.packageFile))];
const diskBefore = files.map((file) => readFileSync(file));
const reader = assetReaderLayer({ executable: ensureUassetExecutable() });
const readOffline = () =>
	Effect.runPromise(
		Stream.runCollect(extractProjectTextPackages({ projectRoot: project, paths: files })).pipe(
			Effect.provide(reader)
		)
	);
const savedBaseline = await readOffline();
writeFileSync(join(run, "baseline-offline.json"), JSON.stringify(savedBaseline, null, 2));
const offlineSkipped: string[] = [];
const actions: GameTextAction[] = baseline.map((place) => {
	const record = savedBaseline.find(
		(event) =>
			event.event === "text_package_record" &&
			resolve(event.path) === resolve(place.packageFile)
	);
	assert.ok(record && record.event === "text_package_record");
	const relativeObject = place.objectPath
		.slice(place.objectPath.indexOf(".") + 1)
		.replaceAll(":", ".");
	const property =
		place.kind === "graph_pin"
			? `Pins[${place.pinIndex}].DefaultTextValue`
			: place.propertyPath;
	const occurrence = record.occurrences.find(
		(item) =>
			(item.location.object_path === relativeObject ||
				item.location.object_path.endsWith(`.${relativeObject}`)) &&
			item.location.kind !== "string_table_entry" &&
			item.location.property_path === property &&
			(place.kind !== "data_table_cell" ||
				(item.location.kind === "data_table_cell" && item.location.row === place.row))
	);
	if (!occurrence && place.kind === "graph_pin") {
		offlineSkipped.push(`${place.kind}-${place.operation}`);
		return {
			id: `${place.kind}-${place.operation}`,
			place: {
				objectPath: place.objectPath,
				packageFile: place.packageFile,
				propertyPath: property,
				selector: { kind: "graph_pin", pinId: place.pinId! }
			},
			expected: { namespace: place.namespace, key: place.key, source: place.source },
			edit:
				place.operation === "regenerate"
					? { kind: "regenerate_key" }
					: place.operation === "adopt"
						? {
								kind: "adopt_key",
								namespace: "KeyRepairs",
								key: "Survivor",
								source: "adopt source"
							}
						: { kind: "change_key", namespace: "KeyRepairs", key: "SplitAfter" }
		};
	}
	assert.ok(occurrence, `Missing saved baseline ${place.kind}-${place.operation}`);
	const edit =
		place.operation === "regenerate"
			? ({ kind: "regenerate_key" } as const)
			: place.operation === "adopt"
				? ({
						kind: "adopt_key",
						namespace: "KeyRepairs",
						key: "Survivor",
						source: "adopt source"
					} as const)
				: ({ kind: "change_key", namespace: "KeyRepairs", key: "SplitAfter" } as const);
	const action = gameTextActionForOccurrence(
		`${place.kind}-${place.operation}`,
		occurrence,
		edit,
		place.packageFile
	);
	assert.ok(action);
	assert.deepEqual(action.expected, {
		namespace: place.namespace,
		key: place.key,
		source: place.source
	});
	return action;
});
function apply(mode: "dry_run" | "apply", label: string, selected = actions) {
	const request = {
		contract: "ue-shed-game-text-actions",
		version: "1.0",
		mode,
		compile: true,
		save: true,
		actions: selected
	};
	const requestFile = join(run, `${label}.request.json`);
	const resultFile = join(run, `${label}.receipt.json`);
	writeFileSync(requestFile, JSON.stringify(request, null, 2));
	commandlet("UEShedGameText", [`-Request=${requestFile}`, `-Result=${resultFile}`], label);
	// SAFETY: receipt assertions validate the fixture commandlet's successful action outcomes.
	const result = Schema.decodeUnknownSync(GameTextActionsResult)(json(resultFile));
	assert.equal(result.status, "ok");
	assert.equal(result.actions.length, selected.length);
	assert.equal(result.errors.length, 0);
	return result;
}
const preview = apply("dry_run", "dry-run");
assert.ok(
	preview.actions.every((item) => item.status === "planned" || item.status === "unchanged")
);
assert.ok(preview.packages.every((item) => !item.saved));
files.forEach((file, index) =>
	assert.ok(readFileSync(file).equals(diskBefore[index]!), "Dry run changed saved bytes")
);
const receipt = apply("apply", "apply");
assert.ok(receipt.packages.every((item) => item.saved && item.persistence === "saved"));
assert.ok(receipt.blueprints.every((item) => item.compiled));
const reloadFile = join(run, "reload.json");
commandlet("UEShedLegacyTextActions", [`-Evidence=${reloadFile}`], "reload");
const reloaded = readPlaces(reloadFile);
for (const outcome of receipt.actions) {
	const found = reloaded.find((place) => `${place.kind}-${place.operation}` === outcome.id);
	assert.ok(found, outcome.id);
	assert.deepEqual(
		[found.namespace, found.key, found.source],
		[outcome.after.namespace, outcome.after.key, outcome.after.source],
		outcome.id
	);
}

const records = await readOffline();
writeFileSync(join(run, "offline.json"), JSON.stringify(records, null, 2));

const verification = verifyGameTextActions(
	{
		contract: "ue-shed-game-text-actions",
		version: "1.0",
		mode: "apply",
		compile: true,
		save: true,
		actions
	},
	{ ...receipt, actions: receipt.actions.filter((item) => !offlineSkipped.includes(item.id)) },
	records
		.filter((event) => event.event === "text_package_record")
		.filter((event) => !event.path.endsWith("BP_Keys.uasset"))
);
writeFileSync(join(run, "offline-verification.json"), JSON.stringify(verification, null, 2));
assert.equal(verification.complete, true);
assert.deepEqual(verification.mismatches, []);
assert.equal(verification.verified, actions.length - offlineSkipped.length);

const gatherRoot = join(project, "Content/Localization/KeyRepairs");
mkdirSync(gatherRoot, { recursive: true });
const gatherConfig = join(run, "gather.ini");
writeFileSync(
	gatherConfig,
	`[CommonSettings]\nSourcePath=${gatherRoot}\nDestinationPath=${gatherRoot}\nManifestName=KeyRepairs.manifest\nArchiveName=KeyRepairs.archive\nNativeCulture=en\nCulturesToGenerate=en\n\n[GatherTextStep0]\nCommandletClass=GatherTextFromAssets\nIncludePathFilters=${join(project, "Content/KeyRepairs/*")}\nPackageFileNameFilters=*.uasset\nShouldGatherFromEditorOnlyData=true\nSkipGatherCache=true\n\n[GatherTextStep1]\nCommandletClass=GenerateGatherManifest\nbSkipSourceCheck=true\n`
);
commandlet("GatherText", [`-config=${gatherConfig}`], "gather");
const manifest = json(join(gatherRoot, "KeyRepairs.manifest"));
const gathered: Array<{ key: string; source: string }> = [];
function visit(value: JsonValue) {
	if (Array.isArray(value)) {
		value.forEach(visit);
		return;
	}
	if (!isJsonObject(value)) return;
	const source = value.Source;
	const keys = value.Keys;
	if (
		source &&
		isJsonObject(source) &&
		source.Text !== undefined &&
		isJsonString(source.Text) &&
		Array.isArray(keys)
	) {
		const text = source.Text;
		for (const key of keys)
			if (isJsonObject(key) && key.Key !== undefined && isJsonString(key.Key))
				gathered.push({ key: key.Key, source: text });
	}
	Object.values(value).forEach(visit);
}
visit(manifest);
for (const outcome of receipt.actions)
	assert.ok(
		gathered.some(
			(item) => item.key === outcome.after.key && item.source === outcome.after.source
		),
		`Gather missing ${outcome.id}`
	);
writeFileSync(join(run, "key-repairs.gather-manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(
	join(run, "key-repairs.results.json"),
	JSON.stringify(
		{
			native: "passed",
			cases: receipt.actions.map((item) => item.id),
			offlineVerified: verification.verified,
			offlineSkipped,
			gather: "passed"
		},
		null,
		2
	)
);
let sourceEdits = "not_run";
if (process.argv.includes("--source-edits")) {
	const sourceActions: GameTextAction[] = receipt.actions.map((outcome) => ({
		id: outcome.id,
		place: outcome.place,
		expected: {
			namespace: outcome.after.namespace,
			key: outcome.after.key!,
			source: outcome.after.source
		},
		edit: { kind: "change_source", source: `Reviewed ${outcome.after.source}` }
	}));
	const sourceBefore = files.map((file) => readFileSync(file));
	apply("dry_run", "source-dry-run", sourceActions);
	files.forEach((file, index) => assert.ok(readFileSync(file).equals(sourceBefore[index]!)));
	const sourceReceipt = apply("apply", "source-apply", sourceActions);
	const sourceReload = join(run, "source-reload.json");
	commandlet("UEShedLegacyTextActions", [`-Evidence=${sourceReload}`], "source-reload");
	for (const outcome of sourceReceipt.actions) {
		const found = readPlaces(sourceReload).find(
			(place) => `${place.kind}-${place.operation}` === outcome.id
		);
		assert.ok(found);
		assert.deepEqual(
			[found.namespace, found.key, found.source],
			[outcome.after.namespace, outcome.after.key, outcome.after.source]
		);
	}
	const sourceRecords = await readOffline();
	writeFileSync(join(run, "source-offline.json"), JSON.stringify(sourceRecords, null, 2));
	const sourceVerification = verifyGameTextActions(
		{
			contract: "ue-shed-game-text-actions",
			version: "1.0",
			mode: "apply",
			compile: true,
			save: true,
			actions: sourceActions
		},
		{
			...sourceReceipt,
			actions: sourceReceipt.actions.filter((item) => !offlineSkipped.includes(item.id))
		},
		sourceRecords
			.filter((event) => event.event === "text_package_record")
			.filter((event) => !event.path.endsWith("BP_Keys.uasset"))
	);
	writeFileSync(
		join(run, "source-offline-verification.json"),
		JSON.stringify(sourceVerification, null, 2)
	);
	assert.equal(sourceVerification.complete, true);
	assert.equal(sourceVerification.verified, sourceActions.length - offlineSkipped.length);
	assert.deepEqual(sourceVerification.mismatches, []);
	commandlet("GatherText", [`-config=${gatherConfig}`], "source-gather");
	gathered.length = 0;
	visit(json(join(gatherRoot, "KeyRepairs.manifest")));
	for (const outcome of sourceReceipt.actions)
		assert.ok(
			gathered.some(
				(item) => item.key === outcome.after.key && item.source === outcome.after.source
			),
			`Source gather missing ${outcome.id}`
		);
	sourceEdits = "passed_native_commandlet_only";
}
writeFileSync(
	join(run, "results.json"),
	JSON.stringify(
		{
			engine: "4.27",
			keyRepairs: "passed_native",
			offlineVerified: verification.verified,
			offlineSkipped,
			offlineSkipReason:
				"Legacy Blueprint graph pin projection is not available; package reader reports partial coverage.",
			cases: receipt.actions.map((item) => item.id),
			sourceEdits,
			stringTableMigrations: "not_run",
			transport: "commandlet",
			evidence: basename(run)
		},
		null,
		2
	)
);
console.log(
	`Unreal 4.27: ${actions.length} native key repairs; ${verification.verified} offline verified, ${offlineSkipped.length} pin reads skipped; GatherText checked: ${run}`
);
