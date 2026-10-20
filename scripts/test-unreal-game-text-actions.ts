// Plan 058 A3 acceptance on a disposable copy of the fixture project: drive the GameTextActions
// identity cases through the Game Text actions API over Remote Control, save, re-read the packages
// with the saved-package reader, then compare with Unreal's own gather table (the fixture's
// Evidence stage). The committed fixture is never written.
// --source-edits selects the cross-version nine-place commandlet lifecycle instead.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Effect, Stream } from "effect";
import {
	gameTextActionForOccurrence,
	gameTextActionsRequest,
	runGameTextActions,
	verifyGameTextActions
} from "../packages/game-text/src/text-actions.ts";
import { stripPackageNamespace } from "../packages/localization/src/text-namespace.ts";
import { verifyLocalizationStringTableRedirect } from "../packages/localization/dist/index.js";
import type { GameTextAction, GameTextActionEdit } from "../packages/protocol/src/index.ts";
import {
	assetReaderLayer,
	extractProjectTextPackages,
	type SavedAssetPackageTextRecord
} from "../packages/unreal-assets/dist/index.js";
// The built packages, so this script and the game-text source share one module instance of each.
import { RemoteControlClientLive } from "../packages/unreal-connection/dist/index.js";
import { ensureUassetExecutable } from "./native-tools.ts";
import {
	prepareUnrealPlugins,
	repositoryRoot,
	runProcess,
	ueShedPluginIds,
	unrealEngineTools,
	unrealEngineVersion
} from "./unreal-plugin-host.ts";
import { runPnpm, unrealRemoteControlLaunchArguments } from "./workbench-tools.ts";
import { acceptLocalizationMigration } from "./localization-text-actions-acceptance.ts";

const engineRoot = process.env.UE_SHED_UNREAL_ENGINE_ROOT;
if (!engineRoot)
	throw new Error("Set UE_SHED_UNREAL_ENGINE_ROOT to an Unreal 4.27, 5.6, 5.7 or 5.8 root.");
const version = unrealEngineVersion(engineRoot);
if (version?.label === "4.27") {
	await import("./test-unreal-game-text-legacy.ts");
	process.exit(0);
}
if (version?.label !== "5.6" && version?.label !== "5.7" && version?.label !== "5.8") {
	throw new Error("The Game Text actions acceptance needs Unreal 5.6, 5.7 or 5.8.");
}
if (process.argv.includes("--source-edits")) {
	await import("./test-unreal-game-text-legacy.ts");
	process.exit(0);
}
const tools = unrealEngineTools(engineRoot);
const fixture = join(repositoryRoot, "fixtures", "unreal-project");
const run = resolve(
	process.argv.slice(2).find((argument) => !argument.startsWith("--")) ??
		join(repositoryRoot, "out", "game-text-actions", `${version.label}-${Date.now()}`)
);
// A fresh directory so a stale copy or evidence cannot pass.
mkdirSync(dirname(run), { recursive: true });
mkdirSync(run, { recursive: false });
const project = join(run, "project");
const projectFile = join(project, "UEShedFixture.uproject");
const evidenceDirectory = join(run, "evidence");
const folder = "Content/Fixture/GameTextActions";
const reader = assetReaderLayer({ executable: ensureUassetExecutable() });

if (process.argv.includes("--showcase")) {
	// The root command builds public packages first. Bundle those exact outputs into Workbench
	// so this journey cannot exercise an older main-process service from a previous UI build.
	runPnpm(["--filter", "@ue-shed/workbench", "build"], process.env);
}

function log(message: string) {
	process.stdout.write(`[game-text-actions ${version?.label}] ${message}\n`);
}

// Build inside the disposable project too, so an explicit run directory controls all fixture
// build output and the committed fixture never acquires this run's binaries or caches.
cpSync(fixture, project, {
	recursive: true,
	filter: (source) => {
		const parts = relative(fixture, source).split(sep);
		return !["Binaries", "Intermediate", "Saved", "DerivedDataCache"].includes(parts[0] ?? "");
	}
});
runProcess(tools.build, [
	"UEShedFixtureEditor",
	"Win64",
	"Development",
	projectFile,
	"-NoUBTMakefiles",
	"-WaitMutex",
	"-NoHotReloadFromIDE"
]);
const descriptors = prepareUnrealPlugins({ engineRoot, projectPath: projectFile, tools });

async function readPackages(files: readonly string[]) {
	const events = await Effect.runPromise(
		Stream.runCollect(
			extractProjectTextPackages({
				projectRoot: project,
				paths: files.map((file) => join(project, folder, file))
			})
		).pipe(Effect.provide(reader))
	);
	const records = new Map<string, SavedAssetPackageTextRecord>();
	for (const event of events) {
		if (event.event !== "text_package_record") continue;
		records.set(event.path.replaceAll("\\", "/").replace(/^.*GameTextActions\//u, ""), event);
	}
	return records;
}

function occurrenceAt(
	records: ReadonlyMap<string, SavedAssetPackageTextRecord>,
	file: string,
	objectPathEnd: string,
	propertyPath: string
) {
	const found = records
		.get(file)
		?.occurrences.find(
			(occurrence) =>
				occurrence.location.kind === "asset_property" &&
				occurrence.location.object_path.endsWith(objectPathEnd) &&
				occurrence.location.property_path === propertyPath
		);
	if (!found)
		throw new Error(`The reader found no text at ${file} ${objectPathEnd} ${propertyPath}.`);
	return found;
}

async function freePort(start: number) {
	for (let port = start; port < start + 100; port += 2) {
		const available = await new Promise<boolean>((resolveAvailable) => {
			const server = createServer();
			server.once("error", () => resolveAvailable(false));
			server.listen(port, "127.0.0.1", () => server.close(() => resolveAvailable(true)));
		});
		if (available) return port;
	}
	throw new Error("No free Remote Control port.");
}

function stopEditor(pid: number | undefined) {
	if (pid === undefined) return;
	spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
		stdio: "ignore",
		windowsHide: true
	});
}

async function waitForRemoteControl(endpoint: string, alive: () => boolean) {
	const deadline = Date.now() + 600_000;
	while (Date.now() < deadline) {
		if (!alive()) throw new Error("The editor exited before Remote Control answered.");
		try {
			const response = await fetch(`${endpoint}/remote/info`, {
				signal: AbortSignal.timeout(2_000)
			});
			if (response.ok) return;
		} catch {
			// Not listening yet.
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
	}
	throw new Error("Remote Control did not answer within 10 minutes.");
}

const files = [
	"DA_ActionNotes.uasset",
	"DA_ActionNotes_Duplicate.uasset",
	"Branched/DA_ActionNotes.uasset",
	"WBP_ActionPanel.uasset",
	"WBP_ActionPanel_Duplicate.uasset",
	"Branched/WBP_ActionPanel.uasset",
	"BP_ActionSign.uasset",
	"Branched/BP_ActionSign.uasset",
	"BP_ActionSign_Duplicate.uasset"
];
const before = await readPackages(files);
const notes = occurrenceAt(before, "DA_ActionNotes.uasset", ".DA_ActionNotes", "SharedPrimary");
const panel = occurrenceAt(
	before,
	"WBP_ActionPanel.uasset",
	".WBP_ActionPanel.WidgetTree.Heading",
	"Text"
);
const greeting = occurrenceAt(
	before,
	"BP_ActionSign.uasset",
	".Default__BP_ActionSign_C",
	"Greeting"
);
const id = (occurrence: typeof notes) => {
	assert.equal(occurrence.identity.status, "resolved");
	return occurrence.identity.status === "resolved"
		? {
				namespace: stripPackageNamespace(occurrence.identity.namespace),
				key: occurrence.identity.key
			}
		: { namespace: "", key: "" };
};
const action = (
	name: string,
	file: string,
	objectPathEnd: string,
	propertyPath: string,
	edit: GameTextActionEdit
): GameTextAction => {
	const record = before.get(file);
	if (!record) throw new Error(`No package record for ${file}.`);
	const built = gameTextActionForOccurrence(
		name,
		occurrenceAt(before, file, objectPathEnd, propertyPath),
		edit,
		record.path
	);
	if (!built) throw new Error(`${name} is not an editable place.`);
	return built;
};
// One action per applicable identity case in expected-cases.json. DataTable cells stay with
// UEShedAuthoring and graph pins wait for Plan 058 A2. File-bound places also include the copied
// Blueprint whose serialized path and expected identity still equal the original's.
const copiedGreeting = occurrenceAt(
	before,
	"Branched/BP_ActionSign.uasset",
	".Default__BP_ActionSign_C",
	"Greeting"
);
assert.deepEqual(id(copiedGreeting), id(greeting));
assert.equal(copiedGreeting.source, greeting.source);
assert.equal(copiedGreeting.location.object_path, greeting.location.object_path);
const originalBlueprintBytes = readFileSync(join(project, folder, "BP_ActionSign.uasset"));
const actions = [
	action(
		"greeting-branch",
		"Branched/BP_ActionSign.uasset",
		".Default__BP_ActionSign_C",
		"Greeting",
		{ kind: "regenerate_key" }
	),
	// A readable key for the original data asset text...
	action("notes", "DA_ActionNotes.uasset", ".DA_ActionNotes", "SharedPrimary", {
		kind: "change_key",
		namespace: "ActionNotes",
		key: "KeepTheLampLit"
	}),
	// ..."Duplicate, data asset": the duplicate adopts it, so both are one text again.
	action(
		"notes-duplicate",
		"DA_ActionNotes_Duplicate.uasset",
		".DA_ActionNotes_Duplicate",
		"SharedPrimary",
		{
			kind: "adopt_key",
			namespace: "ActionNotes",
			key: "KeepTheLampLit",
			source: notes.source
		}
	),
	// "Branch copy, data asset, retyped": one id with two texts; the branch gets its own key.
	action("notes-branch", "Branched/DA_ActionNotes.uasset", ".DA_ActionNotes", "SharedPrimary", {
		kind: "regenerate_key"
	}),
	// "Branch copy, widget, retyped": the same, through the Widget Blueprint's own tree.
	action(
		"panel-branch",
		"Branched/WBP_ActionPanel.uasset",
		".WBP_ActionPanel.WidgetTree.Heading",
		"Text",
		{
			kind: "regenerate_key"
		}
	),
	// "Duplicate, widget, retyped": the duplicate takes the original's id and text.
	action(
		"panel-duplicate",
		"WBP_ActionPanel_Duplicate.uasset",
		".WBP_ActionPanel_Duplicate.WidgetTree.Heading",
		"Text",
		{ kind: "adopt_key", ...id(panel), source: panel.source }
	),
	// "Duplicate, Blueprint variable default": the duplicate's class default adopts the original's id.
	action(
		"greeting-duplicate",
		"BP_ActionSign_Duplicate.uasset",
		".Default__BP_ActionSign_Duplicate_C",
		"Greeting",
		{
			kind: "adopt_key",
			...id(greeting),
			source: greeting.source
		}
	),
	// "Duplicate, component template": retyping the only use of an id keeps its key.
	action(
		"plate-duplicate",
		"BP_ActionSign_Duplicate.uasset",
		".BP_ActionSign_Duplicate_C.Plate_GEN_VARIABLE",
		"Text",
		{ kind: "change_source", source: "Harbour Road" }
	)
];

const port = await freePort(30_210);
const endpoint = `http://127.0.0.1:${port}`;
log(`launching the editor on ${basename(projectFile)} with Remote Control at ${endpoint}`);
const editorArguments = [
	projectFile,
	"/Engine/Maps/Templates/Template_Default",
	...descriptors.map((descriptor) => `-PLUGIN=${descriptor}`),
	...unrealRemoteControlLaunchArguments(ueShedPluginIds, port),
	"-unattended",
	"-nop4",
	"-nosplash",
	"-RenderOffscreen",
	`-abslog=${join(run, "editor.log")}`
];
const editor = spawn(tools.editor, editorArguments, {
	cwd: project,
	stdio: "ignore",
	windowsHide: true
});
let exited = false;
editor.once("exit", () => {
	exited = true;
});
let result: Awaited<ReturnType<typeof applyActions>> | undefined;
async function applyActions() {
	const send = (mode: "dry_run" | "apply") =>
		Effect.runPromise(
			runGameTextActions({
				endpoint,
				request: gameTextActionsRequest({ mode, save: mode === "apply", actions })
			}).pipe(Effect.provide(RemoteControlClientLive))
		);
	const dryRun = await send("dry_run");
	writeFileSync(join(run, "dry-run.json"), `${JSON.stringify(dryRun, null, "\t")}\n`);
	assert.equal(dryRun.status, "ok", JSON.stringify(dryRun.errors));
	assert.deepEqual(
		dryRun.actions.map((item) => item.status),
		actions.map(() => "planned")
	);
	const applied = await send("apply");
	writeFileSync(join(run, "apply.json"), `${JSON.stringify(applied, null, "\t")}\n`);
	if (applied.status === "ok") {
		const unchangedOriginal = await Effect.runPromise(
			runGameTextActions({
				endpoint,
				request: gameTextActionsRequest({
					mode: "dry_run",
					actions: [
						action(
							"original-unchanged",
							"BP_ActionSign.uasset",
							".Default__BP_ActionSign_C",
							"Greeting",
							{
								kind: "change_source",
								source: greeting.source
							}
						)
					]
				})
			}).pipe(Effect.provide(RemoteControlClientLive))
		);
		writeFileSync(
			join(run, "original-live.json"),
			`${JSON.stringify(unchangedOriginal, null, "\t")}\n`
		);
		assert.equal(unchangedOriginal.status, "ok", JSON.stringify(unchangedOriginal.errors));
		assert.equal(unchangedOriginal.actions[0]?.status, "unchanged");
	}
	return applied;
}
try {
	await waitForRemoteControl(endpoint, () => !exited);
	if (process.argv.includes("--showcase")) {
		log("running the Showcase ID repair journey on the disposable project");
		runPnpm(
			[
				"--filter",
				"@ue-shed/workbench",
				"exec",
				"playwright",
				"test",
				"--config",
				"e2e/playwright.config.ts",
				"game-text-id-repairs.e2e.ts"
			],
			{
				...process.env,
				UE_SHED_GAME_TEXT_ID_REPAIRS_TEST: "1",
				UE_SHED_UNREAL_INTEGRATION: "1",
				UE_SHED_PROJECT_ROOT: project,
				UE_SHED_PROJECT_NAME: "UEShedFixture",
				UE_SHED_REMOTE_CONTROL_ENDPOINT: endpoint,
				UE_SHED_UASSET_EXECUTABLE: ensureUassetExecutable(),
				UE_SHED_REMEMBER_PROJECTS: "false",
				UE_SHED_REPOSITORY_ROOT: repositoryRoot
			}
		);
	}
	log("Remote Control is up; dry run, then apply with save");
	await acceptLocalizationMigration({
		projectRoot: project,
		endpoint,
		executable: ensureUassetExecutable()
	});
	log("public localization migration completed with the old entry retained by default");
	await acceptLocalizationMigration({
		projectRoot: project,
		endpoint,
		executable: ensureUassetExecutable(),
		deleteOldEntry: true
	});
	log(
		"public localization migration verified: persisted redirect, migrated reference, explicit deletion"
	);
	result = await applyActions();
} finally {
	stopEditor(editor.pid);
}
// A fresh process must load the persisted redirect without activation from the migration client.
const restarted = spawn(tools.editor, editorArguments, {
	cwd: project,
	stdio: "ignore",
	windowsHide: true
});
let restartExited = false;
restarted.once("exit", () => {
	restartExited = true;
});
try {
	await waitForRemoteControl(endpoint, () => !restartExited);
	const redirect = await Effect.runPromise(
		verifyLocalizationStringTableRedirect({
			endpoint,
			request: {
				contract: "ue-shed-string-table-redirect",
				version: "1.0",
				tableId: "/Game/Fixture/GameTextActions/Slice2/ST_IdentityTable.ST_IdentityTable",
				oldKey: "Welcome",
				newKey: "WelcomeRenamed",
				source: "Welcome aboard",
				activate: false
			}
		}).pipe(Effect.provide(RemoteControlClientLive))
	);
	writeFileSync(join(run, "redirect-after-restart.json"), JSON.stringify(redirect, null, 2));
	assert.equal(redirect.status, "active", redirect.message);
	log("fresh editor verified the persisted redirect after old-entry deletion");
} finally {
	stopEditor(restarted.pid);
}
assert.ok(result);
assert.equal(result.status, "ok", JSON.stringify(result.errors));
assert.deepEqual(
	result.actions.map((item) => [item.id, item.status]),
	actions.map((item) => [item.id, "applied"])
);
assert.ok(
	result.packages.every((item) => item.saved),
	JSON.stringify(result.packages)
);
assert.equal(result.packages.length, 7);
assert.deepEqual(
	readFileSync(join(project, folder, "BP_ActionSign.uasset")),
	originalBlueprintBytes
);
assert.ok(result.blueprints.every((item) => item.compiled));
const request = gameTextActionsRequest({ mode: "apply", save: true, actions });

// Re-read with the saved-package reader: each place holds what the editor reported.
const after = await readPackages(files);
const verification = verifyGameTextActions(request, result, [...after.values()]);
assert.deepEqual(verification.mismatches, []);
assert.equal(verification.verified, actions.length);
assert.equal(verification.complete, true);
log(`re-read ${verification.verified} places; each matches the editor's result`);

// Unreal's gather table for every package after the edits.
runProcess(tools.editorCommandlet, [
	projectFile,
	"-run=UEShedBuildFixture",
	"-GameTextActionsOnly",
	"-GameTextActionsStage=Evidence",
	`-GameTextActionsEvidence=${evidenceDirectory}`,
	"-unattended",
	"-nop4",
	"-nosplash",
	"-NullRHI"
]);
const evidencePath = join(evidenceDirectory, `evidence.ue${version.label}.json`);
assert.ok(existsSync(evidencePath));
// SAFETY: written by the fixture's Evidence stage. Verified by: the site, identity and runtime-text comparisons below.
const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
	readonly packages: ReadonlyArray<{
		readonly package: string;
		readonly texts: ReadonlyArray<{
			readonly site: string;
			readonly namespace: string;
			readonly key: string;
			readonly source: string;
			readonly editorOnly: boolean;
		}>;
	}>;
};
const root = "/Game/Fixture/GameTextActions/";
const gathered = (site: string) => {
	const texts = evidence.packages
		.flatMap((entry) => entry.texts)
		.filter((text) => text.site === root + site);
	const text = texts.find((item) => !item.editorOnly) ?? texts[0];
	if (!text) throw new Error(`Unreal gathered nothing at ${site}.`);
	return text;
};
const outcome = (name: string) => {
	const found = result?.actions.find((item) => item.id === name);
	if (!found) throw new Error(`No result for ${name}.`);
	return found.after;
};

const notesText = gathered("DA_ActionNotes.DA_ActionNotes.SharedPrimary");
assert.deepEqual([notesText.namespace, notesText.key], ["ActionNotes", "KeepTheLampLit"]);
const duplicateNotes = gathered("DA_ActionNotes_Duplicate.DA_ActionNotes_Duplicate.SharedPrimary");
assert.deepEqual(
	[duplicateNotes.namespace, duplicateNotes.key, duplicateNotes.source],
	[notesText.namespace, notesText.key, notesText.source]
);
const branchNotes = gathered("Branched/DA_ActionNotes.DA_ActionNotes.SharedPrimary");
assert.equal(branchNotes.key, outcome("notes-branch").key);
assert.notEqual(branchNotes.key, id(notes).key);
const panelText = gathered("WBP_ActionPanel.WBP_ActionPanel_C:WidgetTree.Heading.Text");
const branchPanel = gathered("Branched/WBP_ActionPanel.WBP_ActionPanel_C:WidgetTree.Heading.Text");
assert.equal(branchPanel.key, outcome("panel-branch").key);
assert.notEqual(branchPanel.key, panelText.key);
const duplicatePanel = gathered(
	"WBP_ActionPanel_Duplicate.WBP_ActionPanel_Duplicate_C:WidgetTree.Heading.Text"
);
assert.deepEqual(
	[duplicatePanel.namespace, duplicatePanel.key, duplicatePanel.source],
	[panelText.namespace, panelText.key, panelText.source]
);
const greetingText = gathered("BP_ActionSign.Default__BP_ActionSign_C.Greeting");
const branchGreeting = gathered("Branched/BP_ActionSign.Default__BP_ActionSign_C.Greeting");
assert.equal(branchGreeting.key, outcome("greeting-branch").key);
assert.notEqual(branchGreeting.key, greetingText.key);
assert.equal(greetingText.key, id(greeting).key);
const duplicateGreeting = gathered(
	"BP_ActionSign_Duplicate.Default__BP_ActionSign_Duplicate_C.Greeting"
);
assert.deepEqual(
	[duplicateGreeting.namespace, duplicateGreeting.key, duplicateGreeting.source],
	[greetingText.namespace, greetingText.key, greetingText.source]
);
const plateBefore = occurrenceAt(
	before,
	"BP_ActionSign_Duplicate.uasset",
	".BP_ActionSign_Duplicate_C.Plate_GEN_VARIABLE",
	"Text"
);
const duplicatePlate = gathered(
	"BP_ActionSign_Duplicate.BP_ActionSign_Duplicate_C:Plate_GEN_VARIABLE.Text"
);
assert.deepEqual(
	[duplicatePlate.key, duplicatePlate.source],
	[id(plateBefore).key, "Harbour Road"]
);

// Every runtime text Unreal gathers from an edited package has the same id and source in the
// reader's re-read of that package.
const edited = new Set(result.packages.map((item) => item.packageName));
const readerIds = new Set<string>();
for (const [file, record] of after) {
	const packageName = `${root}${file.replace(/\.uasset$/u, "")}`;
	for (const occurrence of record.occurrences) {
		if (occurrence.identity.status !== "resolved") continue;
		readerIds.add(JSON.stringify([packageName, occurrence.identity.key, occurrence.source]));
	}
}
const missing = evidence.packages
	.filter((entry) => edited.has(entry.package))
	.flatMap((entry) =>
		entry.texts
			.filter(
				(text) =>
					!text.editorOnly &&
					!readerIds.has(JSON.stringify([entry.package, text.key, text.source]))
			)
			.map((text) => `${text.site}: ${text.source}`)
	);
assert.deepEqual(missing, []);
log(
	`${actions.length} actions applied through Remote Control; re-read ids match Unreal's gather in ${edited.size} packages.`
);
