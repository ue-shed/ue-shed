import { parentPort } from "node:worker_threads";
import { registerHooks } from "node:module";
import { channel } from "node:diagnostics_channel";

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
let traceNative;
channel("ue-shed.game-text-benchmark").subscribe((event) => {
	if (event.stage === "tsFrameEncode") traceNative?.(`engine request ${event.action}`);
});
parentPort.on("message", async ({ input, reply, state }) => {
	const completion = new Int32Array(state);
	const traceBytes = new Uint8Array(state, 16);
	const entries = [];
	const started = performance.now();
	const trace = (stage) => {
		entries.push(`${Math.round(performance.now() - started)}ms ${stage}`);
		if (entries.length > 32) entries.shift();
		const bytes = new TextEncoder().encode(entries.join("\n"));
		const retained = bytes.subarray(Math.max(0, bytes.length - traceBytes.length));
		traceBytes.set(retained);
		Atomics.store(completion, 3, retained.length);
	};
	traceNative = trace;
	const diagnostic = setTimeout(() => {
		trace(`active resources: ${process.getActiveResourcesInfo().join(", ")}`);
	}, 15_000);
	diagnostic.unref();
	try {
		Atomics.store(completion, 1, 1);
		const started = performance.now();
		driver ??= import("./indexed-report-driver.test-support.ts");
		const loaded = await driver;
		Atomics.store(completion, 2, Math.round(performance.now() - started));
		Atomics.store(completion, 1, 2);
		const stdout = await loaded.indexedReport(input, trace);
		if (Buffer.byteLength(stdout) > 64 * 1024 * 1024)
			throw new Error("The indexed report fixture exceeds its 64 MiB response limit.");
		reply.postMessage({ stdout });
	} catch (cause) {
		reply.postMessage({
			stderr: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
		});
	} finally {
		clearTimeout(diagnostic);
		traceNative = undefined;
		reply.close();
		Atomics.store(completion, 0, 1);
		Atomics.notify(completion, 0);
	}
});
