import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// Public TypeScript packages publish `dist` wholesale, and `tsc` never deletes output whose source
// was renamed or removed. Package builds (and therefore `prepack`) start from an empty `dist` so a
// stale working tree cannot leak retired modules into a tarball.
const packageDirectory = process.cwd();
if (!existsSync(join(packageDirectory, "package.json"))) {
	throw new Error(`Run this from a package directory; no package.json in ${packageDirectory}.`);
}
rmSync(join(packageDirectory, "dist"), { recursive: true, force: true });
