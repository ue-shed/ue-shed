import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { repositoryPath } from "./game-text-scale-options.ts";
import { validateGameTextScale } from "./game-text-scale-validation.ts";

const { values } = parseArgs({
	options: {
		project: { type: "string" },
		output: { type: "string" }
	}
});
if (values.project === undefined) throw new Error("Provide --project with a generated directory.");
const output = repositoryPath(
	values.output ?? `test-results/game-text-scale/validation-${Date.now()}.json`
);
const result = await validateGameTextScale(values.project);
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, JSON.stringify(result, null, "\t") + "\n");
console.log(JSON.stringify({ ...result, files: result.files.length, output }));
