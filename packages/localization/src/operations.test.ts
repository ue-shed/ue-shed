import { mkdtemp, mkdir, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Deferred, Effect, Fiber, Layer, Ref, Stream, Result } from "effect";
import { TestClock } from "effect/testing";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
	makeEngineInstallationDiscoveryTestLayer,
	makeOwnedProcessTreeTestLayer,
	unrealEditorCommandletExecutable,
	EngineInstallationError,
	type OwnedProcessTreeHandle,
	type OwnedProcessExit
} from "@ue-shed/engine";
import { LocalizationEvidence, LocalizationEvidenceNodeLive } from "./service.js";
import { LocalizationOperations, LocalizationOperationsLive } from "./operations.js";
import { readLocalizationLogChunk, validateLocalizationOutputPath } from "./operation-io.js";

function fixture() {
	return Effect.acquireRelease(
		Effect.promise(async () => {
			const root = await mkdtemp(join(tmpdir(), "ue-shed-localization-operation-test-"));
			const project = join(root, "project");
			await cp(resolve("fixtures/unreal-427-localization"), project, { recursive: true });
			const engine = join(root, "engine");
			const executable = unrealEditorCommandletExecutable(engine, process.platform, {
				major: 4,
				minor: 27,
				patch: 2
			});
			await mkdir(dirname(executable), { recursive: true });
			await writeFile(executable, "");
			return { root, project, engine };
		}),
		({ root }) => Effect.promise(() => rm(root, { recursive: true, force: true }))
	);
}
function target(projectRoot: string) {
	return Effect.gen(function* () {
		const reader = yield* LocalizationEvidence;
		const discovery = yield* reader.discover({ projectRoot });
		const target = discovery.targets[0];
		if (!target) throw new Error("Fixture recipe missing.");
		return target;
	}).pipe(Effect.provide(LocalizationEvidenceNodeLive));
}
it.effect("engine discovery failures are actionable and discard private candidate paths", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const paths = yield* fixture();
			const selected = yield* target(paths.project);
			const codes = [
				"engine_not_found",
				"engine_ambiguous"
			] satisfies readonly EngineInstallationError["code"][];
			for (const code of codes) {
				const layer = LocalizationOperationsLive.pipe(
					Layer.provide(
						makeEngineInstallationDiscoveryTestLayer(() =>
							Effect.fail(
								new EngineInstallationError({
									code,
									message: "private-installation",
									recovery: "private-project",
									retrySafe: true,
									candidates: ["private-installation"]
								})
							)
						)
					),
					Layer.provide(
						makeOwnedProcessTreeTestLayer(() => Effect.die("Unexpected launch."))
					)
				);
				const result = yield* Effect.flatMap(LocalizationOperations, (service) =>
					service.plan({
						projectRoot: paths.project,
						target: selected,
						operation: "gather"
					})
				).pipe(Effect.provide(layer), Effect.result);
				if (Result.isSuccess(result)) throw new Error("Expected engine discovery failure.");
				expect(result.failure.code).toBe(code);
				expect(result.failure.recovery).toContain("--engine-root");
				expect(JSON.stringify(result.failure)).not.toContain("private-installation");
				expect(JSON.stringify(result.failure)).not.toContain("private-project");
			}
		})
	)
);
it.effect("streams bounded progress, audits planned/unplanned writes, and releases the tree", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const paths = yield* fixture();
			const selected = yield* target(paths.project);
			const terminated = yield* Ref.make(false);
			const processes = makeOwnedProcessTreeTestLayer((options) =>
				Effect.gen(function* () {
					const logPath = options.args
						.find((arg) => arg.startsWith("-abslog="))
						?.slice(8);
					if (!logPath) throw new Error("No private log argument.");
					const handle: OwnedProcessTreeHandle = {
						pid: 12345,
						awaitExit: Effect.promise(async () => {
							await writeFile(
								logPath,
								"LogGatherTextCommandlet: Display: Executing GatherTextStep3: InternationalizationExportCommandlet\nLogGatherTextCommandlet: Display: Completed GatherTextStep3: InternationalizationExportCommandlet in 0.1 seconds\n"
							);
							await writeFile(
								join(
									paths.project,
									"Content/Localization/Fixture427/de/Fixture427.po"
								),
								"simulated engine export"
							);
							await writeFile(
								join(paths.project, "Unplanned.txt"),
								"simulated unexpected write"
							);
							return {
								kind: "exited",
								exitCode: 0,
								signal: null
							} satisfies OwnedProcessExit;
						}),
						terminate: () =>
							Ref.set(terminated, true).pipe(
								Effect.as({
									kind: "exited",
									exitCode: 0,
									signal: null
								} satisfies OwnedProcessExit)
							)
					};
					return handle;
				})
			);
			const layer = LocalizationOperationsLive.pipe(
				Layer.provide(
					makeEngineInstallationDiscoveryTestLayer(() =>
						Effect.succeed({
							root: paths.engine,
							version: { major: 4, minor: 27, patch: 2 }
						})
					)
				),
				Layer.provide(processes)
			);
			const events = yield* Effect.flatMap(LocalizationOperations, (service) =>
				service
					.run({ projectRoot: paths.project, target: selected, operation: "export" })
					.pipe(Stream.runCollect)
			).pipe(Effect.provide(layer));
			const receipt = events.find((event) => event.type === "receipt");
			if (!receipt || receipt.type !== "receipt") throw new Error("No receipt.");
			expect(receipt.status).toBe("planning_defect");
			expect(receipt.diagnostics).toEqual([
				{ code: "unplanned_file_change", relativePath: "Unplanned.txt" }
			]);
			expect(receipt.changes.find((file) => file.relativePath.endsWith(".po"))?.planned).toBe(
				true
			);
			expect(events.filter((event) => event.type === "progress")).toHaveLength(2);
			expect(yield* Ref.get(terminated)).toBe(true);
		})
	)
);
it.effect("stream cancellation terminates the owned process and does not wait for a receipt", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const paths = yield* fixture();
			const selected = yield* target(paths.project);
			const terminated = yield* Ref.make(false);
			const processes = makeOwnedProcessTreeTestLayer(() =>
				Effect.succeed({
					pid: 12345,
					awaitExit: Effect.never,
					terminate: () =>
						Ref.set(terminated, true).pipe(
							Effect.as({
								kind: "terminated",
								exitCode: null,
								signal: null,
								reason: "cancelled"
							} satisfies OwnedProcessExit)
						)
				})
			);
			const layer = LocalizationOperationsLive.pipe(
				Layer.provide(
					makeEngineInstallationDiscoveryTestLayer(() =>
						Effect.succeed({
							root: paths.engine,
							version: { major: 4, minor: 27, patch: 2 }
						})
					)
				),
				Layer.provide(processes)
			);
			const events = yield* Effect.flatMap(LocalizationOperations, (service) =>
				service
					.run({ projectRoot: paths.project, target: selected, operation: "gather" })
					.pipe(Stream.take(1), Stream.runCollect)
			).pipe(Effect.provide(layer));
			expect(events[0]).toMatchObject({
				schemaVersion: 1,
				type: "process_started",
				pid: 12345,
				logPath: expect.any(String)
			});
			expect(yield* Ref.get(terminated)).toBe(true);
		})
	)
);
it.effect("nonzero exits expose only private bounded log excerpts and safe messages", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const paths = yield* fixture();
			const selected = yield* target(paths.project);
			const processes = makeOwnedProcessTreeTestLayer((options) => {
				const logPath = options.args.find((arg) => arg.startsWith("-abslog="))?.slice(8);
				if (!logPath) throw new Error("No log argument.");
				return Effect.succeed({
					pid: 12345,
					awaitExit: Effect.promise(async () => {
						await writeFile(logPath, "secret-term\n");
						return {
							kind: "exited",
							exitCode: 1,
							signal: null
						} satisfies OwnedProcessExit;
					}),
					terminate: () =>
						Effect.succeed({
							kind: "exited",
							exitCode: 1,
							signal: null
						} satisfies OwnedProcessExit)
				});
			});
			const layer = LocalizationOperationsLive.pipe(
				Layer.provide(
					makeEngineInstallationDiscoveryTestLayer(() =>
						Effect.succeed({
							root: paths.engine,
							version: { major: 4, minor: 27, patch: 2 }
						})
					)
				),
				Layer.provide(processes)
			);
			const result = yield* Effect.flatMap(LocalizationOperations, (service) =>
				service
					.run({ projectRoot: paths.project, target: selected, operation: "gather" })
					.pipe(Stream.runDrain)
			).pipe(Effect.provide(layer), Effect.result);
			if (Result.isSuccess(result)) throw new Error("Expected failure.");
			expect(result.failure.code).toBe("commandlet_failed");
			expect(result.failure.logExcerpt).toContain("secret-term");
			expect(result.failure.message + result.failure.recovery).not.toContain("secret-term");
		})
	)
);
it("bounds incremental log reads and rejects output traversal", async () => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-localization-log-test-"));
	try {
		const log = join(root, "log");
		await writeFile(log, "x".repeat(100_000));
		const first = await readLocalizationLogChunk(log, 0);
		expect(first.text).toHaveLength(64 * 1024);
		const second = await readLocalizationLogChunk(log, first.offset);
		expect(second.text.length + first.text.length).toBe(100_000);
		// A UTF-8 character spanning the bounded read boundary must survive the private log tail.
		const text = `${"x".repeat(64 * 1024 - 1)}é\n`;
		await writeFile(log, text);
		const decoder = new TextDecoder();
		const prefix = await readLocalizationLogChunk(log, 0, decoder);
		const suffix = await readLocalizationLogChunk(log, prefix.offset, decoder);
		expect(prefix.text + suffix.text + decoder.decode()).toBe(text);
		await expect(validateLocalizationOutputPath(root, "../escape.po")).rejects.toMatchObject({
			code: "unsafe_path"
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it.effect("a timeout stops the owned tree and remains an unsafe-to-retry typed failure", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const paths = yield* fixture();
			const selected = yield* target(paths.project);
			const ready = yield* Deferred.make<void>();
			const terminated = yield* Ref.make(false);
			const processes = makeOwnedProcessTreeTestLayer(() =>
				Effect.succeed({
					pid: 12345,
					awaitExit: Effect.never,
					terminate: () =>
						Ref.set(terminated, true).pipe(
							Effect.as({
								kind: "terminated",
								reason: "cancelled",
								exitCode: null,
								signal: null
							} satisfies OwnedProcessExit)
						)
				})
			);
			const layer = LocalizationOperationsLive.pipe(
				Layer.provide(
					makeEngineInstallationDiscoveryTestLayer(() =>
						Effect.succeed({
							root: paths.engine,
							version: { major: 4, minor: 27, patch: 2 }
						})
					)
				),
				Layer.provide(processes)
			);
			const fiber = yield* Effect.flatMap(LocalizationOperations, (service) =>
				service
					.run({
						projectRoot: paths.project,
						target: selected,
						operation: "gather",
						timeoutSeconds: 1
					})
					.pipe(
						Stream.tap((event) =>
							event.type === "process_started"
								? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
								: Effect.void
						),
						Stream.runDrain
					)
			).pipe(Effect.provide(layer), Effect.result, Effect.forkScoped);
			yield* Deferred.await(ready);
			yield* TestClock.adjust("2 seconds");
			const result = yield* Fiber.join(fiber);
			if (Result.isSuccess(result)) throw new Error("Expected timeout.");
			expect(result.failure.code).toBe("timeout");
			expect(result.failure.retrySafe).toBe(false);
			expect(yield* Ref.get(terminated)).toBe(true);
		})
	)
);
