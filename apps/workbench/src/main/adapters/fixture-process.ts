import { spawn, type ChildProcess } from "node:child_process";
import { Context, Effect, Exit, Layer, Ref, Schema, type Scope } from "effect";

export class FixtureProcessError extends Schema.TaggedErrorClass<FixtureProcessError>()(
	"Workbench.FixtureProcessError",
	{
		causeText: Schema.String,
		message: Schema.String,
		operation: Schema.Literals(["spawn", "wait", "terminate"]),
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface FixtureProcessLaunchOptions {
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly executable: string;
}

export type FixtureProcessExit =
	| { readonly status: "ready" }
	| {
			readonly status: "failed";
			readonly message: string;
			readonly recovery: string;
	  };

export interface FixtureProcessShape {
	readonly launch: (
		options: FixtureProcessLaunchOptions
	) => Effect.Effect<FixtureProcessExit, FixtureProcessError, Scope.Scope>;
}

export class FixtureProcess extends Context.Service<FixtureProcess, FixtureProcessShape>()(
	"@ue-shed/workbench/FixtureProcess"
) {}

export interface FixtureProcessTestShape extends FixtureProcessShape {
	readonly launches: () => Effect.Effect<ReadonlyArray<FixtureProcessLaunchOptions>>;
}

export class FixtureProcessTest extends Context.Service<
	FixtureProcessTest,
	FixtureProcessTestShape
>()("@ue-shed/workbench/FixtureProcess/Test") {}

function terminateChild(child: ChildProcess): void {
	if (child.killed || child.exitCode !== null) return;
	child.kill();
}

export const FixtureProcessLive = Layer.succeed(
	FixtureProcess,
	FixtureProcess.of({
		launch: Effect.fn("Workbench.FixtureProcess.launch")(function* (
			options: FixtureProcessLaunchOptions
		) {
			return yield* Effect.acquireRelease(
				Effect.sync(() =>
					spawn(options.executable, [...options.args], {
						cwd: options.cwd,
						env: {
							...process.env,
							...(options.env ?? {}),
							ELECTRON_RUN_AS_NODE: "1"
						},
						stdio: ["ignore", "ignore", "pipe"],
						windowsHide: true
					})
				),
				(child, exit) =>
					Effect.sync(() => {
						if (Exit.hasInterrupts(exit) || Exit.isFailure(exit)) {
							terminateChild(child);
						}
					})
			).pipe(
				Effect.flatMap((child) =>
					Effect.callback<FixtureProcessExit, FixtureProcessError>((resume) => {
						let stderr = "";
						child.stderr?.setEncoding("utf8");
						child.stderr?.on("data", (chunk: string) => {
							stderr = (stderr + chunk).slice(-16_384);
						});
						child.once("error", (cause) =>
							resume(
								Effect.succeed({
									status: "failed",
									message: `Could not start the fixture launcher: ${String(cause)}`,
									recovery:
										"Verify the configured Unreal installation and source checkout."
								})
							)
						);
						child.once("exit", (code) => {
							if (code === 0) resume(Effect.succeed({ status: "ready" }));
							else {
								resume(
									Effect.succeed({
										status: "failed",
										message:
											stderr.trim() ||
											`Fixture launcher exited with code ${code ?? "unknown"}.`,
										recovery:
											"Check the Unreal build output and Saved/Logs/UEShedFixture.log."
									})
								);
							}
						});
						return Effect.sync(() => {
							terminateChild(child);
						});
					})
				)
			);
		})
	})
);

export const makeFixtureProcessTestLayer = (
	behavior: (
		options: FixtureProcessLaunchOptions
	) => Effect.Effect<FixtureProcessExit, FixtureProcessError> = () =>
		Effect.succeed({ status: "ready" })
): Layer.Layer<FixtureProcess | FixtureProcessTest> =>
	Layer.effectContext(
		Effect.gen(function* () {
			const launches = yield* Ref.make<ReadonlyArray<FixtureProcessLaunchOptions>>([]);
			const service = FixtureProcessTest.of({
				launch: Effect.fn("Workbench.FixtureProcess.Test.launch")(function* (options) {
					yield* Ref.update(launches, (current) => [...current, options]);
					return yield* behavior(options);
				}),
				launches: () => Ref.get(launches)
			});
			return Context.empty().pipe(
				Context.add(FixtureProcess, service),
				Context.add(FixtureProcessTest, service)
			);
		})
	);
