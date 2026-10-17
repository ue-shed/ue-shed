import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { GameTextIndexBuilder } from "./index-builder.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { SharedIndex } from "./shared-index.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

describe.skipIf(!executable)("native index lifecycle soak", () => {
	for (const phase of ["startup", "staging", "publication", "termination"] as const) {
		it(`releases the process and lease after ${phase}, then reopens committed state`, async () => {
			if (!executable) throw new Error("Native reader is required");
			const root = await mkdtemp(join(tmpdir(), "ue-shed-native-lifecycle-"));
			const pids = new Set<number>();
			const configuration = {
				cacheRoot: root,
				projectKey: "lifecycle-fixture",
				targetKey: "source",
				projectView: { kind: "source" as const }
			};
			try {
				for (let round = 0; round < 8; round++) {
					let releaseStaging: (() => void) | undefined;
					await Effect.runPromise(
						Effect.scoped(
							Effect.gen(function* () {
								const reached = yield* Deferred.make<void>();
								let requests = 0;
								let entered = false;
								const interrupted = Effect.gen(function* () {
									const builder = yield* GameTextIndexBuilder;
									return yield* builder.withSession(
										{ configuration },
										Effect.gen(function* () {
											entered = true;
											const writer = yield* (yield* SharedIndex).writer();
											yield* writer.publish("committed", `stable-${round}`, {
												columns: [
													{
														name: "probe",
														kind: "u32",
														load: async () => Uint32Array.of(round)
													}
												]
											});
											// The observer signals immediately after dispatch, before a terminal reply.
											yield* writer.publish(
												"candidate",
												`candidate-${round}`,
												{
													columns: [
														{
															name: "probe",
															kind: "u32",
															load: async () => {
																if (phase === "staging")
																	await new Promise<void>(
																		(resolve) => {
																			releaseStaging =
																				resolve;
																			Deferred.doneUnsafe(
																				reached,
																				Effect.void
																			);
																		}
																	);
																return new Uint32Array(64_000).fill(
																	round
																);
															}
														}
													]
												}
											);
											return yield* Effect.never;
										})
									);
								}).pipe(
									Effect.provide(
										nativeIndexBuilderLayer({
											executable,
											timeoutMs: 30_000,
											catalogTimeoutMs: 30_000,
											protocolObserver: (event) => {
												if (event.kind !== "worker_started") return;
												pids.add(event.pid);
												requests++;
												if (phase === "staging") return;
												if (requests !== (phase === "startup" ? 1 : 3))
													return;
												if (phase === "termination")
													process.kill(event.pid);
												Deferred.doneUnsafe(reached, Effect.void);
											}
										})
									)
								);
								const fiber = yield* Effect.forkChild(Effect.exit(interrupted));
								yield* Deferred.await(reached);
								if (phase === "termination") {
									const result = yield* Fiber.join(fiber);
									expect(Exit.isFailure(result)).toBe(true);
								} else yield* Fiber.interrupt(fiber);
								if (phase === "startup") expect(entered).toBe(false);
							})
						)
					);
					releaseStaging?.();

					await Effect.runPromise(
						Effect.scoped(
							Effect.gen(function* () {
								const builder = yield* GameTextIndexBuilder;
								yield* builder.withSession(
									{ configuration },
									Effect.gen(function* () {
										const index = yield* SharedIndex;
										if (phase !== "startup") {
											const reader = yield* index.open();
											const committed = yield* reader.layer("committed");
											expect([
												...(yield* committed.section("probe"))
											]).toEqual([round]);
										}
										const writer = yield* index.writer();
										if (phase === "staging")
											expect(
												writer.manifest().active.candidate
											).toBeUndefined();
										yield* writer.publish("recovered", `recovered-${round}`, {
											columns: [
												{
													name: "probe",
													kind: "u32",
													load: async () => Uint32Array.of(round)
												}
											]
										});
									})
								);
							})
						).pipe(
							Effect.provide(
								nativeIndexBuilderLayer({
									executable,
									timeoutMs: 30_000,
									catalogTimeoutMs: 30_000
								})
							)
						)
					);
					const remaining = await readdir(root, { recursive: true });
					expect(
						remaining.some(
							(path) => path.endsWith(".lock") || path.startsWith("native-build-")
						)
					).toBe(false);
					for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}, 120_000);
	}
});
