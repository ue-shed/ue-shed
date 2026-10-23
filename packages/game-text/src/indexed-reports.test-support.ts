/// <reference types="node" />
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { afterAll } from "vitest";
import type { LocalizationTargetEvidence } from "@ue-shed/localization";
import {
	LocalizationQualityReport,
	type LocalizationCheckOptions
} from "./localization-quality-schema.js";
import { TextQualityReport } from "./quality-schema.js";
import type { GameTextRuleDocument } from "./game-text-rules.js";
import { TextCorpus } from "./schema.js";

// One persistent index per immutable suite fixture, shared by every rule document and test.
// The synchronous bridge keeps presentation fixtures usable at module initialization. All
// ingestion, subject derivation and report assembly run through the shipped scoped Effect path.
const directory = mkdtempSync(join(tmpdir(), "ue-shed-report-suite-"));
const reports = new Map<string, unknown>();
afterAll(() => rmSync(directory, { recursive: true, force: true }));

export function indexedTestReports(corpus: TextCorpus, evidence?: LocalizationTargetEvidence) {
	const fixture = createHash("sha256")
		.update(JSON.stringify([corpus, evidence]))
		.digest("hex");
	function read<S extends Schema.Codec<unknown, unknown>>(
		kind: "source" | "localization" | "corpus",
		schema: S,
		document?: GameTextRuleDocument,
		options?: LocalizationCheckOptions
	): S["Type"] {
		const key = JSON.stringify([fixture, kind, document, options]);
		if (!reports.has(key)) {
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					resolve("packages/game-text/src/indexed-report-driver.test-support.ts")
				],
				{
					input: JSON.stringify({
						directory: join(directory, fixture),
						corpus,
						evidence,
						kind,
						document,
						options
					}),
					encoding: "utf8",
					maxBuffer: 64 * 1024 * 1024,
					windowsHide: true,
					env: { ...process.env, UE_SHED_TELEMETRY_MODE: "disabled" }
				}
			);
			if (result.error || result.status !== 0) {
				throw new Error(`Indexed report fixture failed: ${result.stderr}`, {
					cause: result.error
				});
			}
			reports.set(
				key,
				Schema.decodeUnknownSync(Schema.fromJsonString(schema))(result.stdout)
			);
		}
		return Schema.decodeUnknownSync(schema)(reports.get(key));
	}
	return {
		corpus: () => read("corpus", TextCorpus),
		source: (document: GameTextRuleDocument) => read("source", TextQualityReport, document),
		localization: (document?: GameTextRuleDocument, options?: LocalizationCheckOptions) =>
			read("localization", LocalizationQualityReport, document, options)
	};
}
