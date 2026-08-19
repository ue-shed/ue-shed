import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { CompanionCapabilityManifest } from "@ue-shed/protocol";
import { Context, Duration, Effect, Exit, Layer, Option, Schema, type Scope } from "effect";
import {
	EngineInstallationDiscovery,
	type EngineInstallationError
} from "./engine-installation.js";
import {
	EditorConnection,
	type EditorConnectionError,
	type EditorReadinessRequest
} from "./editor-connection.js";
import {
	UnrealLaunchPlugin,
	unrealEditorExecutable,
	unrealProjectLaunchArguments
} from "./project-launcher.js";

const BoundedString = Schema.NonEmptyString.check(Schema.isMaxLength(32_767));
const BoundedCapability = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const HttpPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_534 }));
const Milliseconds = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600_000 }));

export const SupervisedEditorSessionRequest = Schema.Struct({
	explicitEngineRoot: Schema.optional(BoundedString),
	expectedProjectName: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(256))),
	plugins: Schema.Array(UnrealLaunchPlugin).check(Schema.isMaxLength(64)),
	projectDescriptor: BoundedString,
	readinessPollIntervalMs: Schema.optional(Milliseconds),
	readinessTimeoutMs: Schema.optional(Milliseconds),
	remoteControlHttpPort: HttpPort,
	requiredCapabilities: Schema.optional(
		Schema.Array(BoundedCapability).check(Schema.isMaxLength(64))
	),
	terminationTimeoutMs: Schema.optional(Milliseconds)
});
export type SupervisedEditorSessionRequest = typeof SupervisedEditorSessionRequest.Type;

export const OwnedProcessExit = Schema.Union([
	Schema.Struct({
		exitCode: Schema.NullOr(Schema.Int),
		kind: Schema.Literal("exited"),
		signal: Schema.NullOr(Schema.String)
	}),
	Schema.Struct({
		exitCode: Schema.NullOr(Schema.Int),
		kind: Schema.Literal("terminated"),
		reason: Schema.Literals(["cancelled", "failed", "released"]),
		signal: Schema.NullOr(Schema.String)
	})
]);
export type OwnedProcessExit = typeof OwnedProcessExit.Type;
export type OwnedProcessTerminationReason = Extract<
	OwnedProcessExit,
	{ readonly kind: "terminated" }
>["reason"];

export class SupervisedEditorSessionError extends Schema.TaggedErrorClass<SupervisedEditorSessionError>()(
	"SupervisedEditorSessionError",
	{
		code: Schema.Literals([
			"invalid_request",
			"engine_discovery_failed",
			"editor_missing",
			"project_missing",
			"plugin_missing",
			"process_tree_supervision_unavailable",
			"spawn_failed",
			"process_exited",
			"readiness_failed",
			"capability_unavailable",
			"termination_failed"
		]),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		stage: Schema.Literals(["validation", "launch", "readiness", "operation", "termination"])
	}
) {}

export interface OwnedProcessTreeLaunchOptions {
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
	readonly executable: string;
	readonly terminationTimeout: Duration.Input;
}

export interface OwnedProcessTreeHandle {
	readonly awaitExit: Effect.Effect<OwnedProcessExit>;
	readonly pid: number;
	readonly terminate: (
		reason: OwnedProcessTerminationReason
	) => Effect.Effect<OwnedProcessExit, SupervisedEditorSessionError>;
}

export interface OwnedProcessTreeApi {
	readonly launch: (
		options: OwnedProcessTreeLaunchOptions
	) => Effect.Effect<OwnedProcessTreeHandle, SupervisedEditorSessionError>;
}

export class OwnedProcessTree extends Context.Service<OwnedProcessTree, OwnedProcessTreeApi>()(
	"@ue-shed/engine/OwnedProcessTree"
) {}

export interface SupervisedEditorSessionHandle {
	readonly awaitExit: Effect.Effect<OwnedProcessExit>;
	readonly engineRoot: string;
	readonly executable: string;
	readonly manifest: CompanionCapabilityManifest;
	readonly pid: number;
	readonly projectDescriptor: string;
	readonly remoteControlEndpoint: string;
	readonly terminate: (
		reason?: OwnedProcessTerminationReason
	) => Effect.Effect<OwnedProcessExit, SupervisedEditorSessionError>;
}

export interface SupervisedEditorSessionApi {
	readonly acquire: (
		request: SupervisedEditorSessionRequest
	) => Effect.Effect<SupervisedEditorSessionHandle, SupervisedEditorSessionError, Scope.Scope>;
}

export class SupervisedEditorSession extends Context.Service<
	SupervisedEditorSession,
	SupervisedEditorSessionApi
>()("@ue-shed/engine/SupervisedEditorSession") {}

function sessionError(
	code: SupervisedEditorSessionError["code"],
	stage: SupervisedEditorSessionError["stage"],
	message: string,
	recovery: string,
	retrySafe = false
): SupervisedEditorSessionError {
	return new SupervisedEditorSessionError({ code, message, recovery, retrySafe, stage });
}

function engineDiscoveryError(cause: EngineInstallationError): SupervisedEditorSessionError {
	return sessionError(
		"engine_discovery_failed",
		"validation",
		cause.message,
		cause.recovery,
		cause.retrySafe
	);
}

function readinessError(cause: EditorConnectionError): SupervisedEditorSessionError {
	return sessionError(
		"readiness_failed",
		"readiness",
		cause.message,
		cause.recovery,
		cause.retrySafe
	);
}

function filesystemEntry(
	path: string,
	code: "editor_missing" | "project_missing" | "plugin_missing",
	label: string
): Effect.Effect<void, SupervisedEditorSessionError> {
	return Effect.tryPromise({
		try: () => access(path),
		catch: () =>
			sessionError(
				code,
				"validation",
				`${label} does not exist: ${path}`,
				`Choose an existing ${label.toLowerCase()} and retry.`
			)
	});
}

function rawExit(
	code: number | null,
	signal: string | null,
	reason: OwnedProcessTerminationReason | undefined
): OwnedProcessExit {
	return reason === undefined
		? { exitCode: code, kind: "exited", signal }
		: { exitCode: code, kind: "terminated", reason, signal };
}

const ErrorWithCode = Schema.Struct({ code: Schema.String });

function errorCode(cause: unknown): string | undefined {
	return Schema.is(ErrorWithCode)(cause) ? cause.code : undefined;
}

function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (cause) {
		return errorCode(cause) !== "ESRCH";
	}
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch (cause) {
		if (errorCode(cause) !== "ESRCH") throw cause;
	}
}

function waitForProcessGroupExit(pid: number): Effect.Effect<void> {
	return Effect.callback<void>((resume) => {
		if (!processGroupExists(pid)) {
			resume(Effect.void);
			return;
		}
		const interval = setInterval(() => {
			if (processGroupExists(pid)) return;
			clearInterval(interval);
			resume(Effect.void);
		}, 10);
		return Effect.sync(() => clearInterval(interval));
	});
}

function makePosixHandle(
	child: ChildProcess,
	terminationTimeout: Duration.Input
): OwnedProcessTreeHandle {
	const pid = child.pid;
	if (pid === undefined) {
		throw sessionError(
			"spawn_failed",
			"launch",
			"The supervised process started without a process identity.",
			"Check operating-system process limits and retry."
		);
	}
	let requestedReason: OwnedProcessTerminationReason | undefined;
	const exited = new Promise<OwnedProcessExit>((complete) => {
		child.once("close", (code, signal) => complete(rawExit(code, signal, requestedReason)));
	});
	child.on("error", () => undefined);
	const awaitExit = Effect.promise(() => exited);
	const terminate = Effect.fn("OwnedProcessTree.terminate")(function* (
		reason: OwnedProcessTerminationReason
	) {
		requestedReason ??= reason;
		yield* Effect.try({
			try: () => signalProcessGroup(pid, "SIGKILL"),
			catch: (cause) =>
				sessionError(
					"termination_failed",
					"termination",
					`Could not terminate owned process group ${pid}: ${String(cause)}`,
					"Terminate the owned editor process group manually before retrying.",
					true
				)
		});
		const completed = yield* Effect.all([awaitExit, waitForProcessGroupExit(pid)]).pipe(
			Effect.timeoutOption(terminationTimeout)
		);
		if (Option.isNone(completed)) {
			return yield* sessionError(
				"termination_failed",
				"termination",
				`Owned process group ${pid} did not terminate before the deadline.`,
				"Terminate the remaining process group manually before retrying.",
				true
			);
		}
		const outcome = completed.value[0];
		return rawExit(outcome.exitCode, outcome.signal, requestedReason);
	});
	return { awaitExit, pid, terminate };
}

export const OwnedProcessTreeLive = Layer.succeed(
	OwnedProcessTree,
	OwnedProcessTree.of({
		launch: Effect.fn("OwnedProcessTree.launch")((options) => {
			if (process.platform === "win32") {
				return Effect.fail(
					sessionError(
						"process_tree_supervision_unavailable",
						"launch",
						"Windows process-tree ownership requires a kill-on-close Job Object.",
						"Provide a native launcher that creates the editor suspended, assigns it to an owned Job Object, then resumes it."
					)
				);
			}
			return Effect.callback<OwnedProcessTreeHandle, SupervisedEditorSessionError>(
				(resume) => {
					const child = spawn(options.executable, [...options.args], {
						cwd: options.cwd,
						detached: true,
						shell: false,
						stdio: "ignore",
						windowsHide: true
					});
					let complete = false;
					const spawned = () => {
						complete = true;
						child.off("error", failed);
						try {
							resume(
								Effect.succeed(makePosixHandle(child, options.terminationTimeout))
							);
						} catch (cause) {
							resume(
								Effect.fail(
									cause instanceof SupervisedEditorSessionError
										? cause
										: sessionError(
												"spawn_failed",
												"launch",
												`Could not retain the supervised process identity: ${String(cause)}`,
												"Check operating-system process limits and retry."
											)
								)
							);
						}
					};
					const failed = (cause: Error) => {
						complete = true;
						child.off("spawn", spawned);
						resume(
							Effect.fail(
								sessionError(
									"spawn_failed",
									"launch",
									`Could not start the supervised editor: ${cause.message}`,
									"Verify the engine executable and project descriptor, then retry."
								)
							)
						);
					};
					child.once("spawn", spawned);
					child.once("error", failed);
					return Effect.sync(() => {
						if (complete) return;
						child.off("spawn", spawned);
						child.off("error", failed);
						if (child.pid !== undefined) signalProcessGroup(child.pid, "SIGKILL");
						else child.kill("SIGKILL");
					});
				}
			);
		})
	})
);

function releaseReason(exit: Exit.Exit<unknown, unknown>): OwnedProcessTerminationReason {
	if (Exit.hasInterrupts(exit)) return "cancelled";
	return Exit.isFailure(exit) ? "failed" : "released";
}

export const SupervisedEditorSessionLive = Layer.effect(
	SupervisedEditorSession,
	Effect.gen(function* () {
		const connections = yield* EditorConnection;
		const engines = yield* EngineInstallationDiscovery;
		const processes = yield* OwnedProcessTree;
		const acquire = Effect.fn("SupervisedEditorSession.acquire")(function* (
			input: SupervisedEditorSessionRequest
		) {
			const request = yield* Schema.decodeUnknownEffect(SupervisedEditorSessionRequest)(
				input
			).pipe(
				Effect.mapError(() =>
					sessionError(
						"invalid_request",
						"validation",
						"The supervised editor session request is invalid.",
						"Provide bounded readiness settings, one project descriptor, and valid plugin descriptors."
					)
				)
			);
			if (!isAbsolute(request.projectDescriptor)) {
				return yield* sessionError(
					"invalid_request",
					"validation",
					"The supervised project descriptor must be absolute.",
					"Resolve the .uproject path before acquiring the session."
				);
			}
			for (const plugin of request.plugins) {
				if (!isAbsolute(plugin.descriptor)) {
					return yield* sessionError(
						"invalid_request",
						"validation",
						`Plugin ${plugin.id} must use an absolute descriptor path.`,
						"Resolve every .uplugin path before acquiring the session."
					);
				}
			}
			const projectDescriptor = resolve(request.projectDescriptor);
			yield* filesystemEntry(projectDescriptor, "project_missing", "Project descriptor");
			for (const plugin of request.plugins) {
				yield* filesystemEntry(
					resolve(plugin.descriptor),
					"plugin_missing",
					"Plugin descriptor"
				);
			}
			const installation = yield* engines
				.resolve({
					projectDescriptor,
					...(request.explicitEngineRoot === undefined
						? undefined
						: { explicitRoot: request.explicitEngineRoot })
				})
				.pipe(Effect.mapError(engineDiscoveryError));
			const executable = unrealEditorExecutable(installation.root);
			yield* filesystemEntry(executable, "editor_missing", "Unreal Editor executable");
			const process = yield* Effect.acquireRelease(
				processes.launch({
					args: unrealProjectLaunchArguments({
						mode: {
							kind: "with_plugins",
							plugins: request.plugins,
							remoteControlHttpPort: request.remoteControlHttpPort
						},
						projectDescriptor
					}),
					cwd: dirname(projectDescriptor),
					executable,
					terminationTimeout: Duration.millis(request.terminationTimeoutMs ?? 15_000)
				}),
				(process, exit) => process.terminate(releaseReason(exit)).pipe(Effect.orDie),
				{ interruptible: true }
			);
			const endpoint = `http://127.0.0.1:${request.remoteControlHttpPort}`;
			const readinessRequest: EditorReadinessRequest = {
				endpoint,
				...(request.expectedProjectName === undefined
					? undefined
					: { expectedProjectName: request.expectedProjectName }),
				pollInterval: Duration.millis(request.readinessPollIntervalMs ?? 500),
				timeout: Duration.millis(request.readinessTimeoutMs ?? 180_000)
			};
			const manifest = yield* Effect.raceFirst(
				connections.waitUntilReady(readinessRequest).pipe(Effect.mapError(readinessError)),
				process.awaitExit.pipe(
					Effect.flatMap((outcome) =>
						Effect.fail(
							sessionError(
								"process_exited",
								"readiness",
								`The supervised editor exited before readiness (${JSON.stringify(outcome)}).`,
								"Inspect the editor log and launch arguments before retrying.",
								true
							)
						)
					)
				)
			);
			const missing = request.requiredCapabilities?.find(
				(capability) => !manifest.capabilities.includes(capability)
			);
			if (missing !== undefined) {
				return yield* sessionError(
					"capability_unavailable",
					"readiness",
					`The ready editor does not advertise required capability ${missing}.`,
					"Enable a compatible plugin or remove the capability from this generic session request."
				);
			}
			return {
				awaitExit: process.awaitExit,
				engineRoot: installation.root,
				executable,
				manifest,
				pid: process.pid,
				projectDescriptor,
				remoteControlEndpoint: endpoint,
				terminate: (reason = "released") => process.terminate(reason)
			} satisfies SupervisedEditorSessionHandle;
		});
		return SupervisedEditorSession.of({ acquire });
	})
);

export function makeOwnedProcessTreeTestLayer(
	launch: OwnedProcessTreeApi["launch"]
): Layer.Layer<OwnedProcessTree> {
	return Layer.succeed(OwnedProcessTree, OwnedProcessTree.of({ launch }));
}

export function makeSupervisedEditorSessionTestLayer(
	service: SupervisedEditorSessionApi
): Layer.Layer<SupervisedEditorSession> {
	return Layer.succeed(SupervisedEditorSession, SupervisedEditorSession.of(service));
}
