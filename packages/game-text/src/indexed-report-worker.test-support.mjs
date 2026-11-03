import { parentPort } from "node:worker_threads";
import { registerHooks } from "node:module";

if (!parentPort) throw new Error("The indexed report fixture must run in its owning worker.");

// Native type stripping avoids booting a second TS compiler/loader graph in each Vitest
// worker. Source imports use their emitted .js spelling; resolve only missing relative JS
// modules to the adjacent TypeScript source, leaving built package dependencies untouched.
registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (cause) {
			if (
				!specifier.startsWith(".") ||
				!specifier.endsWith(".js") ||
				cause.code !== "ERR_MODULE_NOT_FOUND"
			)
				throw cause;
			return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
		}
	}
});
let driver;
parentPort.on("message", async ({ input, reply, state }) => {
	const completion = new Int32Array(state);
	try {
		Atomics.store(completion, 1, 1);
		const started = performance.now();
		driver ??= import("./indexed-report-driver.test-support.ts");
		const loaded = await driver;
		Atomics.store(completion, 2, Math.round(performance.now() - started));
		Atomics.store(completion, 1, 2);
		const stdout = await loaded.indexedReport(input);
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
