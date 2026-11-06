import { Effect } from "effect";

/**
 * Returns a stand-in for a workflow function that imports its module only when the command runs.
 * The command tree is built on every launch, so eager workflow imports made even `--version` load
 * every package the CLI can use. Usage:
 * `lazyWorkflow(() => import("../workflows/config.js"), (module) => module.runConfigExplain)`.
 */
export function lazyWorkflow<Module, Args extends readonly unknown[], A, E, R>(
	load: () => PromiseLike<Module>,
	select: (module: Module) => (...args: Args) => Effect.Effect<A, E, R>
): (...args: Args) => Effect.Effect<A, E, R> {
	return (...args) =>
		Effect.flatMap(
			Effect.promise(() => load()),
			(module) => select(module)(...args)
		);
}
