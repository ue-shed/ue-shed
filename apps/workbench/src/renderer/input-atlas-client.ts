import {
	decodeEnhancedInputRunResult,
	type EnhancedInputRunResult
} from "@ue-shed/enhanced-input/browser";
import {
	InputAtlasClient,
	InputAtlasClientError,
	type InputAtlasClientShape
} from "@ue-shed/extension-input-atlas";
import { Effect } from "effect";

const recovery = "Restart Workbench. If the problem persists, verify package versions.";

function request(
	operation: string,
	invoke: () => Promise<unknown>
): Effect.Effect<EnhancedInputRunResult, InputAtlasClientError> {
	return Effect.tryPromise({
		try: invoke,
		catch: (cause) => new InputAtlasClientError({ cause, operation, recovery })
	}).pipe(
		Effect.flatMap(decodeEnhancedInputRunResult),
		Effect.mapError((cause) => new InputAtlasClientError({ cause, operation, recovery }))
	);
}

export const inputAtlasClient: InputAtlasClientShape = InputAtlasClient.of({
	loadConfiguredProject: Effect.fn("InputAtlasClient.loadConfiguredProject")(() =>
		request("inputAtlas.loadConfiguredProject", () =>
			window.ueShed.inputAtlas.loadConfiguredProject()
		)
	),
	chooseProjectAndScan: Effect.fn("InputAtlasClient.chooseProjectAndScan")(() =>
		request("inputAtlas.chooseProjectAndScan", () =>
			window.ueShed.inputAtlas.chooseProjectAndScan()
		)
	)
});
