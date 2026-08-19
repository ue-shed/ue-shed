import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
const WindowsExitCode = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 }));
const SupervisorMessage = Schema.Union([
	Schema.Struct({
		pid: Schema.Int.check(Schema.isGreaterThan(0)),
		type: Schema.Literal("started")
	}),
	Schema.Struct({ exitCode: WindowsExitCode, type: Schema.Literal("exited") })
]);
type SupervisorMessage = typeof SupervisorMessage.Type;
const WINDOWS_SUPERVISOR_PACKAGE = "@ue-shed/engine-win32-x64";
const SUPERVISOR_OUTPUT_LIMIT = 16_384;

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
			"supervisor_failed",
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
	readonly awaitExit: Effect.Effect<OwnedProcessExit, SupervisedEditorSessionError>;
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
	readonly awaitExit: Effect.Effect<OwnedProcessExit, SupervisedEditorSessionError>;
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

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch (cause) {
		if (errorCode(cause) !== "ESRCH") throw cause;
	}
}

function linuxProcessState(stat: string) {
	const commandEnd = stat.lastIndexOf(")");
	if (commandEnd === -1)
		throw new Error("A Linux process stat record has no command terminator.");
	const fields = stat
		.slice(commandEnd + 2)
		.trim()
		.split(/\s+/u);
	const state = fields[0];
	const group = Number(fields[2]);
	if (state === undefined || !Number.isSafeInteger(group)) {
		throw new Error("A Linux process stat record has invalid state or process-group fields.");
	}
	return { group, state };
}

async function processGroupHasLiveMembers(pid: number): Promise<boolean> {
	if (process.platform !== "linux") {
		const processTable = await new Promise<string>((resolveTable, rejectTable) => {
			execFile(
				"ps",
				["-A", "-o", "pgid=,stat="],
				{ encoding: "utf8", maxBuffer: 1_048_576, windowsHide: true },
				(cause, stdout) => {
					if (cause !== null) rejectTable(cause);
					else resolveTable(stdout);
				}
			);
		});
		return processTable.split(/\r?\n/u).some((line) => {
			const [group, state] = line.trim().split(/\s+/u);
			return Number(group) === pid && state !== undefined && !state.startsWith("Z");
		});
	}
	const entries = await readdir("/proc", { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
		try {
			const processState = linuxProcessState(
				await readFile(`/proc/${entry.name}/stat`, "utf8")
			);
			if (processState.group === pid && processState.state !== "Z") return true;
		} catch (cause) {
			if (errorCode(cause) !== "ENOENT" && errorCode(cause) !== "ESRCH") throw cause;
		}
	}
	return false;
}

async function waitForProcessGroupExit(pid: number): Promise<void> {
	while (await processGroupHasLiveMembers(pid)) {
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
	}
}

function windowsSupervisorExecutable(): Effect.Effect<string, SupervisedEditorSessionError> {
	return Effect.tryPromise({
		try: async () => {
			const require = createRequire(import.meta.url);
			const packageManifest = require.resolve(`${WINDOWS_SUPERVISOR_PACKAGE}/package.json`);
			const executable = join(
				dirname(packageManifest),
				"bin",
				"ue-shed-process-supervisor.exe"
			);
			await access(executable);
			return executable;
		},
		catch: (cause) =>
			sessionError(
				"process_tree_supervision_unavailable",
				"launch",
				`The Windows Job Object supervisor is unavailable: ${String(cause)}`,
				`Install the matching optional ${WINDOWS_SUPERVISOR_PACKAGE} package and retry.`
			)
	});
}

type SupervisorCompletion =
	| { readonly exit: OwnedProcessExit; readonly ok: true }
	| { readonly error: SupervisedEditorSessionError; readonly ok: false };

function makeWindowsHandle(
	helper: ChildProcess,
	pid: number,
	completion: Promise<SupervisorCompletion>,
	terminationTimeout: Duration.Input,
	setRequestedReason: (reason: OwnedProcessTerminationReason) => void
): OwnedProcessTreeHandle {
	const awaitExit = Effect.promise(() => completion).pipe(
		Effect.flatMap((result) =>
			result.ok ? Effect.succeed(result.exit) : Effect.fail(result.error)
		)
	);
	const terminate = Effect.fn("OwnedProcessTree.terminate")(function* (
		reason: OwnedProcessTerminationReason
	) {
		setRequestedReason(reason);
		yield* Effect.try({
			try: () => helper.stdin?.end(),
			catch: (cause) =>
				sessionError(
					"termination_failed",
					"termination",
					`Could not request termination of owned Windows Job Object ${pid}: ${String(cause)}`,
					"Terminate the owned editor process tree manually before retrying.",
					true
				)
		});
		const completed = yield* awaitExit.pipe(Effect.timeoutOption(terminationTimeout));
		if (Option.isNone(completed)) {
			return yield* sessionError(
				"termination_failed",
				"termination",
				`Owned Windows Job Object ${pid} did not terminate before the deadline.`,
				"Terminate the remaining owned process tree manually before retrying.",
				true
			);
		}
		return completed.value;
	});
	return { awaitExit, pid, terminate };
}

function launchWindowsProcessTree(
	supervisor: string,
	options: OwnedProcessTreeLaunchOptions
): Effect.Effect<OwnedProcessTreeHandle, SupervisedEditorSessionError> {
	return Effect.callback<OwnedProcessTreeHandle, SupervisedEditorSessionError>((resume) => {
		const helper = spawn(
			supervisor,
			["--cwd", options.cwd, "--", options.executable, ...options.args],
			{
				detached: false,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true
			}
		);
		let launched = false;
		let settled = false;
		let requestedReason: OwnedProcessTerminationReason | undefined;
		let stdout = "";
		let stderr = "";
		let finishCompletion: (completion: SupervisorCompletion) => void = () => undefined;
		const completion = new Promise<SupervisorCompletion>((complete) => {
			finishCompletion = complete;
		});
		const supervisorFailure = (message: string) =>
			sessionError(
				"supervisor_failed",
				launched ? "operation" : "launch",
				message,
				"Inspect the supervisor error and editor logs, then retry.",
				true
			);
		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			const error = supervisorFailure(message);
			if (launched) finishCompletion({ error, ok: false });
			else resume(Effect.fail(error));
		};
		const processMessage = (message: SupervisorMessage) => {
			if (message.type === "started") {
				if (launched) {
					fail("The Windows supervisor reported more than one process start.");
					return;
				}
				launched = true;
				resume(
					Effect.succeed(
						makeWindowsHandle(
							helper,
							message.pid,
							completion,
							options.terminationTimeout,
							(reason) => {
								requestedReason ??= reason;
							}
						)
					)
				);
				return;
			}
			if (!launched) {
				fail("The Windows supervisor reported process exit before process start.");
				return;
			}
			if (settled) return;
			settled = true;
			finishCompletion({ exit: rawExit(message.exitCode, null, requestedReason), ok: true });
		};
		helper.stdout?.setEncoding("utf8");
		helper.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length > SUPERVISOR_OUTPUT_LIMIT) {
				fail("The Windows supervisor exceeded its bounded protocol output.");
				helper.stdin?.end();
				return;
			}
			for (;;) {
				const newline = stdout.indexOf("\n");
				if (newline === -1) break;
				const line = stdout.slice(0, newline).trim();
				stdout = stdout.slice(newline + 1);
				if (line.length === 0) continue;
				try {
					processMessage(Schema.decodeUnknownSync(SupervisorMessage)(JSON.parse(line)));
				} catch (cause) {
					fail(
						`The Windows supervisor emitted an invalid protocol message: ${String(cause)}`
					);
					helper.stdin?.end();
				}
			}
		});
		helper.stderr?.setEncoding("utf8");
		helper.stderr?.on("data", (chunk: string) => {
			if (stderr.length >= SUPERVISOR_OUTPUT_LIMIT) return;
			stderr = `${stderr}${chunk}`.slice(0, SUPERVISOR_OUTPUT_LIMIT);
		});
		helper.on("error", (cause) =>
			fail(`Could not start the Windows supervisor: ${cause.message}`)
		);
		helper.on("close", (code) => {
			if (settled) return;
			const detail = stderr.trim().length > 0 ? `: ${stderr.trim()}` : "";
			fail(`The Windows supervisor exited with code ${String(code)}${detail}`);
		});
		return Effect.sync(() => {
			if (launched || settled) return;
			helper.stdin?.end();
		});
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
	let treeCompleted = false;
	const rootExited = new Promise<{
		readonly code: number | null;
		readonly signal: string | null;
	}>((complete) => {
		child.once("close", (code, signal) => complete({ code, signal }));
	});
	const treeExited = rootExited.then(async ({ code, signal }) => {
		if (await processGroupHasLiveMembers(pid)) signalProcessGroup(pid, "SIGKILL");
		await waitForProcessGroupExit(pid);
		treeCompleted = true;
		return rawExit(code, signal, requestedReason);
	});
	child.on("error", () => undefined);
	const awaitExit = Effect.tryPromise({
		try: () => treeExited,
		catch: (cause) =>
			sessionError(
				"process_tree_supervision_unavailable",
				"operation",
				`Could not inspect owned process group ${pid}: ${String(cause)}`,
				"Install a readable procfs or terminate the owned editor process group manually."
			)
	});
	const terminate = Effect.fn("OwnedProcessTree.terminate")(function* (
		reason: OwnedProcessTerminationReason
	) {
		if (treeCompleted) return yield* awaitExit;
		requestedReason ??= reason;
		yield* Effect.tryPromise({
			try: async () => {
				if (await processGroupHasLiveMembers(pid)) signalProcessGroup(pid, "SIGKILL");
			},
			catch: (cause) =>
				sessionError(
					"termination_failed",
					"termination",
					`Could not terminate owned process group ${pid}: ${String(cause)}`,
					"Terminate the owned editor process group manually before retrying.",
					true
				)
		});
		const completed = yield* awaitExit.pipe(Effect.timeoutOption(terminationTimeout));
		if (Option.isNone(completed)) {
			return yield* sessionError(
				"termination_failed",
				"termination",
				`Owned process group ${pid} did not terminate before the deadline.`,
				"Terminate the remaining process group manually before retrying.",
				true
			);
		}
		return completed.value;
	});
	return { awaitExit, pid, terminate };
}

export const OwnedProcessTreeLive = Layer.succeed(
	OwnedProcessTree,
	OwnedProcessTree.of({
		launch: Effect.fn("OwnedProcessTree.launch")((options) => {
			if (process.platform === "win32") {
				return Effect.flatMap(windowsSupervisorExecutable(), (supervisor) =>
					launchWindowsProcessTree(supervisor, options)
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
