import { ScenarioStudioClientError, type ScenarioStudioClient } from "@ue-shed/extension-scenarios";
import {
	decodeScenarioRun,
	decodeScenarioStatusResponse,
	ScenarioRunHandle,
	ScenarioDocumentFileResult,
	type ScenarioDocument,
	type ScenarioRunnerStatus
} from "@ue-shed/scenarios/browser";
import { Effect, Schedule, Schema, Stream } from "effect";

function clientError(options: {
	readonly cause: unknown;
	readonly message: string;
	readonly operation: string;
	readonly recovery: string;
}): ScenarioStudioClientError {
	return new ScenarioStudioClientError(options);
}

const decodeHandle = Schema.decodeUnknownEffect(ScenarioRunHandle);

const status = (handle: ScenarioRunHandle) =>
	Effect.tryPromise({
		try: () => window.ueShed.scenarios.status(handle),
		catch: (cause) =>
			clientError({
				cause,
				message: "Scenario Studio could not read the live PIE run.",
				operation: "scenario.status",
				recovery: "Confirm the same Unreal Editor and PIE session are still running."
			})
	}).pipe(
		Effect.flatMap((value) =>
			decodeScenarioStatusResponse(value).pipe(
				Effect.mapError((cause) =>
					clientError({
						cause,
						message: "Scenario Studio received an invalid live status.",
						operation: "scenario.status.decode",
						recovery: "Update Workbench and the scenario extension together."
					})
				)
			)
		),
		Effect.flatMap(
			(value): Effect.Effect<ScenarioRunnerStatus, ScenarioStudioClientError> =>
				value._tag === "Rejected"
					? Effect.fail(
							clientError({
								cause: value,
								message: value.message,
								operation: "scenario.status",
								recovery: value.recovery
							})
						)
					: Effect.succeed(value)
		)
	);

const fileOperation = (document?: ScenarioDocument) =>
	Effect.tryPromise({
		try: () =>
			document === undefined
				? window.ueShed.scenarios.openDocument()
				: window.ueShed.scenarios.saveDocument(document),
		catch: (cause) =>
			clientError({
				cause,
				message: "Scenario document operation failed.",
				operation: "scenario.document",
				recovery: "Retry opening or saving the document."
			})
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(ScenarioDocumentFileResult)),
		Effect.mapError((cause) =>
			clientError({
				cause,
				message: "Scenario document operation failed.",
				operation: "scenario.document",
				recovery: "Retry with a valid scenario document."
			})
		)
	);
export const scenarioStudioClient: ScenarioStudioClient = {
	openDocument: () => fileOperation(),
	saveDocument: (document) => fileOperation(document),
	cancel: (handle) =>
		Effect.tryPromise({
			try: () => window.ueShed.scenarios.cancel(handle),
			catch: (cause) =>
				clientError({
					cause,
					message: "Scenario Studio could not cancel the live PIE run.",
					operation: "scenario.cancel",
					recovery: "Inspect the run in Unreal, then retry from a fresh PIE session."
				})
		}).pipe(
			Effect.flatMap((value) =>
				decodeScenarioRun(value).pipe(
					Effect.mapError((cause) =>
						clientError({
							cause,
							message: "Scenario Studio received an invalid cancelled result.",
							operation: "scenario.cancel.decode",
							recovery: "Update Workbench and the scenario extension together."
						})
					)
				)
			)
		),
	settings: () =>
		Effect.tryPromise({
			try: () => window.ueShed.editorSession.settings(),
			catch: (cause) =>
				clientError({
					cause,
					message: "Scenario Studio could not load the Unreal endpoint.",
					operation: "scenario.settings",
					recovery: "Reopen Workbench and select the Unreal Remote Control port."
				})
		}).pipe(
			Effect.map(({ endpoint, port }) => ({
				endpoint: endpoint ?? `http://127.0.0.1:${port}`
			}))
		),
	start: ({ document, endpoint }) =>
		Effect.tryPromise({
			try: () => window.ueShed.scenarios.start(document, endpoint),
			catch: (cause) =>
				clientError({
					cause,
					message: "Scenario Studio could not start the live PIE scenario.",
					operation: "scenario.start",
					recovery:
						"Confirm the endpoint is reachable and advertises the scenario capability."
				})
		}).pipe(
			Effect.flatMap((value) =>
				decodeHandle(value).pipe(
					Effect.mapError((cause) =>
						clientError({
							cause,
							message: "Scenario Studio received an invalid live run handle.",
							operation: "scenario.start.decode",
							recovery: "Update Workbench and the scenario extension together."
						})
					)
				)
			)
		),
	watch: (handle) =>
		Stream.fromEffectSchedule(status(handle), Schedule.spaced("100 millis")).pipe(
			Stream.takeUntil((value) => value._tag === "Terminal")
		)
};
