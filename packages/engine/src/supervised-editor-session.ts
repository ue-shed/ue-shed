import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	ErrorCauseFields,
	ErrorGuidanceFields,
	type CompanionCapabilityManifest,
	type ErrorNextStep
} from "@ue-shed/protocol";
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
import { RemoteControlAllowedClass } from "./remote-control-permissions.js";
import { processSupervisorExecutable, WINDOWS_SUPERVISOR_PACKAGE } from "./process-supervisor.js";

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
const SUPERVISOR_OUTPUT_LIMIT = 16_384;

/**
 * Bounded explicit project/plugin launch with readiness, capability and termination
 * requirements. The HTTP port determines the local endpoint; optional timeouts are
 * milliseconds, not Effect duration strings.
 */
export const SupervisedEditorSessionRequest = Schema.Struct({
	explicitEngineRoot: Schema.optional(BoundedString),
	expectedProjectName: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(256))),
	plugins: Schema.Array(UnrealLaunchPlugin).check(Schema.isMaxLength(64)),
	projectDescriptor: BoundedString,
	readinessPollIntervalMs: Schema.optional(Milliseconds),
	readinessTimeoutMs: Schema.optional(Milliseconds),
	remoteControlHttpPort: HttpPort,
	remoteControlAllowedClasses: Schema.optional(
		Schema.Array(RemoteControlAllowedClass).check(Schema.isMaxLength(64))
	),
	requiredCapabilities: Schema.optional(
		Schema.Array(BoundedCapability).check(Schema.isMaxLength(64))
	),
	terminationTimeoutMs: Schema.optional(Milliseconds)
});
export type SupervisedEditorSessionRequest = typeof SupervisedEditorSessionRequest.Type;

/**
 * Observed process-tree outcome. Exited records natural termination; Terminated additionally
 * records whether cancellation, failure or scope release requested shutdown. Exit codes and
 * signals can be unavailable.
 */
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
/**
 * Reason an owning scope requests process-tree termination: cancellation, operation failure
 * or normal release. It is distinct from the child's exit status.
 */
export type OwnedProcessTerminationReason = Extract<
	OwnedProcessExit,
	{ readonly kind: "terminated" }
>["reason"];

/**
 * Validation, spawn, supervisor, readiness, capability or termination failure with an
 * explicit lifecycle stage. Cause preserves the underlying error; failed termination requires
 * operator reconciliation.
 */
export class SupervisedEditorSessionError extends Schema.TaggedError<SupervisedEditorSessionError>()(
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
		...ErrorGuidanceFields,
		...ErrorCauseFields,
		stage: Schema.Literals(["validation", "launch", "readiness", "operation", "termination"])
	}
) {}
const isSupervisedEditorSessionError = Schema.is(SupervisedEditorSessionError);

/**
 * Literal executable/arguments, working directory and termination deadline for an owned
 * process tree. The implementation must terminate descendants as well as the initial process.
 */
export interface OwnedProcessTreeLaunchOptions {
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
	readonly executable: string;
	readonly terminationTimeout: Duration.Input;
}

/**
 * Owned process identity with wait and explicit tree termination effects. Termination returns
 * the observed exit outcome and may fail if the supervisor cannot confirm cleanup.
 */
export interface OwnedProcessTreeHandle {
	readonly awaitExit: Effect.Effect<OwnedProcessExit, SupervisedEditorSessionError>;
	readonly pid: number;
	readonly terminate: (
		reason: OwnedProcessTerminationReason
	) => Effect.Effect<OwnedProcessExit, SupervisedEditorSessionError>;
}

/**
 * Starts a supervised process tree and returns its lifecycle handle. Implementations must
 * report supervision unavailability rather than silently degrading to an unowned detached
 * process.
 */
export interface OwnedProcessTreeApi {
	readonly launch: (
		options: OwnedProcessTreeLaunchOptions
	) => Effect.Effect<OwnedProcessTreeHandle, SupervisedEditorSessionError>;
}

/**
 * Process-tree ownership port used by supervised editor sessions. Hosts may replace
 * supervision, but must preserve descendant termination and truthful exit reporting.
 */
export class OwnedProcessTree extends Context.Service<OwnedProcessTree, OwnedProcessTreeApi>()(
	"@ue-shed/engine/OwnedProcessTree"
) {}

/**
 * Ready editor session with negotiated manifest, resolved paths, endpoint and owned PID.
 * Valid only while its acquisition scope remains open; terminating it ends the owned process
 * tree.
 */
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

/**
 * Acquires a ready editor inside the caller's Scope. Validation/readiness failures and scope
 * release terminate the owned process tree; required capabilities must be advertised before
 * acquisition succeeds.
 */
export interface SupervisedEditorSessionApi {
	readonly acquire: (
		request: SupervisedEditorSessionRequest
	) => Effect.Effect<SupervisedEditorSessionHandle, SupervisedEditorSessionError, Scope.Scope>;
}

/**
 * Scope-owned editor launch and readiness service. Use for disposable conformance or
 * automation sessions that must not leave an editor and its descendants running.
 */
export class SupervisedEditorSession extends Context.Service<
	SupervisedEditorSession,
	SupervisedEditorSessionApi
>()("@ue-shed/engine/SupervisedEditorSession") {}

/**
 * The usual next step per code. A failed acquire closes its scope, which terminates the owned
 * process tree, so a supervisor failure can be retried; a crash or a stuck tree needs a person.
 */
const sessionNextStep = {
	invalid_request: "fix_input",
	engine_discovery_failed: "fix_input",
	editor_missing: "fix_input",
	project_missing: "fix_input",
	plugin_missing: "fix_input",
	process_tree_supervision_unavailable: "fix_input",
	spawn_failed: "fix_input",
	supervisor_failed: "retry",
	process_exited: "escalate",
	readiness_failed: "escalate",
	capability_unavailable: "fix_input",
	termination_failed: "escalate"
} satisfies Readonly<Record<SupervisedEditorSessionError["code"], ErrorNextStep>>;

function sessionError(
	code: SupervisedEditorSessionError["code"],
	stage: SupervisedEditorSessionError["stage"],
	message: string,
	recovery: string,
	retrySafe = false,
	nextStep: ErrorNextStep = sessionNextStep[code],
	cause?: unknown
): SupervisedEditorSessionError {
	return new SupervisedEditorSessionError({
		code,
		message,
		recovery,
		retrySafe,
		nextStep,
		...(cause === undefined ? undefined : { cause }),
		stage
	});
}

function engineDiscoveryError(cause: EngineInstallationError): SupervisedEditorSessionError {
	return sessionError(
		"engine_discovery_failed",
		"validation",
		cause.message,
		cause.recovery,
		cause.retrySafe,
		cause.nextStep,
		cause
	);
}

function readinessError(cause: EditorConnectionError): SupervisedEditorSessionError {
	return sessionError(
		"readiness_failed",
		"readiness",
		cause.message,
		cause.recovery,
		cause.retrySafe,
		cause.nextStep,
		cause
	);
}

function filesystemEntry(
	path: string,
	code: "editor_missing" | "project_missing" | "plugin_missing",
	label: string
): Effect.Effect<void, SupervisedEditorSessionError> {
	return Effect.tryPromise({
		try: () => access(path),
		catch: (cause) =>
			sessionError(
				code,
				"validation",
				`${label} does not exist: ${path}`,
				`Choose an existing ${label.toLowerCase()} and retry.`,
				false,
				"fix_input",
				cause
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
	return processSupervisorExecutable.pipe(
		Effect.tap((executable) =>
			Effect.tryPromise({ try: () => access(executable), catch: (cause) => cause })
		),
		Effect.mapError((cause) =>
			sessionError(
				"process_tree_supervision_unavailable",
				"launch",
				`The Windows Job Object supervisor is unavailable.`,
				`Install the matching optional ${WINDOWS_SUPERVISOR_PACKAGE} package and retry.`,
				undefined,
				undefined,
				cause
			)
		)
	);
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
					`Could not request termination of owned Windows Job Object ${pid}.`,
					"Terminate the owned editor process tree manually before retrying.",
					true,
					undefined,
					cause
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
		const supervisorFailure = (message: string, cause?: unknown) =>
			sessionError(
				"supervisor_failed",
				launched ? "operation" : "launch",
				message,
				"Inspect the supervisor error and editor logs, then retry.",
				true,
				undefined,
				cause
			);
		const fail = (message: string, cause?: unknown) => {
			if (settled) return;
			settled = true;
			const error = supervisorFailure(message, cause);
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
					fail("The Windows supervisor emitted an invalid protocol message.", cause);
					helper.stdin?.end();
				}
			}
		});
		helper.stderr?.setEncoding("utf8");
		helper.stderr?.on("data", (chunk: string) => {
			if (stderr.length >= SUPERVISOR_OUTPUT_LIMIT) return;
			stderr = `${stderr}${chunk}`.slice(0, SUPERVISOR_OUTPUT_LIMIT);
		});
		helper.on("error", (cause) => fail("Could not start the Windows supervisor.", cause));
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
			"Check operating-system process limits and retry.",
			false,
			"escalate"
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
				`Could not inspect owned process group ${pid}.`,
				"Install a readable procfs or terminate the owned editor process group manually.",
				undefined,
				undefined,
				cause
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
					`Could not terminate owned process group ${pid}.`,
					"Terminate the owned editor process group manually before retrying.",
					true,
					undefined,
					cause
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

/**
 * Native process-tree supervision: uses the packaged supervisor on Windows and process-group
 * ownership on supported POSIX hosts. Reports unavailable supervision instead of falling back
 * to an unmanaged launch.
 */
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
									isSupervisedEditorSessionError(cause)
										? cause
										: sessionError(
												"spawn_failed",
												"launch",
												`Could not retain the supervised process identity.`,
												"Check operating-system process limits and retry.",
												false,
												"escalate",
												cause
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

/**
 * Combines EngineInstallationDiscovery, OwnedProcessTree and EditorConnection. Validates
 * inputs, launches, awaits readiness/capabilities and attaches process-tree termination to
 * scope release.
 */
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
				Effect.mapError((cause) =>
					sessionError(
						"invalid_request",
						"validation",
						"The supervised editor session request is invalid.",
						"Provide bounded readiness settings, one project descriptor, and valid plugin descriptors.",
						false,
						sessionNextStep.invalid_request,
						cause
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
			const executable = unrealEditorExecutable(
				installation.root,
				globalThis.process.platform,
				installation.version
			);
			yield* filesystemEntry(executable, "editor_missing", "Unreal Editor executable");
			const process = yield* Effect.acquireRelease(
				processes.launch({
					args: unrealProjectLaunchArguments({
						mode: {
							kind: "with_plugins",
							plugins: request.plugins,
							remoteControlHttpPort: request.remoteControlHttpPort,
							...(request.remoteControlAllowedClasses === undefined
								? undefined
								: {
										remoteControlAllowedClasses:
											request.remoteControlAllowedClasses
									})
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

/**
 * Provides a complete explicit OwnedProcessTree test port. The supplied implementation owns
 * outcomes and synchronization; no missing operation falls back to the production service.
 */
export function makeOwnedProcessTreeTestLayer(
	launch: OwnedProcessTreeApi["launch"]
): Layer.Layer<OwnedProcessTree> {
	return Layer.succeed(OwnedProcessTree, OwnedProcessTree.of({ launch }));
}

/**
 * Provides a complete explicit SupervisedEditorSession test port. The supplied implementation
 * owns outcomes and synchronization; no missing operation falls back to the production
 * service.
 */
export function makeSupervisedEditorSessionTestLayer(
	service: SupervisedEditorSessionApi
): Layer.Layer<SupervisedEditorSession> {
	return Layer.succeed(SupervisedEditorSession, SupervisedEditorSession.of(service));
}
