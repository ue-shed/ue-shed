import { watch } from "node:fs";
import { Context, Effect, Layer, type Scope } from "effect";

/** One folder's change notification: the changed path relative to it, when the OS names one. */
export interface DiskWatchListener {
	readonly change: (relativePath: string | undefined) => void;
	readonly error: (cause: unknown) => void;
}

/**
 * Recursive folder watching. Node's `fs.watch` in production; tests inject their own so they
 * can raise events and errors deterministically.
 */
export class DiskWatcher extends Context.Service<
	DiskWatcher,
	{
		/** Watches `folder` recursively until the scope closes; failures go to `listener.error`. */
		readonly watch: (
			folder: string,
			listener: DiskWatchListener
		) => Effect.Effect<void, never, Scope.Scope>;
	}
>()("@ue-shed/game-text/DiskWatcher") {}

/** `fs.watch(folder, { recursive: true })`, closed when the watching scope closes. */
export const DiskWatcherNodeLive = Layer.succeed(DiskWatcher, {
	watch: Effect.fn("GameText.diskWatcher.watch")(function* (
		folder: string,
		listener: DiskWatchListener
	) {
		yield* Effect.acquireRelease(
			Effect.sync(() => {
				try {
					const watcher = watch(folder, { recursive: true }, (_event, name) =>
						listener.change(name === null ? undefined : String(name))
					);
					watcher.on("error", listener.error);
					return watcher;
				} catch (cause) {
					listener.error(cause);
					return undefined;
				}
			}),
			(watcher) => Effect.sync(() => watcher?.close())
		);
	})
});
