import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("The indexed report fixture must run in its owning worker.");

let driver;
parentPort.on("message", async ({ input, reply, state }) => {
	const completion = new Int32Array(state);
	try {
		driver ??= import("tsx/esm/api").then(async ({ register }) => {
			register();
			return import("./indexed-report-driver.test-support.ts");
		});
		const stdout = await (await driver).indexedReport(input);
		if (Buffer.byteLength(stdout) > 64 * 1024 * 1024)
			throw new Error("The indexed report fixture exceeds its 64 MiB response limit.");
		reply.postMessage({ stdout });
	} catch (cause) {
		reply.postMessage({
			stderr: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
		});
	} finally {
		reply.close();
		Atomics.store(completion, 0, 1);
		Atomics.notify(completion, 0);
	}
});
