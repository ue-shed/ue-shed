import { snapshotStoreGuidance } from "./snapshot-store.js";
import { Context, Effect, Layer, Option } from "effect";
import { SharedIndex, sharedIndexDirectory, type SharedIndexOptions } from "./shared-index.js";
import { SnapshotStoreError } from "./snapshot-store.js";

/** Internal composition seam. A refresh owns the writer across every input and the join. */
export class LocalizationImportSession extends Context.Service<
	LocalizationImportSession,
	{
		readonly configuration: SharedIndexOptions;
		readonly index: typeof SharedIndex.Service;
		readonly files?: readonly string[];
	}
>()("@ue-shed/game-text/LocalizationImportSession") {}

export const localizationImportLayer = Effect.fn("LocalizationImport.sessionLayer")(function* (
	configuration: SharedIndexOptions
) {
	const session = yield* Effect.serviceOption(LocalizationImportSession);
	if (Option.isNone(session)) return undefined;
	if (sharedIndexDirectory(configuration) !== sharedIndexDirectory(session.value.configuration))
		return yield* Effect.fail(
			new SnapshotStoreError({
				retrySafe: snapshotStoreGuidance("unavailable").retrySafe,
				nextStep: snapshotStoreGuidance("unavailable").nextStep,
				operation: "localization-import-session",
				code: "unavailable",
				message: "The localization import belongs to a different project or target.",
				recovery: "Open a refresh session for the selected project and target."
			})
		);
	return Layer.succeed(SharedIndex, session.value.index);
});
