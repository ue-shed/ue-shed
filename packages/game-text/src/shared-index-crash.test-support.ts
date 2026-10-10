import { Effect } from "effect";
import { SharedIndex, sharedIndexNodeLayer } from "./shared-index.js";

await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const index = yield* SharedIndex;
			const writer = yield* index.writer();
			yield* writer.compact(true);
		})
	).pipe(
		Effect.provide(
			sharedIndexNodeLayer({
				cacheRoot: process.argv[2]!,
				projectKey: "invented",
				targetKey: "text",
				beforeRename: async (kind) => {
					if (kind === "manifest") {
						process.channel?.ref();
						process.send?.("compaction-ready");
						await new Promise<void>(() => {});
					}
				}
			})
		)
	)
);
