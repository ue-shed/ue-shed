import { ScenarioStudioClientError, type ScenarioStudioClient } from "@ue-shed/extension-scenarios";
import { decodeScenarioRun } from "@ue-shed/scenarios";
import { Effect } from "effect";

export const scenarioStudioClient: ScenarioStudioClient = {
	run: (document) =>
		Effect.tryPromise({
			try: () => window.ueShed.scenarios.run(document),
			catch: (cause) =>
				new ScenarioStudioClientError({
					cause,
					message: "Scenario Studio could not execute the live PIE scenario.",
					operation: "scenario.run",
					recovery:
						"Confirm the selected editor is reachable and advertises the scenario capability."
				})
		}).pipe(
			Effect.flatMap((value) =>
				decodeScenarioRun(value).pipe(
					Effect.mapError(
						(cause) =>
							new ScenarioStudioClientError({
								cause,
								message: "Scenario Studio received an invalid ScenarioRun.",
								operation: "scenario.decode",
								recovery: "Update Workbench and the scenario extension together."
							})
					)
				)
			)
		)
};
