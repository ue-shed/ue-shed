/**
 * Times the host's evidence fingerprint against the engine's `review_lines` over a generated
 * target, built by the native writer in a temporary directory that is removed after. Prints JSON.
 * UE_SHED_UASSET_EXECUTABLE=<uasset> node --import tsx scripts/benchmark-game-text-review-lines.ts
 *   [--lines 130000] [--cultures 10] [--evidence 3] [--native 500]
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Effect, Schema } from "effect";
import {
	LocalizationTarget,
	TextKey,
	TextNamespace,
	localizationEvidenceFingerprint
} from "../packages/localization/dist/index.js";
import { GameTextIndexRefresh } from "../packages/game-text/src/index-contract.ts";
import { makeIndexRegressionFixture } from "../packages/game-text/src/index-refresh-regressions.test-support.ts";
import { nativeIndexBuilderLayer } from "../packages/game-text/src/native-index-builder.ts";

const decodeLocalizationTarget = Schema.decodeEffect(LocalizationTarget);

const { values } = parseArgs({
	options: {
		lines: { type: "string", default: "130000" },
		cultures: { type: "string", default: "10" },
		evidence: { type: "string", default: "3" },
		native: { type: "string", default: "500" }
	}
});
const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
if (!executable) throw new Error("Set UE_SHED_UASSET_EXECUTABLE to the native reader.");
const count = (name: keyof typeof values, minimum: number, maximum: number) => {
	const value = Number(values[name]);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
		throw new Error(`--${name} must be ${minimum}–${maximum}.`);
	return value;
};
const lines = count("lines", 100, 300000);
const cultures = ["en", "de", "fr", "es", "it", "ja", "ko", "pl", "pt", "zh"].slice(
	0,
	count("cultures", 2, 10)
);
const evidenceCalls = count("evidence", 1, 50);
const nativeIdentities = count("native", 1, lines);

const key = (index: number) => `K${index}`;
const source = (index: number) => `Generated source text for review fingerprints ${index}`;
/** PO strings escape quotes and backslashes; the generated text has neither. */
const poEntry = (index: number, msgstr: string) =>
	`msgctxt "UI,${key(index)}"\nmsgid "${source(index)}"\nmsgstr "${msgstr}"\n`;

const seconds = (started: number) => (performance.now() - started) / 1000;

await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const target = yield* decodeLocalizationTarget({
				...fixture.target,
				cultures,
				outputPaths: {
					...fixture.target.outputPaths,
					archives: Object.fromEntries(cultures.map((c) => [c, `${c}.archive`])),
					portableObjects: Object.fromEntries(cultures.map((c) => [c, `${c}.po`]))
				}
			});
			fixture.setTargets([target]);
			const generated = performance.now();
			yield* Effect.promise(async () => {
				await writeFile(
					join(fixture.projectRoot, target.outputPaths.manifest!),
					JSON.stringify({
						FormatVersion: 1,
						Namespace: "UI",
						Children: Array.from({ length: lines }, (_, index) => ({
							Source: { Text: source(index) },
							Keys: [
								{ Key: key(index), Path: `/Game/Text/Table.Table.${key(index)}` }
							]
						}))
					})
				);
				for (const culture of cultures) {
					await writeFile(
						join(fixture.projectRoot, `${culture}.archive`),
						JSON.stringify({
							FormatVersion: 2,
							Namespace: "UI",
							Children: Array.from({ length: lines }, (_, index) => ({
								Key: key(index),
								Source: { Text: source(index) },
								Translation: { Text: `${culture} ${index}` }
							}))
						})
					);
					// Every tenth line has a pending edit the next sync ships.
					await writeFile(
						join(fixture.projectRoot, `${culture}.po`),
						Array.from({ length: lines }, (_, index) =>
							poEntry(
								index,
								index % 10 === 0
									? `${culture} pending ${index}`
									: `${culture} ${index}`
							)
						).join("\n")
					);
				}
			});
			const filesSeconds = seconds(generated);
			yield* Effect.gen(function* () {
				const built = performance.now();
				const model = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
				const buildSeconds = seconds(built);
				const step = Math.max(1, Math.floor(lines / nativeIdentities));
				const identities = Array.from({ length: nativeIdentities }, (_, index) => ({
					namespace: TextNamespace.make("UI"),
					key: TextKey.make(key((index * step) % lines))
				}));
				const culture = target.cultures[1]!;
				const evidenceRuns: number[] = [];
				const evidenceFingerprints: (string | undefined)[] = [];
				for (const identity of identities.slice(0, evidenceCalls)) {
					const started = performance.now();
					evidenceFingerprints.push(
						localizationEvidenceFingerprint(model.evidence, culture, identity)
					);
					evidenceRuns.push(seconds(started));
				}
				const nativeStarted = performance.now();
				const native = yield* model.query.reviewLines({
					target: target.name,
					culture,
					identities
				});
				const nativeSeconds = seconds(nativeStarted);
				const agree = evidenceFingerprints.every((fingerprint, index) => {
					const line = native[index];
					return line?.status === "found" && line.fingerprint === fingerprint;
				});
				console.log(
					JSON.stringify(
						{
							node: process.version,
							lines,
							cultures: cultures.length,
							generateFilesSeconds: filesSeconds,
							buildIndexSeconds: buildSeconds,
							evidenceFingerprint: {
								identities: evidenceRuns.length,
								seconds: evidenceRuns,
								meanSeconds:
									evidenceRuns.reduce((total, run) => total + run, 0) /
									evidenceRuns.length
							},
							reviewLines: {
								identities: identities.length,
								found: native.filter((line) => line.status === "found").length,
								seconds: nativeSeconds
							},
							fingerprintsAgree: agree
						},
						null,
						"\t"
					)
				);
				if (!agree) throw new Error("The evidence and native fingerprints differ.");
			}).pipe(
				Effect.provide(
					fixture.layer(
						fixture.source,
						nativeIndexBuilderLayer({
							executable,
							timeoutMs: 600000,
							catalogTimeoutMs: 600000
						})
					)
				)
			);
		})
	)
);
