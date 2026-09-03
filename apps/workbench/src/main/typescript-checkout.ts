import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** Absolute tsx loader so Electron-as-Node can run checkout `.ts` scripts from any cwd. */
export const typescriptLoader = pathToFileURL(require.resolve("tsx")).href;

/**
 * Node type stripping can load `.ts` files, but it does not rewrite `.js` specifiers in
 * package sources. Checkout scripts need tsx, the same loader the CLI uses.
 */
export function typescriptCheckoutArgs(
	script: string,
	args: ReadonlyArray<string> = []
): ReadonlyArray<string> {
	return ["--import", typescriptLoader, script, ...args];
}
