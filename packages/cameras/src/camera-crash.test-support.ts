import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Effect } from "effect";
import { ArrangementCameraId, CameraOperationId } from "./camera-arrangement.js";

const [draft, destination, boundary] = process.argv.slice(2);
if (!draft || !destination || !boundary) throw new Error("Missing crash fixture arguments");
const rename = fs.promises.rename;
const cancellation = new AbortController();
type WorkerCommand = "interrupt" | "resume";
fs.promises.rename = async (from, to) => {
	const pause = async () => {
		process.send?.({ boundary });
		await new Promise<void>((resume) => {
			const onMessage = (message: WorkerCommand) => {
				if (message === "interrupt") {
					cancellation.abort();
					process.send?.({ interrupted: true });
				} else {
					process.off("message", onMessage);
					resume();
				}
			};
			process.on("message", onMessage);
		});
	};
	if (
		((boundary === "before-draft" || boundary === "cancel-draft") && to === draft) ||
		(boundary === "before-export" && to === destination)
	)
		await pause();
	await rename(from, to);
	if (boundary === "after-draft" && to === draft) await pause();
};
syncBuiltinESMExports();
const { makeCameraAuthoringStore } = await import("./camera-authoring-store.js");
const store = makeCameraAuthoringStore(draft);
const doc = await Effect.runPromise(store.load());
await Effect.runPromise(
	boundary === "before-export"
		? store.approve({
				operationId: CameraOperationId.make("crash-approval"),
				expectedRevision: doc.arrangement.revision,
				cameraId: ArrangementCameraId.make("camera-0"),
				destination
			})
		: store.mutate({
				kind: "tune",
				arrangementId: doc.arrangement.id,
				expectedRevision: doc.arrangement.revision,
				operationId: CameraOperationId.make("crash-tune"),
				settings: { fieldOfViewDegrees: 40 }
			}),
	{ signal: cancellation.signal }
).catch((cause) => {
	if (!cancellation.signal.aborted) throw cause;
});
process.disconnect?.();
