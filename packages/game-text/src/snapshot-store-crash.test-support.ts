import { Effect } from "effect";
import { SnapshotStore, snapshotStoreNodeLayer } from "./snapshot-store.js";
import { snapshotStringTableBuilder } from "./snapshot-format.js";

import { snapshotColumnsSource } from "./snapshot-file.js";

const directory = process.argv[2];
if (directory === undefined) throw new Error("Missing test cache root");
const table = snapshotStringTableBuilder();
table.intern("crashed generation");
await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const store = yield* SnapshotStore;
			const writer = yield* store.writer();
			yield* writer.publish(snapshotColumnsSource([...table.finish()]), {
				source: "changed"
			});
		})
	).pipe(
		Effect.provide(
			snapshotStoreNodeLayer({
				cacheRoot: directory,
				projectKey: "test-project",
				targetKey: "test-target",
				beforeRename: async (kind) => {
					if (kind === "manifest") {
						// An unresolved Promise alone does not keep Node alive at the crash barrier.
						process.channel?.ref();
						process.send?.("before-rename");
						await new Promise<void>(() => {});
					}
				}
			})
		)
	)
);
