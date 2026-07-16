import { Effect } from "effect";
import { WorkbenchWindow } from "./adapters/electron-window.js";

/**
 * Runs once, after `WorkbenchLive` has built every service, forked the camera presentation
 * and IPC finalizer workers, and registered every IPC handler. Loads the renderer document
 * into the already-created `BrowserWindow` and reveals it once it signals ready-to-show.
 *
 * Never launches Unreal or the fixture process; fixture launches are demand-driven from
 * renderer-initiated IPC calls handled by `FixtureLauncher`.
 */
const start = Effect.gen(function* () {
	const window = yield* WorkbenchWindow;
	yield* window.load();
	yield* window.show();
}).pipe(Effect.withSpan("Workbench.WorkbenchProgram.start"));

export const WorkbenchProgram = { start };
