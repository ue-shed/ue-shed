import { Effect } from "effect";
import { WorkbenchWindow } from "./adapters/electron-window.js";

/**
 * Runs once, after `WorkbenchLive` has built every service and registered every IPC handler:
 * loads the renderer into the existing `BrowserWindow` and shows it when ready. Never launches
 * Unreal or the fixture; `FixtureLauncher` does that on renderer request.
 */
const start = Effect.gen(function* () {
	const window = yield* WorkbenchWindow;
	yield* window.load();
	yield* window.show();
}).pipe(Effect.withSpan("Workbench.WorkbenchProgram.start"));

export const WorkbenchProgram = { start };
