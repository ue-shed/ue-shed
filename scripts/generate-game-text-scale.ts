import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateGameTextScale } from "./localization-scale-data.ts";
import { positiveNumber, repositoryPath } from "./game-text-scale-options.ts";

const { values } = parseArgs({
	options: {
		root: { type: "string" },
		scale: { type: "string", default: "1x" },
		seed: { type: "string", default: "57" }
	}
});
const scale = positiveNumber(values.scale, "scale");
const root = repositoryPath(values.root ?? `test-results/game-text-scale/project-${scale}x`);
await mkdir(resolve(root, ".."), { recursive: true });
const result = await generateGameTextScale({ root, scale, seed: Number(values.seed) });
await writeFile(
	resolve(root, "..", `generation-${scale}x.json`),
	JSON.stringify(result, null, "\t") + "\n"
);
console.log(JSON.stringify(result));
