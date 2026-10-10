import { mkdir, mkdtemp, readFile, readdir, rm, copyFile, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateGameTextScale, gameTextScaleRecipe } from "./localization-scale-data.ts";
import {
	readScaleEvidence,
	readScaleCorpus,
	joinScaleTarget,
	scaleStatus,
	replayGameTextEvents
} from "./game-text-scale-pipeline.ts";
import { compareLocalizationJoins } from "./localization-join-oracle.test-support.ts";
import {
	parseArchive,
	parseManifest,
	parsePO,
	projectPOEvidence
} from "../packages/localization/dist/index.js";
import { Result, Schema } from "effect";
import { LocalizationLineId } from "../packages/game-text/dist/index.js";
import { validateGameTextScale } from "./game-text-scale-validation.ts";
import { boundedNumber, childWorkingSet, killBenchmarkTree } from "./game-text-scale-safety.ts";
import { joinedTargetSnapshot } from "./game-text-snapshot-data.ts";
import { decodeStringBlock } from "../packages/game-text/src/snapshot-format.ts";

let temporary: string;
let joined: Awaited<ReturnType<typeof joinScaleTarget>>;
let first: string;
let snapshot: ReturnType<typeof joinedTargetSnapshot>;
const recipe = gameTextScaleRecipe(0.001);

beforeAll(async () => {
	await mkdir(resolve("test-results/game-text-scale"), { recursive: true });
	temporary = await mkdtemp(resolve("test-results/game-text-scale/tiny-"));
	first = resolve(temporary, "first");
	await generateGameTextScale({ root: first, scale: 0.001, seed: 57 });
	const evidence = await readScaleEvidence(first);
	const corpus = await readScaleCorpus(first);
	joined = await joinScaleTarget(first, corpus, evidence);
	snapshot = joinedTargetSnapshot(first, corpus, joined.join);
	const status = scaleStatus(corpus, evidence, joined.join);
	expect(evidence.target.name).toBe("Generated");
	expect(evidence.target.cultures).toHaveLength(10);
	expect(
		evidence.target.configs[0]?.steps.some((step) =>
			step.fields.IncludePathFilters.includes("%LOCPROJECTROOT%Content/*")
		)
	).toBe(true);
	expect(corpus.coverage.textOccurrences).toBe(recipe.occurrences);
	expect(corpus.coverage.unsupportedTextProperties).toBe(recipe.gaps);
	expect(corpus.coverage.discoveredPackages).toBe(recipe.packages);
	expect(corpus.coverage.unresolvedOccurrences).toBe(recipe.keyless);
	expect(corpus.coverage.partialPackages).toBe(recipe.partialPackages);
	expect(status.report.page.localization?.lines.length).toBeLessThanOrEqual(50);
	expect(joined.keyChanges.pairs.length).toBeGreaterThan(0);
	expect(
		joined.join.lines.some((line) =>
			line.cultures.some((culture) => culture.review?.status === "current")
		)
	).toBe(true);
});
afterAll(async () => {
	if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
});

async function files(root: string, directory = ""): Promise<string[]> {
	const entries = await readdir(resolve(root, directory), { withFileTypes: true });
	const output: string[] = [];
	for (const entry of entries) {
		const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
		if (entry.isDirectory()) output.push(...(await files(root, path)));
		else output.push(path);
	}
	return output.sort();
}

describe("generated scale harness", () => {
	it("encodes the tiny joined target with archive text, states, sparse review and occurrences", () => {
		const sections = new Map(snapshot.columns.map((column) => [column.name, column]));
		const string = (domain: string, id: number) => {
			const starts = sections.get(`${domain}.starts`)!.values;
			let index = starts.length - 1;
			while (starts[index]! > id) index--;
			const block = sections.get(`${domain}.b${index}`)!.values;
			if (!(block instanceof Uint8Array)) throw new Error("Wrong block type");
			return decodeStringBlock(block).string(id - starts[index]!);
		};
		expect(sections.get("occurrence.object")!.domain).toBe("paths");
		expect(sections.get("occurrence.property")!.domain).toBe("paths");
		expect(sections.get("occurrence.id")!.domain).toBe("identity");
		expect(snapshot.dimensions.lines).toBe(joined.join.lines.length);
		expect(snapshot.dimensions.occurrences).toBe(recipe.occurrences);
		const sourceIds = sections.get("line.source")!.values;

		for (let index = 0; index < joined.join.lines.length; index++) {
			const line = joined.join.lines[index]!;
			expect(string("source", sourceIds[index]!)).toBe(line.source);
			for (let culture = 0; culture < line.cultures.length; culture++) {
				const translationIds = sections.get(`c${culture}.translation`)!.values;
				const states = sections.get(`c${culture}.state`)!.values;
				const row = index;
				expect(string(`c${culture}`, translationIds[row]!)).toBe(
					line.cultures[culture]!.archive?.translation.Text ?? ""
				);
				expect(states[row]).toBe(
					[
						"translated",
						"not_translated",
						"needs_update",
						"not_synced",
						"not_gathered",
						"changed_since_gather",
						"not_found",
						"gathered_only",
						"outside_target",
						"unknown"
					].indexOf(line.cultures[culture]!.state)
				);
			}
		}
		expect(sections.get("review.rows")!.values.length).toBeGreaterThan(0);
		expect(sections.get("change.rows")!.values.length).toBeGreaterThan(0);
		expect(sections.get("occurrence.line")!.values.length).toBe(recipe.occurrences);
	});
	it("writes identical bytes for the same seed at different output roots", async () => {
		const second = resolve(temporary, "second");
		await generateGameTextScale({ root: second, scale: 0.001, seed: 57 });
		const names = await files(first);
		expect(await files(second)).toEqual(names);
		for (const name of names)
			expect(
				createHash("sha256")
					.update(await readFile(resolve(second, name)))
					.digest("hex"),
				name
			).toEqual(
				createHash("sha256")
					.update(await readFile(resolve(first, name)))
					.digest("hex")
			);
		const third = resolve(temporary, "third");
		await generateGameTextScale({ root: third, scale: 0.001, seed: 58 });
		expect(await readFile(resolve(third, "saved-text.ndjson"))).not.toEqual(
			await readFile(resolve(first, "saved-text.ndjson"))
		);
	});
	it("parses Unreal formats, BOMs, CRLF and raw U+2028 with existing parsers", async () => {
		const base = resolve(first, "Content/Localization/Generated");
		const manifest = await readFile(resolve(base, "Generated.manifest"));
		expect(manifest.subarray(0, 2)).toEqual(Buffer.from([255, 254]));
		const parsed = parseManifest(manifest);
		expect(Result.isSuccess(parsed) && parsed.success.entries.length).toBe(recipe.keys);
		for (const culture of recipe.cultures) {
			const archive = parseArchive(
				await readFile(resolve(base, culture, "Generated.archive"))
			);
			expect(Result.isSuccess(archive) && archive.success.entries.length).toBe(recipe.keys);
			const bytes = await readFile(resolve(base, culture, "Generated.po"));
			expect(bytes.subarray(0, 3)).toEqual(Buffer.from([239, 187, 191]));
			expect(bytes.toString()).toContain("\r\n");
			expect(bytes.toString()).toContain("\u2028");
			const po = parsePO(bytes);
			expect(Result.isSuccess(po) && projectPOEvidence(po.success).entries.length).toBe(
				recipe.keys
			);
		}
	});
	it("discovers, reads, replays, joins with review and key changes, queries and reports", () => {
		expect(compareLocalizationJoins(joined.join, joined.join).equal).toBe(true);
		const states = new Set(
			joined.join.lines.flatMap((line) => line.cultures.map((culture) => culture.state))
		);
		for (const state of [
			"translated",
			"not_gathered",
			"unknown",
			"outside_target",
			"gathered_only",
			"not_found"
		] as const)
			expect(states.has(state), state).toBe(true);
	});
	it("rejects invalid input and a previously generated root", async () => {
		expect(() => gameTextScaleRecipe(0)).toThrow();
		await expect(
			generateGameTextScale({ root: first, scale: 0.001, seed: 57 })
		).rejects.toThrow();
	});
	it("closes the replay file when its consumer stops early", async () => {
		const replay = resolve(temporary, "replay");
		await mkdir(replay);
		await copyFile(resolve(first, "saved-text.ndjson"), resolve(replay, "saved-text.ndjson"));
		for await (const event of replayGameTextEvents(replay)) {
			expect(event.event).toBe("text_occurrence");
			break;
		}
		await rm(replay, { recursive: true });
	});
	it("rejects malformed saved events at the replay boundary", async () => {
		const replay = resolve(temporary, "invalid");
		await mkdir(replay);
		await writeFile(resolve(replay, "saved-text.ndjson"), '{"event":"text_occurrence"}\n');
		await expect(readScaleCorpus(replay)).rejects.toThrow("SchemaError");
	});
	it("records failed stages from fresh workers and enforces the RSS watchdog", async () => {
		await copyFile(resolve(first, "scale.json"), resolve(temporary, "scale.json"));
		const failedOutput = resolve(temporary, "failed.json");
		const stoppedOutput = resolve(temporary, "stopped.json");
		const benchmark = resolve("scripts/benchmark-game-text-scale.ts");
		const run = promisify(execFile);
		await expect(
			run(
				process.execPath,
				[
					benchmark,
					"--project",
					temporary,
					"--heaps",
					"default,256",
					"--output",
					failedOutput
				],
				{ windowsHide: true }
			)
		).rejects.toThrow();
		await expect(
			run(
				process.execPath,
				[benchmark, "--project", first, "--max-rss-gib", "0.01", "--output", stoppedOutput],
				{ windowsHide: true }
			)
		).rejects.toThrow();
		const decode = Schema.decodeUnknownSync(
			Schema.fromJsonString(
				Schema.Struct({
					results: Schema.Array(
						Schema.Struct({
							status: Schema.String,
							failureStage: Schema.String,
							error: Schema.String,
							seconds: Schema.Number,
							peak: Schema.Struct({
								heapUsed: Schema.Number,
								rss: Schema.Number,
								arrayBuffers: Schema.Number
							})
						})
					)
				})
			)
		);
		const failed = decode(await readFile(failedOutput, "utf8"));
		expect(failed.results).toHaveLength(2);
		for (const result of failed.results) {
			expect(result.status).toBe("failed");
			expect(result.failureStage).toBe("evidence");
			expect(result.error.length).toBeGreaterThan(0);
			expect(result.peak.heapUsed).toBeGreaterThan(0);
		}
		const stopped = decode(await readFile(stoppedOutput, "utf8"));
		expect(stopped.results[0]?.status).toBe("stopped");
		expect(stopped.results[0]?.error).toContain("RSS limit exceeded");
	});
	it("stream-validates counts and sizes and rejects a damaged event stream", async () => {
		const result = await validateGameTextScale(first);
		expect(result.files).toHaveLength(22);
		expect(result.bytesByKind.events).toBeGreaterThan(0);
		const damaged = resolve(temporary, "damaged");
		await generateGameTextScale({ root: damaged, scale: 0.001, seed: 57 });
		await writeFile(resolve(damaged, "saved-text.ndjson"), '{"event":"text_occurrence"}\n');
		await expect(validateGameTextScale(damaged)).rejects.toThrow("expected 1028");
	});
	it("rejects attempts to raise any hard limit and refuses the 10× pipeline", async () => {
		expect(() => boundedNumber("16385", "heap MiB", 16384)).toThrow();
		const benchmark = resolve("scripts/benchmark-game-text-scale.ts");
		for (const args of [
			["--heaps", "16385"],
			["--max-rss-gib", "20"],
			["--stage-timeout-seconds", "1201"]
		])
			await expect(
				promisify(execFile)(process.execPath, [benchmark, "--project", first, ...args], {
					windowsHide: true
				})
			).rejects.toThrow("cannot exceed");
		const large = resolve(temporary, "large-descriptor");
		await mkdir(large);
		await writeFile(
			resolve(large, "scale.json"),
			JSON.stringify({
				schemaVersion: 1,
				recipe: gameTextScaleRecipe(10)
			})
		);
		await expect(
			promisify(execFile)(process.execPath, [benchmark, "--project", large], {
				windowsHide: true
			})
		).rejects.toThrow("10× pipeline not run");
	});
	it("polls working set and kills descendants while a child's JS thread is blocked", async () => {
		const child = spawn(
			process.execPath,
			[
				"-e",
				`
			const { spawn } = require("node:child_process");
			const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
			globalThis.memory = Buffer.alloc(32 * 1024 * 1024, 1);
			process.stdout.write(String(descendant.pid) + "\\n");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		`
			],
			{
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"]
			}
		);
		const closed = new Promise<void>((done) => child.once("close", () => done()));
		try {
			const pid = await new Promise<number>((done, reject) => {
				child.stdout.once("data", (data: Buffer) => done(Number(data.toString().trim())));
				child.once("error", reject);
			});
			expect(await childWorkingSet(child.pid!)).toBeGreaterThan(32 * 1024 * 1024);
			await killBenchmarkTree(child);
			await closed;
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			await killBenchmarkTree(child);
			await closed;
		}
	});
	it("rejects a cached edit as a fresh PO measurement and restores the source bytes", async () => {
		const cache = resolve(temporary, "refresh-cache"),
			po = resolve(first, "Content/Localization/Generated/en/Generated.po"),
			original = await readFile(po);
		const command = (task: string, byte = 110) =>
			promisify(execFile)(
				process.execPath,
				[
					"--import",
					"tsx",
					resolve("scripts/benchmark-localization-import.ts"),
					"--project",
					first,
					"--cache",
					cache,
					"--output",
					resolve(temporary, `${task}-${byte}.json`),
					"--mode",
					"shared",
					"--select",
					task,
					"--po-change-byte",
					String(byte)
				],
				{ windowsHide: true, timeout: 20000 }
			);
		await command("cold");
		await command("folder");
		const folder = JSON.parse(await readFile(resolve(temporary, "folder-110.json"), "utf8"));
		const nativeFolder = folder.results.find(
			(stage: { stage: string }) => stage.stage === "reader:native-folder"
		);
		expect(folder.outcome.kind).toBe("done");
		expect(nativeFolder.references).toBeGreaterThan(0);
		expect(
			folder.results.find(
				(stage: { stage: string }) => stage.stage === "reader:native-folder-oracle"
			)
		).toMatchObject({ references: nativeFolder.references, prefix: nativeFolder.prefix });
		await expect(command("refresh")).rejects.toThrow();
		const cached = JSON.parse(await readFile(resolve(temporary, "refresh-110.json"), "utf8"));
		expect(cached.outcome.kind).toBe("failed");
		expect(cached.outcome.error).toContain("already cached");
		expect(await readFile(po)).toEqual(original);
		await command("refresh", 111);
		const fresh = JSON.parse(await readFile(resolve(temporary, "refresh-111.json"), "utf8"));
		expect(fresh.outcome.kind).toBe("done");
		expect(
			fresh.results.find((stage: { stage: string }) => stage.stage === "one-byte-po:target")
		).toMatchObject({ parsed: 1, lookupStrings: 1 });
		expect(await readFile(po)).toEqual(original);
	}, 60000);
	it("records a run deadline as failure, including worker startup, and permits only lower caps", async () => {
		const report = resolve(temporary, "deadline.json");
		const benchmark = resolve("scripts/benchmark-localization-import.ts");
		await expect(
			promisify(execFile)(
				process.execPath,
				[
					"--import",
					"tsx",
					benchmark,
					"--project",
					first,
					"--cache",
					resolve(temporary, "deadline-cache"),
					"--output",
					report,
					"--mode",
					"shared",
					"--select",
					"cold",
					"--run-timeout-seconds",
					"0.05"
				],
				{ windowsHide: true, timeout: 15000 }
			)
		).rejects.toThrow();
		const result = JSON.parse(await readFile(report, "utf8"));
		expect(result.outcome.kind).toBe("failed");
		expect(result.outcome.error).toContain("exceeded");
		expect(result.limits.runSeconds).toBe(0.05);
		expect(result.results).toEqual([]);
		await expect(
			promisify(execFile)(
				process.execPath,
				[
					"--import",
					"tsx",
					benchmark,
					"--project",
					first,
					"--cache",
					resolve(temporary, "deadline-cache"),
					"--output",
					report,
					"--run-timeout-seconds",
					"1201"
				],
				{ windowsHide: true, timeout: 15000 }
			)
		).rejects.toThrow("cannot exceed");
	});
});

describe("localization join oracle", () => {
	it("ignores line, origin set, manifest and per-line culture ordering", () => {
		const reordered = {
			...joined.join,
			lines: [...joined.join.lines].reverse().map((line) => ({
				...line,
				origin:
					line.origin.kind === "corpus"
						? { ...line.origin, unitIds: [...line.origin.unitIds].reverse() }
						: line.origin,
				manifest: [...line.manifest].reverse(),
				cultures: [...line.cultures].reverse().map((culture) => ({
					...culture,
					facts: [...culture.facts].reverse(),
					unknownReasons: [...culture.unknownReasons].reverse()
				}))
			}))
		};
		expect(compareLocalizationJoins(joined.join, reordered).equal).toBe(true);
	});
	it("reports an altered state readably", () => {
		const altered = {
			...joined.join,
			lines: joined.join.lines.map((line, i) =>
				i === 0
					? {
							...line,
							cultures: line.cultures.map((culture, c) =>
								c === 0
									? {
											...culture,
											state:
												culture.state === "unknown"
													? ("translated" as const)
													: ("unknown" as const)
										}
									: culture
							)
						}
					: line
			)
		};
		const result = compareLocalizationJoins(joined.join, altered);
		expect(result.equal).toBe(false);
		expect(result.differenceCount).toBe(1);
		expect(result.message).toContain("cultures.en.state");
	});
	it("reports archive, PO and pending translations independently", () => {
		const line = joined.join.lines.find((line) =>
			line.cultures.some((culture) => culture.archive !== null && culture.po !== null)
		);
		if (line === undefined) throw new Error("Expected evidence translation");
		for (const field of ["archive", "po", "poTranslation"] as const) {
			const altered = {
				...joined.join,
				lines: joined.join.lines.map((item) =>
					item === line
						? {
								...item,
								cultures: item.cultures.map((culture, index) =>
									index !== 0
										? culture
										: {
												...culture,
												[field]:
													field === "archive" && culture.archive !== null
														? {
																...culture.archive,
																translation: {
																	Text: "altered velora"
																}
															}
														: field === "po" && culture.po !== null
															? {
																	...culture.po,
																	msgstr: {
																		"0": "altered velora"
																	}
																}
															: "altered velora"
											}
								)
							}
						: item
				)
			};
			expect(compareLocalizationJoins(joined.join, altered).message).toContain(
				`cultures.en.${field}`
			);
		}
	});
	it("reports missing and extra lines and keeps counting after the display cap", () => {
		const line = joined.join.lines[0];
		if (line === undefined) throw new Error("Expected joined line");
		const missing = { ...joined.join, lines: joined.join.lines.slice(1) };
		expect(compareLocalizationJoins(joined.join, missing).counts.missing_line).toBe(1);
		const extra = {
			...missing,
			lines: [
				...missing.lines,
				{ ...line, id: LocalizationLineId.make("invented-extra-line") }
			]
		};
		const result = compareLocalizationJoins(joined.join, extra, 1);
		expect(result.counts).toEqual({ missing_line: 1, extra_line: 1 });
		expect(result.differences).toHaveLength(1);
		expect(result.omittedDifferences).toBe(1);
	});
	it("preserves target culture order and detects identities, origins, facts, reasons and key changes", () => {
		expect(
			compareLocalizationJoins(joined.join, {
				...joined.join,
				cultures: [...joined.join.cultures].reverse()
			}).counts.cultures
		).toBe(1);
		const line = joined.join.lines.find((line) => line.keyChange !== undefined);
		const change = line?.keyChange;
		if (line === undefined || change === undefined) throw new Error("Expected changed key");
		const altered = {
			...joined.join,
			lines: joined.join.lines.map((item) =>
				item !== line
					? item
					: {
							...item,
							source: "altered",
							identity: null,
							origin: { kind: "corpus" as const, unitIds: [] },
							manifest: [],
							keyChange: { ...change, previousSource: "altered" },
							cultures: item.cultures.map((culture, i) =>
								i === 0
									? {
											...culture,
											facts: [],
											unknownReasons: ["missing_manifest" as const]
										}
									: culture
							)
						}
			)
		};
		const result = compareLocalizationJoins(joined.join, altered);
		for (const field of [
			"identity",
			"origin",
			"source",
			"keyChange",
			"cultures.en.facts",
			"cultures.en.unknownReasons"
		])
			expect(result.counts[field], field).toBe(1);
	});
});
