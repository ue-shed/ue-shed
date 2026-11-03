import { AuthoringClient } from "@ue-shed/authoring-sdk";
import { Console, Effect } from "effect";

export const application = Effect.gen(function* () {
	const authoring = yield* AuthoringClient;
	const loaded = yield* authoring.loadConfiguredTable;
	if (loaded.status !== "ready") {
		yield* Console.log(JSON.stringify(loaded, null, 2));
		return loaded;
	}

	const session = yield* authoring.beginSession(loaded.snapshot.table.objectPath);
	yield* Console.log(
		JSON.stringify(
			{
				objectPath: loaded.snapshot.table.objectPath,
				rows: loaded.snapshot.table.rows.length,
				session
			},
			null,
			2
		)
	);
	return session;
}).pipe(Effect.withSpan("AuthoringHeadlessExample.run"));
