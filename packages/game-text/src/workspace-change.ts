import { Effect, Semaphore } from "effect";
import { LocalizationEvidence } from "@ue-shed/localization";
import type { ChangeComparisonRequest, ChangeComparisonResult } from "./change-comparison.js";
import {
	changeComparisonTarget,
	readGameTextChangePoints,
	unreadableChangePaths,
	type GameTextChangeRevisions
} from "./change-points.js";
import { GameTextIndexSteps } from "./index-steps.js";
import { localizationGateFailures } from "./localization-gate.js";
import type { GameTextWorkspaceHost } from "./workspace-host.js";

/** A failure a host's change reads report: a code, and words a user can act on. */
export interface GameTextChangeFailure {
	/** Map History's error kind, such as `perforce_authentication`. */
	readonly kind?: string;
	readonly code?: string;
	readonly message: string;
	readonly recovery: string;
}

/** The host's change reads, for `compareChange`. */
export type GameTextWorkspaceChangeRevisions = GameTextChangeRevisions<GameTextChangeFailure>;

const failed = (code: string, message: string, recovery: string) =>
	({ status: "failed", code, message, recovery }) as const;

/**
 * `compareChange`: reads a change's two points for the selected project and compares them for one
 * target or every target, with the host's code source. One comparison runs at a time, since the
 * engine keeps one point per change id.
 */
export const makeWorkspaceChangeComparison = Effect.fn("GameText.workspace.changeComparison")(
	function* (host: Pick<GameTextWorkspaceHost, "project" | "codeSource" | "changeRevisions">) {
		const steps = yield* GameTextIndexSteps;
		const evidence = yield* LocalizationEvidence;
		const lock = yield* Semaphore.make(1);
		return Effect.fn("GameText.workspace.compareChange")(function* (
			request: ChangeComparisonRequest
		) {
			const current = yield* host.project.current();
			if (current.status !== "ready") return { status: "not_ready" } as const;
			const revisions = host.changeRevisions;
			if (revisions === undefined)
				return failed(
					"capability_missing",
					"This app does not read changes from Perforce.",
					"Compare changes from an app that connects to Perforce."
				);
			const { projectRoot } = current.project;
			return yield* Effect.gen(function* () {
				const discovered = yield* evidence.discover({ projectRoot });
				const names = discovered.targets.map((target) => target.name);
				const named = names.filter((name) => name === request.target);
				if (request.target !== undefined && named.length === 0)
					return failed(
						"target_not_found",
						`The localization target ${request.target} was not found.`,
						"Choose one of the project's localization targets."
					);
				const code = host.codeSource ? yield* host.codeSource(projectRoot) : undefined;
				const points = yield* readGameTextChangePoints({
					projectRoot,
					change: request.change,
					revisions,
					targetNames: request.target === undefined ? names : named,
					changes: request.changes,
					findings: request.findings,
					...(code === undefined ? undefined : { code })
				}).pipe(lock.withPermits(1));
				const unreadable = unreadableChangePaths(points.targets);
				if (unreadable.length > 0)
					return failed(
						"unreadable_package",
						`Changed files could not be read: ${unreadable.slice(0, 20).join(", ")}${unreadable.length > 20 ? ` and ${unreadable.length - 20} more` : ""}.`,
						"Check that the packages are saved and not damaged, and that the reader supports their engine version, then compare again."
					);
				return {
					status: "ready",
					change: points.change,
					targets: points.targets.map((target) =>
						changeComparisonTarget(
							target,
							localizationGateFailures(request.failOn, request.warnOn)
						)
					)
				} satisfies ChangeComparisonResult;
			}).pipe(
				Effect.provideService(GameTextIndexSteps, steps),
				Effect.provideService(LocalizationEvidence, evidence),
				// oxlint-disable-next-line anti-slop/no-effect-catch-all -- The contract answers every failure as `failed`, with its code and recovery.
				Effect.catch((error) =>
					Effect.succeed(
						failed(
							("kind" in error ? error.kind : undefined) ??
								("code" in error ? error.code : undefined) ??
								"change_failed",
							error.message,
							error.recovery
						)
					)
				)
			);
		});
	}
);
