import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import {
	SharedIndex,
	sharedIndexNodeLayer,
	sharedIndexDirectory
} from "../packages/game-text/src/shared-index.ts";
import {
	SharedStringFiles,
	type SharedSegment
} from "../packages/game-text/src/shared-string-file.ts";
import { readScaleRecipe } from "./game-text-scale-options.ts";

// Compare the actual A64 page/domain readers. Both use the current container and its CRCs;
// the baseline reader/codec comes from the committed pre-WTF-8 implementation, read-only.
const [projectInput, cacheInput, outputInput] = process.argv.slice(2);
if (!projectInput || !cacheInput || !outputInput)
	throw new Error("Provide retained project, derived cache and output paths.");
const project = resolve(projectInput),
	cache = resolve(cacheInput),
	output = resolve(outputInput);
await readScaleRecipe(project);
if (process.env.NODE_OPTIONS) throw new Error("Use Node's default heap.");
const configuration = { projectKey: project, targetKey: "Generated", cacheRoot: cache };
const manifest = await Effect.runPromise(
	Effect.gen(function* () {
		return yield* (yield* SharedIndex).inspect;
	}).pipe(Effect.scoped, Effect.provide(sharedIndexNodeLayer(configuration)))
);
if (!manifest.segments.some((segment) => segment.domains.includes("source")))
	throw new Error("Prepared source domain is absent.");
const directory = sharedIndexDirectory(configuration);
const baselineDirectory = resolve("test-results/codex/wtf8-reader-baseline");
await mkdir(baselineDirectory, { recursive: true });
for (const name of ["shared-string-codec", "shared-string-file"]) {
	const original = execFileSync("git", ["show", `af462fb8:packages/game-text/src/${name}.ts`], {
		encoding: "utf8",
		windowsHide: true
	});
	const imports = original.replace(/"\.\/([^"\n]+)\.js"/gu, (_match, dependency: string) =>
		JSON.stringify(
			pathToFileURL(
				resolve(
					dependency === "shared-string-codec"
						? baselineDirectory
						: "packages/game-text/src",
					`${dependency}.ts`
				)
			).href
		)
	);
	await writeFile(resolve(baselineDirectory, `${name}.ts`), imports);
}
interface Reader {
	open(): Promise<Reader>;
	close(): Promise<void>;
	strings(ids: readonly number[]): Promise<string[]>;
	domain(name: string): Promise<readonly { readonly count: number }[]>;
}
type ReaderConstructor = new (directory: string, segments: readonly SharedSegment[]) => Reader;
// The module is the repository-owned source just written above, not external input.
const baseline: { SharedStringFiles: ReaderConstructor } = await import(
	pathToFileURL(resolve(baselineDirectory, "shared-string-file.ts")).href
);
const count = manifest.segments.at(-1)!.start + manifest.segments.at(-1)!.count;
const ids = Array.from({ length: 50 }, (_, row) => Math.floor((row * count) / 50));
interface TimingSamples {
	page: number[];
	domain: number[];
}
interface Samples {
	utf8: TimingSamples;
	wtf8: TimingSamples;
}
const samples: Samples = {
	utf8: { page: [], domain: [] },
	wtf8: { page: [], domain: [] }
};
let expectedPage: string[] | undefined, expectedCount: number | undefined;
for (let round = 0; round < 7; round++) {
	const order = round % 2 ? (["wtf8", "utf8"] as const) : (["utf8", "wtf8"] as const);
	for (const name of order) {
		const Constructor = name === "utf8" ? baseline.SharedStringFiles : SharedStringFiles;
		for (const operation of ["page", "domain"] as const) {
			global.gc?.();
			const reader = new Constructor(directory, manifest.segments);
			await reader.open();
			try {
				const started = performance.now();
				if (operation === "page") {
					const actual = await reader.strings(ids);
					samples[name].page.push(performance.now() - started);
					if (expectedPage && JSON.stringify(actual) !== JSON.stringify(expectedPage))
						throw new Error("Page differs.");
					expectedPage = actual;
				} else {
					const domains = await reader.domain("source");
					samples[name].domain.push(performance.now() - started);
					const actual = domains.reduce((total, domain) => total + domain.count, 0);
					if (expectedCount !== undefined && actual !== expectedCount)
						throw new Error("Domain count differs.");
					expectedCount = actual;
				}
			} finally {
				await reader.close();
			}
		}
	}
	console.log(`WTF-8 reader comparison: ${round + 1}/7 rounds`);
}
const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[3];
const results = Object.fromEntries(
	Object.entries(samples).map(([name, value]) => [
		name,
		{ pageMs: median(value.page), domainMs: median(value.domain) }
	])
);
await mkdir(dirname(output), { recursive: true });
await writeFile(
	output,
	JSON.stringify(
		{
			node: process.version,
			baseline: "af462fb8",
			format: 4,
			pageStrings: 50,
			sourceStrings: expectedCount,
			rounds: 7,
			method: "Alternating fresh A64 readers; same format-4 containers/CRCs and warm OS cache",
			results,
			samples
		},
		null,
		"\t"
	) + "\n"
);
console.log(JSON.stringify(results));
