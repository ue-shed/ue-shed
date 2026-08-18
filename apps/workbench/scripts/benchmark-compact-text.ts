/**
 * Opt-in, privacy-safe measurement of the Workbench text-corpus path.
 *
 * It intentionally records aggregate counts and timings only: never project identifiers, paths,
 * object names, or text. The work is the same one-header-index plus explicit-candidate compact
 * extraction path that Workbench uses.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { assetReaderLayer, extractProjectText, scanSavedProject } from "@ue-shed/unreal-assets";
import {
	STRING_TABLE_CLASS,
	TEXT_PROPERTY_NAME,
	textPackagePathsFromProjectIndex
} from "@ue-shed/game-text";
import { SAVED_TABLE_SCAN_CLASSES } from "@ue-shed/unreal-assets";
import {
	ENHANCED_INPUT_CLASS_NAME_SUFFIXES,
	ENHANCED_INPUT_CLASS_PREFIX
} from "@ue-shed/enhanced-input";
import { TEXTURE_CLASS } from "@ue-shed/asset-audits";
import { Effect, Stream } from "effect";

const repositoryRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const defaultReader = join(
	repositoryRoot,
	"target",
	"release",
	process.platform === "win32" ? "uasset.exe" : "uasset"
);

interface Options {
	readonly output: string;
	readonly projectRoot: string;
	readonly reader: string;
}

const usage = `Usage: pnpm benchmark:compact-text -- --project <path> [options]

Measures the Workbench header-index -> explicit candidate -> compact text extraction path.
The project path is used only for the run; output contains counts and durations only.

Options:
  --project <path>   Unreal project root containing Content (required)
  --reader <path>    Compatible uasset executable (default target/release/uasset)
  --output <path>    JSON evidence path (default test-results/compact-text-benchmark.json)
  --help             Print this message
`;

function optionValue(arguments_: readonly string[], index: number, option: string): string {
	const value = arguments_[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${option} requires a value.`);
	}
	return value;
}

function parseArguments(arguments_: readonly string[]): Options | undefined {
	let projectRoot: string | undefined;
	let reader = defaultReader;
	let output = join(repositoryRoot, "test-results", "compact-text-benchmark.json");
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--") continue;
		if (argument === "--help") return undefined;
		if (argument === "--project") {
			projectRoot = resolve(repositoryRoot, optionValue(arguments_, index, argument));
			index += 1;
			continue;
		}
		if (argument === "--reader") {
			reader = resolve(repositoryRoot, optionValue(arguments_, index, argument));
			index += 1;
			continue;
		}
		if (argument === "--output") {
			output = resolve(repositoryRoot, optionValue(arguments_, index, argument));
			index += 1;
			continue;
		}
		throw new Error(`Unknown benchmark option: ${argument}`);
	}
	if (projectRoot === undefined) throw new Error("--project is required.");
	return { output, projectRoot, reader };
}

async function main(): Promise<void> {
	const options = parseArguments(process.argv.slice(2));
	if (options === undefined) {
		process.stdout.write(usage);
		return;
	}
	if (!existsSync(options.reader))
		throw new Error("The requested reader executable does not exist.");
	const reader = assetReaderLayer({ executable: options.reader });
	const indexStarted = performance.now();
	const index = await Effect.runPromise(
		scanSavedProject({
			classes: [...SAVED_TABLE_SCAN_CLASSES, STRING_TABLE_CLASS, TEXTURE_CLASS],
			classNameSuffixes: ENHANCED_INPUT_CLASS_NAME_SUFFIXES,
			classPrefixes: [ENHANCED_INPUT_CLASS_PREFIX],
			depth: "header",
			inventory: true,
			names: [TEXT_PROPERTY_NAME],
			projectRoot: options.projectRoot
		}).pipe(Effect.provide(reader))
	);
	if (index.inventory === undefined || index.summary.inventoryComplete !== true) {
		throw new Error("The shared header index did not produce a complete inventory.");
	}
	const indexDurationMs = Math.round(performance.now() - indexStarted);
	const candidates = textPackagePathsFromProjectIndex(index);
	const extractionStarted = performance.now();
	const counts = await Effect.runPromise(
		Stream.runFold(
			extractProjectText({ paths: candidates, projectRoot: options.projectRoot }),
			() => ({ coverageGaps: 0, failedPackages: 0, occurrences: 0, inspectedPackages: 0 }),
			(current, event) => ({
				coverageGaps: current.coverageGaps + (event.event === "text_coverage_gap" ? 1 : 0),
				failedPackages: current.failedPackages + (event.event === "error" ? 1 : 0),
				inspectedPackages:
					current.inspectedPackages + (event.event === "text_package" ? 1 : 0),
				occurrences: current.occurrences + (event.event === "text_occurrence" ? 1 : 0)
			})
		).pipe(Effect.provide(reader))
	);
	const result = {
		schemaVersion: 1,
		sharedHeaderIndex: {
			durationMs: indexDurationMs,
			inventoryFiles: index.inventory.length,
			scannedPackages: index.summary.scannedAssets
		},
		textExtraction: {
			candidatePackages: candidates.length,
			durationMs: Math.round(performance.now() - extractionStarted),
			...counts
		}
	};
	mkdirSync(dirname(options.output), { recursive: true });
	writeFileSync(options.output, `${JSON.stringify(result, null, "\t")}\n`, "utf8");
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((cause: unknown) => {
	process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
	process.exitCode = 1;
});
