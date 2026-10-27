import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Context, Effect, Layer } from "effect";

/** The optional platform package that ships the Windows process supervisor. */
export const WINDOWS_SUPERVISOR_PACKAGE = "@ue-shed/engine-win32-x64";

/**
 * Where the Windows process supervisor (`ue-shed-process-supervisor.exe`) is. Unset, it is
 * resolved from the installed `@ue-shed/engine-win32-x64` package. A host that ships the
 * executable elsewhere, such as an Electron app's resources or a bundled build without
 * `node_modules`, provides its path with `processSupervisorExecutableLayer` or
 * `Effect.provideService`. Editor launches and foreground permission both use it.
 */
export const ProcessSupervisorExecutable = Context.Reference<string | undefined>(
	"@ue-shed/engine/ProcessSupervisorExecutable",
	{ defaultValue: () => undefined }
);

/** Runs the process supervisor from `executable`, an absolute path, instead of the package. */
export function processSupervisorExecutableLayer(executable: string): Layer.Layer<never> {
	return Layer.succeed(ProcessSupervisorExecutable, executable);
}

/**
 * The supervisor's path: the host's, else the installed platform package's. It fails when
 * neither is set or installed; whether the file exists is the caller's to check.
 */
export const processSupervisorExecutable: Effect.Effect<string, unknown> = Effect.gen(function* () {
	const configured = yield* ProcessSupervisorExecutable;
	if (configured !== undefined) return configured;
	return yield* Effect.try({
		try: () => {
			const require = createRequire(import.meta.url);
			const manifest = require.resolve(`${WINDOWS_SUPERVISOR_PACKAGE}/package.json`);
			return join(dirname(manifest), "bin", "ue-shed-process-supervisor.exe");
		},
		catch: (cause) => cause
	});
});
