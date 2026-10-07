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
	parsePO,
	serializePO,
	type LocalizationTarget,
	type LocalizationOperationReceipt
} from "../packages/localization/src/index.ts";
import {
	TextCorpusService,
	TextCorpusServiceLive,
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
		const translated = joinLocalizationTarget(corpus, before, target).lines.find(
			(line) =>
				line.origin.kind === "corpus" &&
				line.identity &&
				line.cultures.find((culture) => culture.culture === "de")?.state === "translated"
		);
		assert(
			translated?.identity,
			"No up-to-date corpus translation is available for the sync proof."
		);
		const selectedIdentity = translated.identity;
		const block = culture.po.value.blocks.find(
			(block) =>
				block.entry?.identity?.namespace === selectedIdentity.namespace &&
				block.entry.identity.key === selectedIdentity.key &&
				block.fields.some((field) => field.name === "msgstr")
		);
		assert(block?.entry?.identity);
		const identity = block.entry.identity;
		// Test-only replacement of one msgstr field through the lossless PO model, not a writer API.
		const document = culture.po.value;
		const edited = {
			...document,
			blocks: document.blocks.map((candidate) => {
				if (candidate !== block) return candidate;
				const field = candidate.fields.find((field) => field.name === "msgstr");
				assert(field && field.lineIndices.length > 0);
				const first = field.lineIndices[0];
				return {
					...candidate,
					lines: candidate.lines.flatMap((line, index) =>
						index === first
							? [{ ...line, text: 'msgstr "Process lane translation"' }]
							: field.lineIndices.includes(index)
								? []
								: [line]
					)
				};
			})
		};
		const bytes = serializePO(edited);
		const reparsed = parsePO(bytes, { format: document.format });
		assert(Result.isSuccess(reparsed));
		await writeFile(join(project, culture.po.provenance.relativePath), bytes);
		const pending = joinLocalizationTarget(corpus, await readEvidence(), target).lines.find(
			(line) =>
				line.identity?.namespace === identity.namespace &&
				line.identity.key === identity.key
		);
		assert.equal(
			pending?.cultures.find((culture) => culture.culture === "de")?.state,
			"not_synced"
		);
		await runOperation("sync", project, target, engine);
		const synced = joinLocalizationTarget(corpus, await readEvidence(), target).lines.find(
			(line) =>
				line.identity?.namespace === identity.namespace &&
				line.identity.key === identity.key
		);
		assert.equal(
			synced?.cultures.find((culture) => culture.culture === "de")?.state,
			"translated"
		);
	}
	console.log(
		`Localization processes ${engine.label}: plans, supported operations, audit and cancellation passed${legacy ? "" : ", including PO sync"}.`
	);
}
console.log(`Retained disposable projects, plans, receipts and private logs under ${output}.`);
