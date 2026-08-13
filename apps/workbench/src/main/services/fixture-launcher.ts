import { decodeCompanionCapabilityManifest } from "@ue-shed/protocol";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import { Cache, Context, Duration, Effect, Layer, Result, Schedule } from "effect";
import { join } from "node:path";
import { FixtureProcess } from "../adapters/fixture-process.js";
import { LocalFiles } from "../adapters/local-files.js";
import type { FixtureLaunchResult } from "../ipc-contracts.js";
import { WorkbenchConfiguration } from "../workbench-config.js";

const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";
const reviewLibraryPath = "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary";
const probeTimeout = "1500 millis";

export type FixtureHealthCapability = "map-review";

export type FixtureHealthResult =
	| { readonly status: "ready" }
	| { readonly status: "incompatible"; readonly message: string; readonly recovery: string }
	| { readonly status: "not_running" };

export interface FixtureHealthShape {
	readonly check: (capability?: FixtureHealthCapability) => Effect.Effect<FixtureHealthResult>;
}

export class FixtureHealth extends Context.Service<FixtureHealth, FixtureHealthShape>()(
	"@ue-shed/workbench/FixtureHealth"
) {}

const ready: FixtureHealthResult = { status: "ready" };
const notRunning: FixtureHealthResult = { status: "not_running" };
const incompatibleReviewCapability: FixtureHealthResult = {
	status: "incompatible",
	message: "The configured endpoint is running Unreal without Map Review capture.",
	recovery: "Close the -game fixture or choose another endpoint, then launch the editor fixture."
};

function incompatibleProducer(message: string): FixtureHealthResult {
	return {
		status: "incompatible",
		message,
		recovery:
			"Close the incompatible Unreal instance or configure another endpoint, then retry."
	};
}

export const FixtureHealthLive = Layer.effect(
	FixtureHealth,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const remoteControl = yield* RemoteControlClient;

		const probe = (
			functionName: string,
			objectPath: string,
			parameters: Readonly<Record<string, unknown>>
		) =>
			remoteControl.request({
				endpoint: configuration.remoteControlEndpoint,
				functionName,
				objectPath,
				operation: `Workbench.FixtureHealth.${functionName}`,
				parameters,
				timeout: probeTimeout
			});

		const check = Effect.fn("Workbench.FixtureHealth.check")(function* (
			capability?: FixtureHealthCapability
		) {
			const manifestResult = yield* probe("GetCapabilityManifest", coreObjectPath, {}).pipe(
				Effect.flatMap(decodeCompanionCapabilityManifest),
				Effect.result
			);
			if (Result.isFailure(manifestResult)) return notRunning;
			const manifest = manifestResult.success;
			const matchesProject =
				manifest.producerKind === "unreal_editor" &&
				(configuration.expectedProject.status !== "configured" ||
					manifest.projectName === configuration.expectedProject.projectName);
			if (!matchesProject) {
				return incompatibleProducer(
					manifest.producerKind !== "unreal_editor"
						? "The configured endpoint belongs to a producer that is not an Unreal editor."
						: `The configured endpoint is running ${manifest.projectName}, not ${configuration.expectedProject.status === "configured" ? configuration.expectedProject.projectName : "the expected project"}.`
				);
			}
			if (capability !== "map-review") return ready;

			// A probe with an empty request exercises the review-capture RPC path without
			// supplying real view/pose data, so it never performs an actual capture.
			const reviewResult = yield* probe("CaptureReviewView", reviewLibraryPath, {
				RequestJson: "{}"
			}).pipe(Effect.result);
			return Result.isSuccess(reviewResult) ? ready : incompatibleReviewCapability;
		});

		return FixtureHealth.of({ check });
	})
);

export function makeFixtureHealthTestLayer(
	service: FixtureHealthShape
): Layer.Layer<FixtureHealth> {
	return Layer.succeed(FixtureHealth, FixtureHealth.of(service));
}

export type FixtureLaunchMode = "default" | "authoring";

export interface FixtureLauncherShape {
	readonly launch: (mode: FixtureLaunchMode) => Effect.Effect<FixtureLaunchResult>;
}

export class FixtureLauncher extends Context.Service<FixtureLauncher, FixtureLauncherShape>()(
	"@ue-shed/workbench/FixtureLauncher"
) {}

const missingSourceCheckout: FixtureLaunchResult = {
	status: "failed",
	message: "This Workbench session has no source-checkout fixture launcher.",
	recovery: "Start Workbench with pnpm showcase from the UE Shed repository."
};

const readinessTimeout: FixtureLaunchResult = {
	status: "failed",
	message: "Unreal launched, but Remote Control did not become ready within three minutes.",
	recovery: "Check the Unreal process and Saved/Logs/UEShedFixture.log."
};

const capabilityForMode = (mode: FixtureLaunchMode): FixtureHealthCapability | undefined =>
	mode === "authoring" ? "map-review" : undefined;

const launchArgForMode = (mode: FixtureLaunchMode): string =>
	mode === "authoring" ? "launch-authoring" : "launch";

export const FixtureLauncherLive = Layer.effect(
	FixtureLauncher,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const health = yield* FixtureHealth;
		const localFiles = yield* LocalFiles;
		const fixtureProcess = yield* FixtureProcess;

		const pollUntilReady = Effect.fn("Workbench.FixtureLauncher.pollUntilReady")(function* (
			capability: FixtureHealthCapability | undefined
		) {
			const outcome = yield* health.check(capability).pipe(
				Effect.repeat({
					schedule: Schedule.spaced("1 second"),
					until: (result) => result.status !== "not_running"
				}),
				Effect.timeoutOrElse({
					duration: "3 minutes",
					orElse: () => Effect.succeed(undefined)
				})
			);
			if (outcome?.status === "ready") return { status: "ready" as const };
			if (outcome?.status === "incompatible") {
				return {
					status: "failed" as const,
					message: outcome.message,
					recovery: outcome.recovery
				};
			}
			return readinessTimeout;
		});

		const spawnAndWait = Effect.fn("Workbench.FixtureLauncher.spawnAndWait")(function* (
			mode: FixtureLaunchMode,
			capability: FixtureHealthCapability | undefined,
			launchScript: string,
			cwd: string
		) {
			return yield* Effect.scoped(
				Effect.gen(function* () {
					const exit = yield* fixtureProcess
						.launch({
							args: [launchScript, launchArgForMode(mode)],
							cwd,
							executable: process.execPath
						})
						.pipe(
							Effect.catch((error) =>
								Effect.succeed({
									status: "failed" as const,
									message: error.message,
									recovery: error.recovery
								})
							)
						);
					if (exit.status === "failed") return exit;
					return yield* pollUntilReady(capability);
				})
			);
		});

		const launchUncached = Effect.fn("Workbench.FixtureLauncher.launchUncached")(function* (
			mode: FixtureLaunchMode
		) {
			const capability = capabilityForMode(mode);
			const result = yield* health.check(capability);
			if (result.status === "ready") return { status: "ready" as const };
			if (result.status === "incompatible") {
				return {
					status: "failed" as const,
					message: result.message,
					recovery: result.recovery
				};
			}
			if (configuration.sourceCheckout.status !== "configured") return missingSourceCheckout;
			const cwd = configuration.sourceCheckout.path;
			const launchScript = join(cwd, "scripts", "unreal-fixture.ts");
			const scriptExists = yield* localFiles.exists(launchScript);
			if (!scriptExists) return missingSourceCheckout;
			return yield* spawnAndWait(mode, capability, launchScript, cwd);
		});

		// Every completed lookup (success or failure) expires immediately: concurrent
		// callers share one in-flight launch, but the next call always rechecks health
		// rather than trusting a launch result that may already be stale.
		const cache = yield* Cache.makeWith(launchUncached, {
			capacity: 2,
			timeToLive: () => Duration.zero
		});

		const launch = Effect.fn("Workbench.FixtureLauncher.launch")(function* (
			mode: FixtureLaunchMode
		) {
			return yield* Cache.get(cache, mode);
		});

		return FixtureLauncher.of({ launch });
	})
);

export function makeFixtureLauncherTestLayer(
	service: FixtureLauncherShape
): Layer.Layer<FixtureLauncher> {
	return Layer.succeed(FixtureLauncher, FixtureLauncher.of(service));
}
