import { app, ipcMain } from "electron/main";
import { Cause, ManagedRuntime } from "effect";
import type { ElectronAppHost } from "./adapters/electron-app.js";
import type { ElectronIpcHost } from "./adapters/electron-ipc.js";
import { WorkbenchLive } from "./workbench-live.js";
import { WorkbenchProgram } from "./workbench-program.js";

function reportStartupFailure(cause: unknown): void {
	const text = Cause.isCause(cause) ? Cause.pretty(cause) : String(cause);
	process.stderr.write(`ue-shed workbench failed to start: ${text}\n`);
}

/** Adapts the real Electron `app` singleton to the narrow, overload-free host shape. */
function toAppHost(): ElectronAppHost {
	return {
		getAppMetrics: () => app.getAppMetrics(),
		on: (event, listener) => {
			if (event === "window-all-closed") app.on(event, listener);
			else app.on(event, listener);
		},
		quit: () => {
			app.quit();
		},
		removeListener: (event, listener) => {
			if (event === "window-all-closed") app.removeListener(event, listener);
			else app.removeListener(event, listener);
		},
		whenReady: () => app.whenReady()
	};
}

/** Adapts the real Electron `ipcMain` singleton to the narrow, overload-free host shape. */
function toIpcHost(): ElectronIpcHost {
	return {
		handle: (channel, listener) => {
			ipcMain.handle(channel, listener);
		},
		removeHandler: (channel) => {
			ipcMain.removeHandler(channel);
		}
	};
}

/**
 * The sole Electron lifecycle adapter. Builds exactly one `ManagedRuntime` from
 * `WorkbenchLive`, runs `WorkbenchProgram.start` once the app is ready, and guarantees the
 * runtime is disposed exactly once before the process quits, whether quitting was requested by
 * the OS, the user closing every window, or a startup failure.
 */
function bootstrapWorkbench(): void {
	const runtime = ManagedRuntime.make(WorkbenchLive({ app: toAppHost(), ipc: toIpcHost() }));
	let disposing = false;

	function disposeAndQuit(): void {
		if (disposing) return;
		disposing = true;
		void runtime.dispose().finally(() => app.quit());
	}

	app.on("window-all-closed", () => app.quit());
	app.on("before-quit", (event) => {
		if (disposing) return;
		event.preventDefault();
		disposeAndQuit();
	});

	app.whenReady()
		.then(() => runtime.runPromise(WorkbenchProgram.start))
		.catch((cause: unknown) => {
			reportStartupFailure(cause);
			process.exitCode = 1;
			disposeAndQuit();
		});
}

bootstrapWorkbench();
