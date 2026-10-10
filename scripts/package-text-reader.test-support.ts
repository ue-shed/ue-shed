import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { Schema } from "effect";
import {
	UAssetIoEvent,
	type SavedAssetPackageTextEvent,
	type SavedAssetTextExtractionEvent
} from "../packages/protocol/dist/index.js";

export const packageTextFixtureProjects = [
	"fixtures/unreal-project",
	"fixtures/legacy-unreal-project",
	"fixtures/legacy-unreal-project/Generated/4.27",
	"fixtures/legacy-unreal-project/Generated/5.3",
	"fixtures/unreal-427-localization",
	"fixtures/perforce-map-history/revisions/baseline",
	"fixtures/perforce-map-history/revisions/add-arrival",
	"fixtures/perforce-map-history/revisions/conventional-baseline",
	"fixtures/perforce-map-history/revisions/conventional-move-actor",
	"fixtures/perforce-map-history/revisions/label-north",
	"fixtures/perforce-map-history/revisions/move-east",
	"fixtures/perforce-map-history/revisions/two-unclassified-package-edits"
] as const;

/** Only bounded committed fixtures use whole-output capture. Process time excludes schema decoding. */
export function measureNativeText(executable: string, project: string, packages: boolean) {
	const operation = packages ? "extract_text_packages" : "extract_text";
	const files = spawnSync(
		"git",
		["ls-files", "--", `${project}/Content/**/*.uasset`, `${project}/Content/**/*.umap`],
		{ encoding: "utf8", windowsHide: true }
	);
	if (files.error || files.status !== 0)
		throw files.error ?? new Error("Could not list committed fixture packages");
	const paths = files.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((path) => resolve(path));
	const request = {
		contract: { name: "uasset-io", version: { major: 1, minor: packages ? 8 : 0 } },
		limits: { concurrency: 1, maximumOutputBytes: 128 * 1024 ** 2 },
		operation: { kind: operation, projectRoot: resolve(project), paths },
		requestId: "package-text-measure"
	};
	const start = performance.now();
	const child = spawnSync(executable, ["protocol"], {
		input: JSON.stringify(request),
		maxBuffer: 128 * 1024 ** 2,
		windowsHide: true,
		timeout: 120_000
	});
	const milliseconds = performance.now() - start;
	if (child.error) throw child.error;
	if (child.status !== 0)
		throw new Error(
			`Native text extraction failed (${child.status}): ${child.stderr.toString()}`
		);
	const events: (SavedAssetTextExtractionEvent | SavedAssetPackageTextEvent)[] = [];
	let sequence = 0,
		outcome: "complete" | "partial" | undefined;
	let sampleBytes = 0,
		sampleCount = 0;
	for (const line of child.stdout.toString("utf8").trim().split("\n")) {
		const frame = Schema.decodeUnknownSync(Schema.fromJsonString(UAssetIoEvent))(line);
		if (
			frame.sequence !== sequence++ ||
			frame.requestId !== request.requestId ||
			frame.contract.version.minor !== request.contract.version.minor
		)
			throw new Error("Native text stream envelope changed");
		if (frame.kind === "result") {
			if (frame.result.kind !== operation) throw new Error("Unexpected native result kind");
			if (
				frame.result.kind === "extract_text" ||
				frame.result.kind === "extract_text_packages"
			)
				events.push(frame.result.event);
			if (
				frame.result.kind === "extract_text" &&
				frame.result.event.event === "text_coverage_gap"
			) {
				sampleBytes += Buffer.byteLength(JSON.stringify(frame.result.event.coverage_gap));
				sampleCount++;
			}
		}
		if (frame.kind === "completed") outcome = frame.outcome;
		if (frame.kind === "failed" || frame.kind === "rejected")
			throw new Error(JSON.stringify(frame));
	}
	if (outcome === undefined) throw new Error("Missing native text terminal event");
	return {
		events,
		milliseconds,
		outputBytes: child.stdout.length,
		frames: sequence,
		outcome,
		sampleBytes,
		sampleCount
	};
}
