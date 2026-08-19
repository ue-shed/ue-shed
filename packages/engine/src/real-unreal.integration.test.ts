import { RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { Effect, Layer, Schedule } from "effect";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EditorConnectionLive } from "./editor-connection.js";
import { EditorPlaySession, EditorPlaySessionLive } from "./editor-play-session.js";
import { EngineInstallationDiscoveryLive } from "./engine-installation.js";
import {
	OwnedProcessTreeLive,
	SupervisedEditorSession,
	SupervisedEditorSessionLive
} from "./supervised-editor-session.js";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT ?? "";
const enabled = process.env.UE_SHED_UNREAL_PLAY_SESSION_INTEGRATION === "1" && endpoint.length > 0;
const live = EditorPlaySessionLive.pipe(Layer.provide(RemoteControlClientLive));

describe.skipIf(!enabled)("real Unreal editor play-session lifecycle", () => {
	it("covers idempotent PIE control and a complete SIE session", async () => {
		const program = Effect.gen(function* () {
			const session = yield* EditorPlaySession;
			const waitFor = (status: "stopped" | "running" | "paused") =>
				session.status(endpoint).pipe(
					Effect.filterOrFail(
						(response) => response.state.status === status,
						() => new Error(`Play session did not reach ${status}`)
					),
					Effect.retry(
						Schedule.spaced("100 millis").pipe(
							Schedule.upTo({ duration: "10 seconds" })
						)
					)
				);

			const initial = yield* session.status(endpoint);
			if (initial.state.status !== "stopped") {
				yield* session.stop(endpoint);
				yield* waitFor("stopped");
			}

			const started = yield* session.start(endpoint, "play");
			expect(started.outcome).toBe("accepted");
			const running = yield* waitFor("running");
			expect(running.state).toMatchObject({ mode: "play", status: "running" });
			const startedAgain = yield* session.start(endpoint, "play");
			expect(startedAgain.outcome).toBe("already_satisfied");

			const paused = yield* session.pause(endpoint);
			expect(paused.outcome).toBe("accepted");
			yield* waitFor("paused");

			const resumed = yield* session.resume(endpoint);
			expect(resumed.outcome).toBe("accepted");
			yield* waitFor("running");

			const stopped = yield* session.stop(endpoint);
			expect(stopped.outcome).toBe("accepted");
			yield* waitFor("stopped");
			const stoppedAgain = yield* session.stop(endpoint);
			expect(stoppedAgain.outcome).toBe("already_satisfied");

			const simulated = yield* session.start(endpoint, "simulate");
			expect(simulated.outcome).toBe("accepted");
			const simulating = yield* waitFor("running");
			expect(simulating.state).toMatchObject({ mode: "simulate", status: "running" });
			yield* session.stop(endpoint);
			yield* waitFor("stopped");
		}).pipe(
			Effect.ensuring(
				Effect.flatMap(EditorPlaySession, (session) =>
					session.stop(endpoint).pipe(Effect.ignore)
				)
			)
		);

		await Effect.runPromise(program.pipe(Effect.provide(live)));
	});
});

const supervisedEngineRoot = process.env.UE_SHED_ENGINE_ROOT ?? "";
const supervisedEnabled =
	process.platform !== "win32" &&
	process.env.UE_SHED_UNREAL_SUPERVISED_SESSION_INTEGRATION === "1" &&
	supervisedEngineRoot.length > 0;
const supervisedLive = SupervisedEditorSessionLive.pipe(
	Layer.provide(
		Layer.mergeAll(
			EngineInstallationDiscoveryLive,
			OwnedProcessTreeLive,
			EditorConnectionLive.pipe(Layer.provide(RemoteControlClientLive))
		)
	)
);

describe.skipIf(!supervisedEnabled)("real supervised Unreal editor lifecycle", () => {
	it("reaches the UEShedCore capability manifest and tears down its process group", async () => {
		const projectDescriptor = resolve("fixtures/unreal-project/UEShedFixture.uproject");
		const pluginDescriptor = resolve("unreal/Plugins/UEShedCore/UEShedCore.uplugin");
		const program = Effect.scoped(
			Effect.gen(function* () {
				const sessions = yield* SupervisedEditorSession;
				const session = yield* sessions.acquire({
					explicitEngineRoot: supervisedEngineRoot,
					expectedProjectName: "UEShedFixture",
					plugins: [{ descriptor: pluginDescriptor, id: "UEShedCore" }],
					projectDescriptor,
					readinessTimeoutMs: 180_000,
					remoteControlHttpPort: 30_101,
					requiredCapabilities: ["editor.play-session.v1"],
					terminationTimeoutMs: 30_000
				});
				expect(session.manifest).toMatchObject({
					producerKind: "unreal_editor",
					projectName: "UEShedFixture",
					schemaVersion: 1
				});
			})
		).pipe(Effect.provide(supervisedLive));
		await Effect.runPromise(program);
	});
});
