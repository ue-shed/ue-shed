import { parentPort } from "node:worker_threads";
import { Schema } from "effect";
import { ColdLayerTask, coldLayerReply } from "./cold-layer-pool.js";
import { convertColdLayer } from "./shared-index.js";
import { snapshotStoreFailure } from "./snapshot-store.js";
const decodeColdLayerTask = Schema.decodeSync(ColdLayerTask);

if (!parentPort) throw new Error("Cold layer conversion requires its owning worker pool.");
parentPort.on("message", async (input: typeof ColdLayerTask.Encoded) => {
	try {
		const task = decodeColdLayerTask(input);
		parentPort!.postMessage({ ok: true, ...(await convertColdLayer(task)) });
	} catch (cause) {
		const error = snapshotStoreFailure("cold.layer", cause, "Retry the cold layer conversion.");
		parentPort!.postMessage(Schema.encodeUnknownSync(coldLayerReply())({ ok: false, error }));
	}
});
