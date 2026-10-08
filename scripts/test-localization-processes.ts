import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Layer, Ref, Result, Schema, Stream } from "effect";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationOperations,
	LocalizationOperationsNodeLive,
	LocalizationOperation,
	LocalizationOperationPlan,
	LocalizationOperationError,
	availableLocalizationOperations,
	currentLocalizationTranslation,
	LocalizationFileAccessLive,
	readLocalizationReview,
	type LocalizationTarget,
	type LocalizationOperationReceipt
} from "../packages/localization/src/index.ts";
import {
	TextCorpusService,
	TextCorpusServiceLive,
	applyLocalizationReview,
	joinLocalizationTarget
} from "../packages/game-text/src/index.ts";
import { runCli } from "../apps/cli/src/command.ts";
import { CliRuntime } from "../apps/cli/src/cli-runtime.ts";
import { readerLayer } from "../apps/cli/src/cli-operation.ts";
import { ensureUassetExecutable, repositoryRoot } from "./native-tools.ts";
import { runProcess, unrealEngineTools } from "./unreal-plugin-host.ts";

const EngineLane = Schema.Struct({
	label: Schema.Literals(["5.7", "5.8", "4.27"]),
	root: Schema.NonEmptyString
});
type EngineLane = typeof EngineLane.Type;
const configured: EngineLane[] = [];
for (const [label, variable] of [
	["5.7", "UE_SHED_UNREAL_57_ROOT"],
	["5.8", "UE_SHED_UNREAL_58_ROOT"],
	["4.27", "UE_SHED_UNREAL_427_ROOT"]
]) {
	const root = variable ? process.env[variable] : undefined;
	if (root) configured.push(Schema.decodeUnknownSync(EngineLane)({ label, root: resolve(root) }));
}
if (!configured.length)
	throw new Error(
		"Configure UE_SHED_UNREAL_57_ROOT / UE_SHED_UNREAL_58_ROOT (optional UE_SHED_UNREAL_427_ROOT). This lane never silently skips every engine."
	);
// Keep the disposable project root short: UBT's intermediate paths otherwise pass Windows' 260
// character limit inside a deep checkout. The engine matrix uses the same short shape.
const output = resolve(repositoryRoot, "out", `loc-processes-${randomUUID().slice(0, 6)}`);
await mkdir(output, { recursive: true });
if (process.platform === "win32") {
	runProcess("cargo", ["build", "--locked", "-p", "engine-process-supervisor"]);
	const targetRoot = process.env.CARGO_TARGET_DIR
		? resolve(repositoryRoot, process.env.CARGO_TARGET_DIR)
		: join(repositoryRoot, "target");
	runProcess(process.execPath, [
		join(repositoryRoot, "packages/engine-win32-x64/scripts/assemble.mts"),
		"--source",
		join(targetRoot, "debug/ue-shed-process-supervisor.exe")
	]);
}
const retainedLog = async (source: string, destination: string) => {
	await mkdir(dirname(destination), { recursive: true });
	try {
		await copyFile(source, destination);
	} catch {
		await writeFile(
			destination,
			"The process stopped before creating its private Unreal log.\n"
		);
	}
};
/** Runs `ue-shed loc apply` in-process and returns its NDJSON output lines and exit code. */
async function applyThroughCli(
	projectRoot: string,
	changesFile: string,
	engine: EngineLane,
	...flags: string[]
): Promise<{ readonly code: number; readonly lines: readonly unknown[] }> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const output = yield* Ref.make("");
			const code = yield* Ref.make(0);
			const runtime = Layer.succeed(
				CliRuntime,
				CliRuntime.of({
					print: (value) => Ref.update(output, (text) => text + value),
					printError: () => Effect.void,
					setExitCode: (value) => Ref.set(code, value)
				})
			);
			yield* runCli([
				"loc",
				"apply",
				projectRoot,
				"--changes",
				changesFile,
				"--engine-root",
				engine.root,
				"--json",
				...flags
			]).pipe(Effect.provide(runtime));
			const text = yield* Ref.get(output);
			return {
				code: yield* Ref.get(code),
				lines: text
					.split("\n")
					.filter((line) => line.trim() !== "")
					.map((line) =>
						Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(line)
					)
			};
		})
	);
}

/** Runs `ue-shed loc review` in-process; returns its exit code. */
async function reviewThroughCli(...args: string[]): Promise<number> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const code = yield* Ref.make(0);
			const runtime = Layer.succeed(
				CliRuntime,
				CliRuntime.of({
					print: () => Effect.void,
					printError: () => Effect.void,
					setExitCode: (value) => Ref.set(code, value)
				})
			);
			yield* runCli(["loc", "review", ...args]).pipe(Effect.provide(runtime));
			return yield* Ref.get(code);
		})
	);
}

async function capturePlan(
	operation: LocalizationOperation,
	projectRoot: string,
	target: LocalizationTarget,
	engine: EngineLane
): Promise<LocalizationOperationPlan> {
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const output = yield* Ref.make("");
			const code = yield* Ref.make(0);
			const runtime = Layer.succeed(
				CliRuntime,
				CliRuntime.of({
					print: (value) => Ref.update(output, (text) => text + value),
					printError: () => Effect.void,
					setExitCode: (value) => Ref.set(code, value)
				})
			);
			yield* runCli([
				"loc",
				"run",
				operation,
				projectRoot,
				"--target",
				target.name,
				"--engine-root",
				engine.root,
				"--plan"
			]).pipe(Effect.provide(runtime));
			assert.equal(yield* Ref.get(code), 0);
			return Schema.decodeUnknownSync(Schema.fromJsonString(LocalizationOperationPlan))(
				yield* Ref.get(output)
			);
		})
	);
	assert.equal(result.engine, engine.label);
	await writeFile(
		join(output, engine.label, `${operation}.plan.json`),
		`${JSON.stringify(result, null, 2)}\n`
	);
	return result;
}
async function runOperation(
	operation: LocalizationOperation,
	projectRoot: string,
	target: LocalizationTarget,
	engine: EngineLane
): Promise<LocalizationOperationReceipt> {
	const outcome = await Effect.runPromise(
		Effect.flatMap(LocalizationOperations, (service) =>
			service
				.run({
					operation,
					projectRoot,
					target,
					explicitEngineRoot: engine.root,
					timeoutSeconds: 1800
				})
				.pipe(Stream.runCollect)
		).pipe(Effect.provide(LocalizationOperationsNodeLive), Effect.result)
	);
	if (Result.isFailure(outcome)) {
		if (!(outcome.failure instanceof LocalizationOperationError))
			throw new Error(
				"Engine environment configuration could not be read; check ProgramFiles / ProgramData and retry the plan."
			);
		if (outcome.failure.logPath)
			await retainedLog(
				outcome.failure.logPath,
				join(output, engine.label, `${operation}-failure.log`)
			);
		throw outcome.failure;
	}
	const receipt = outcome.success.find((event) => event.type === "receipt");
	assert(receipt && receipt.type === "receipt", "The process did not produce a receipt.");
	await retainedLog(
		receipt.logPath,
		join(output, engine.label, `${operation}-${randomUUID()}.log`)
	);
	await writeFile(
		join(output, engine.label, `${operation}.receipt.json`),
		`${JSON.stringify(receipt, null, 2)}\n`
	);
	assert.equal(receipt.status, "completed", "A changed file was not in the reviewed plan.");
	assert.equal(receipt.diagnostics.length, 0);
	assert(receipt.changes.every((file) => file.planned));
	return receipt;
}
function assertStopped(pid: number, projectRoot: string): void {
	assert.throws(() => process.kill(pid, 0), "The cancelled owned root survived.");
	if (process.platform === "win32") {
		// Structured process inventory, with the project path passed via the environment, not shell code.
		const query = spawnSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"@(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'UnrealEditor-Cmd.exe' -or $_.Name -eq 'UE4Editor-Cmd.exe') -and $_.CommandLine.Contains($env:UE_SHED_CANCEL_AUDIT_PROJECT) } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"
			],
			{
				encoding: "utf8",
				windowsHide: true,
				env: { ...process.env, UE_SHED_CANCEL_AUDIT_PROJECT: projectRoot }
			}
		);
		if (query.error) throw query.error;
		assert.equal(query.status, 0);
		assert(
			["", "null", "[]"].includes(query.stdout.trim()),
			"A commandlet descendant from the cancelled project survived."
		);
	} else {
		assert.throws(() => process.kill(-pid, 0), "The cancelled owned process group survived.");
	}
}
for (const engine of configured) {
	const directory = join(output, engine.label);
	await mkdir(directory, { recursive: true });
	const project = join(directory, "p");
	const legacy = engine.label === "4.27";
	await cp(
		join(repositoryRoot, "fixtures", legacy ? "unreal-427-localization" : "unreal-project"),
		project,
		{
			recursive: true,
			filter: (path) =>
				![
					"Binaries",
					"Intermediate",
					"Saved",
					"DerivedDataCache",
					".vs",
					"FixtureExpected"
				].includes(basename(path))
		}
	);
	if (!legacy) {
		const descriptorPath = join(project, "UEShedFixture.uproject");
		const descriptor = Schema.decodeUnknownSync(
			Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
		)(await readFile(descriptorPath, "utf8"));
		await writeFile(
			descriptorPath,
			JSON.stringify({ ...descriptor, EngineAssociation: engine.label }, null, 2)
		);
		if (process.platform !== "win32")
			throw new Error(
				"The module-backed fixture build currently requires the Windows fixture toolchain."
			);
		runProcess(unrealEngineTools(engine.root).build, [
			"UEShedFixtureEditor",
			"Win64",
			"Development",
			descriptorPath,
			"-NoUBTMakefiles",
			"-WaitMutex",
			"-NoHotReloadFromIDE"
		]);
	}
	const target = await Effect.runPromise(
		Effect.flatMap(LocalizationEvidence, (reader) =>
			reader.discover({ projectRoot: project })
		).pipe(Effect.provide(LocalizationEvidenceNodeLive))
	).then((result) =>
		result.targets.find((target) => target.name === (legacy ? "Fixture427" : "FixtureGame"))
	);
	assert(target, "Disposable target was not discovered.");
	const operations = availableLocalizationOperations(target);
	for (const operation of operations) await capturePlan(operation, project, target, engine);
	// Review state is UE Shed's own file: Unreal's gather, import, export and compile must leave it
	// alone, and a line nobody edits must still read as reviewed afterwards.
	const reviewedLine = "Fixture.Localization.Table,Welcome";
	const reviewPath = join(project, "Config/UEShed/Localization/FixtureGame.review.json");
	if (!legacy)
		assert.equal(
			await reviewThroughCli(
				"set",
				project,
				"--target",
				target.name,
				"--culture",
				"de",
				"--flag",
				"reviewed",
				"--flag",
				"proofread",
				"--line",
				reviewedLine,
				"--by",
				"process-lane"
			),
			0
		);
	const reviewBytes = legacy ? undefined : await readFile(reviewPath);
	for (const operation of legacy
		? operations
		: Schema.decodeUnknownSync(Schema.Array(LocalizationOperation))([
				"export",
				"import",
				"compile",
				"gather",
				"reports",
				"sync"
			]))
		await runOperation(operation, project, target, engine);
	// The first event is emitted after launch; ending this stream must release the owned tree.
	const cancelled = await Effect.runPromise(
		Effect.flatMap(LocalizationOperations, (service) =>
			service
				.run({
					operation: "gather",
					projectRoot: project,
					target,
					explicitEngineRoot: engine.root
				})
				.pipe(Stream.take(1), Stream.runCollect)
		).pipe(Effect.provide(LocalizationOperationsNodeLive))
	);
	const started = cancelled[0];
	assert(started?.type === "process_started");
	assertStopped(started.pid, project);
	await retainedLog(started.logPath, join(output, engine.label, "cancelled.log"));
	if (!legacy) {
		const corpus = await Effect.runPromise(
			Effect.flatMap(TextCorpusService, (service) =>
				service.scan({ projectRoot: project })
			).pipe(
				Effect.provide(TextCorpusServiceLive),
				Effect.provide(
					readerLayer(process.env.UE_SHED_UASSET_EXECUTABLE ?? ensureUassetExecutable())
				)
			)
		);
		const readEvidence = () =>
			Effect.runPromise(
				Effect.flatMap(LocalizationEvidence, (reader) =>
					reader.read({ projectRoot: project, target })
				).pipe(Effect.provide(LocalizationEvidenceNodeLive))
			);
		const before = await readEvidence();
		const culture = before.cultures.find((culture) => culture.culture === "de");
		assert(culture?.po.status === "read");
		const translatedLines = joinLocalizationTarget(corpus, before, target).lines.filter(
			(line) =>
				line.origin.kind === "corpus" &&
				line.identity &&
				line.identity.key !== "Welcome" &&
				line.cultures.find((culture) => culture.culture === "de")?.state === "translated"
		);
		const [first, second] = translatedLines;
		assert(
			first?.identity && second?.identity,
			"Two up-to-date corpus translations are needed for the edit proof."
		);
		const manifest = before.manifest.status === "read" ? before.manifest.value : undefined;
		assert(manifest);
		// Proposals are built from evidence exactly as a host would: source from the manifest,
		// the replaced translation from what ships next.
		const proposal = (identity: NonNullable<typeof first.identity>, translation: string) => {
			const entry =
				culture.po.status === "read"
					? culture.po.value.blocks.find(
							(block) =>
								block.entry?.identity?.namespace === identity.namespace &&
								block.entry.identity.key === identity.key
						)?.entry
					: undefined;
			const archive =
				culture.archive.status === "read"
					? (culture.archive.value.entries.find(
							(item) =>
								item.namespace === identity.namespace && item.key === identity.key
						)?.translation.Text ?? null)
					: null;
			const source = manifest.entries.find(
				(item) => item.namespace === identity.namespace && item.key === identity.key
			)?.source.Text;
			assert(source !== undefined);
			return {
				target: target.name,
				culture: "de",
				namespace: identity.namespace,
				key: identity.key,
				source,
				previousTranslation: currentLocalizationTranslation(archive, entry),
				translation
			};
		};
		const changeFile = async (name: string, changes: readonly unknown[]) => {
			const path = join(output, engine.label, name);
			await writeFile(
				path,
				`${JSON.stringify({ schemaVersion: 1, provenance: { producer: "process-lane", files: [] }, changes })}\n`
			);
			return path;
		};
		const firstChanges = await changeFile("first.changes.json", [
			proposal(first.identity, "Process lane translation")
		]);
		const review = await applyThroughCli(project, firstChanges, engine, "--review");
		assert.equal(review.code, 0);
		assert.match(JSON.stringify(review.lines), /"outcome":"ready"/u);
		const written = await applyThroughCli(project, firstChanges, engine);
		assert.equal(written.code, 0);
		assert.match(JSON.stringify(written.lines), /"status":"written"/u);
		const stateOf = (
			join: ReturnType<typeof joinLocalizationTarget>,
			identity: NonNullable<typeof first.identity>
		) =>
			join.lines
				.find(
					(line) =>
						line.identity?.namespace === identity.namespace &&
						line.identity.key === identity.key
				)
				?.cultures.find((culture) => culture.culture === "de")?.state;
		assert.equal(
			stateOf(joinLocalizationTarget(corpus, await readEvidence(), target), first.identity),
			"not_synced"
		);
		// Re-applying the same proposal is stale now: the edit already ships next.
		const again = await applyThroughCli(project, firstChanges, engine);
		assert.equal(again.code, 2);
		assert.match(JSON.stringify(again.lines), /"status":"rejected"/u);

		const secondChanges = await changeFile("second.changes.json", [
			proposal(second.identity, "Process lane second translation")
		]);
		const synced = await applyThroughCli(project, secondChanges, engine, "--sync");
		assert.equal(synced.code, 0, JSON.stringify(synced.lines));
		assert.match(JSON.stringify(synced.lines), /"status":"completed"/u);
		const after = await readEvidence();
		const joined = joinLocalizationTarget(corpus, after, target);
		assert.equal(stateOf(joined, first.identity), "translated");
		assert.equal(stateOf(joined, second.identity), "translated");
		const archive = after.cultures.find((item) => item.culture === "de")?.archive;
		assert(archive?.status === "read");
		const archived = (identity: NonNullable<typeof first.identity>) =>
			archive.value.entries.find(
				(item) => item.namespace === identity.namespace && item.key === identity.key
			)?.translation.Text;
		assert.equal(archived(first.identity), "Process lane translation");
		assert.equal(archived(second.identity), "Process lane second translation");
		assert.deepEqual(
			await readFile(reviewPath),
			reviewBytes,
			"Unreal rewrote the review file."
		);
		const reviewState = await Effect.runPromise(
			readLocalizationReview({ projectRoot: project, target: target.name }).pipe(
				Effect.provide(LocalizationFileAccessLive)
			)
		);
		const welcome = applyLocalizationReview(joined, reviewState.file)
			.lines.find((line) => line.identity?.key === "Welcome")
			?.cultures.find((item) => item.culture === "de")?.review;
		assert.deepEqual(
			welcome?.status === "current" ? welcome.flags : welcome,
			["reviewed", "proofread"],
			"An unedited reviewed line must stay reviewed through Unreal's operations."
		);
	}
	console.log(
		`Localization processes ${engine.label}: plans, supported operations, audit and cancellation passed${legacy ? "" : ", including review state, PO writes through loc apply and sync"}.`
	);
}
console.log(`Retained disposable projects, plans, receipts and private logs under ${output}.`);
