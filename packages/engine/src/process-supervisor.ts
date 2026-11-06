import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ErrorCauseFields, ErrorGuidanceFields } from "@ue-shed/protocol/errors";
import { type Brand, Context, Effect, Layer, Schema } from "effect";

/** The optional platform package that ships the Windows process supervisor. */
export const WINDOWS_SUPERVISOR_PACKAGE = "@ue-shed/engine-win32-x64";

/**
 * The optional supervisor package could not be resolved. The original Node resolution failure is
 * retained in cause; supplying an explicit executable path bypasses package resolution as before.
 */
export class ProcessSupervisorUnavailable extends Schema.TaggedError<
	ProcessSupervisorUnavailable,
	Brand.Brand<"packages/engine/src/process-supervisor/ProcessSupervisorUnavailable">
>()("ProcessSupervisorUnavailable", {
	packageName: Schema.String,
	...ErrorGuidanceFields,
	...ErrorCauseFields
}) {}

/**
 * Where the Windows process supervisor (`ue-shed-process-supervisor.exe`) is; unset, it comes
 * from the installed `@ue-shed/engine-win32-x64` package. A host that ships it elsewhere (an
 * Electron app's resources, a bundle without `node_modules`) provides the path with
 * `processSupervisorExecutableLayer` or `Effect.provideService`.
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
export const processSupervisorExecutable: Effect.Effect<string, ProcessSupervisorUnavailable> =
	Effect.gen(function* () {
		const configured = yield* ProcessSupervisorExecutable;
		if (configured !== undefined) return configured;
		return yield* Effect.try({
			try: () => {
				const require = createRequire(import.meta.url);
				const manifest = require.resolve(`${WINDOWS_SUPERVISOR_PACKAGE}/package.json`);
				return join(dirname(manifest), "bin", "ue-shed-process-supervisor.exe");
			},
			catch: (cause) =>
				new ProcessSupervisorUnavailable({
					packageName: WINDOWS_SUPERVISOR_PACKAGE,
					message: "The Windows process supervisor package could not be resolved.",
					recovery: `Install the matching optional ${WINDOWS_SUPERVISOR_PACKAGE} package, or provide the executable path with processSupervisorExecutableLayer.`,
					retrySafe: true,
					nextStep: "fix_input",
					cause
				})
		});
	});
