import { cp, mkdir, mkdtemp, readFile, readdir, rm, copyFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	generateGameTextScale,
	gameTextScaleHistoryGaps,
	gameTextScaleRecipe
} from "./localization-scale-data.ts";
import {
	readScaleEvidence,
	readScaleCorpus,
	joinScaleTarget,
	replayGameTextEvents
} from "./game-text-scale-pipeline.ts";
import { compareLocalizationJoins } from "./localization-join-oracle.test-support.ts";
import {
	parseArchive,
	parseManifest,
	parsePO,
	projectPOEvidence
} from "../packages/localization/dist/index.js";
import { Result } from "effect";
import { LocalizationLineId } from "../packages/game-text/dist/entry-schema.js";
import { validateGameTextScale } from "./game-text-scale-validation.ts";
import {
	assertSafePipelineScale,
	benchmarkPipelineLimits,
	childWorkingSet,
	killBenchmarkTree
} from "./game-text-scale-safety.ts";
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
	expect(evidence.target.name).toBe("Generated");
	expect(evidence.target.cultures).toHaveLength(10);
	expect(
		evidence.target.configs[0]?.steps.some((step) =>
			step.fields.IncludePathFilters.includes("%LOCPROJECTROOT%Content/*")
		)
	).toBe(true);
	expect(corpus.coverage.textOccurrences).toBe(recipe.occurrences);
	expect(corpus.coverage.unsupportedTextProperties).toBe(gameTextScaleHistoryGaps(recipe));
	expect(corpus.coverage.discoveredPackages).toBe(recipe.packages);
	expect(corpus.coverage.unresolvedOccurrences).toBe(recipe.keyless);
	expect(corpus.coverage.partialPackages).toBe(recipe.partialPackages);
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
		await expect(readScaleCorpus(replay)).rejects.toThrow(
			"The replayed reader output could not be decoded."
		);
	});

	it("stream-validates counts and sizes and rejects a damaged event stream", async () => {
		const result = await validateGameTextScale(first);
		expect(result.bytesByKind.events).toBeGreaterThan(0);
		const damaged = resolve(temporary, "damaged");
		await cp(first, damaged, { recursive: true });
		await writeFile(resolve(damaged, "saved-text.ndjson"), '{"event":"text_occurrence"}\n');
		await expect(validateGameTextScale(damaged)).rejects.toThrow("expected 1028");
	});
	it("rejects attempts to raise any hard limit and refuses the 10× pipeline", () => {
		const limits = { heaps: "default,256", maxRssGiB: "1", stageTimeoutSeconds: "10" };
		expect(benchmarkPipelineLimits(limits)).toEqual({
			heaps: ["default", 256],
			maxRss: 2 ** 30,
			timeout: 10000
		});
		for (const invalid of [
			{ heaps: "16385" },
			{ maxRssGiB: "20" },
			{ stageTimeoutSeconds: "1201" }
		])
			expect(() => benchmarkPipelineLimits({ ...limits, ...invalid })).toThrow(
				"cannot exceed"
			);
		expect(() => benchmarkPipelineLimits({ ...limits, heaps: "1.5" })).toThrow("integer");
		expect(() => assertSafePipelineScale(recipe.scale)).not.toThrow();
		expect(() => assertSafePipelineScale(gameTextScaleRecipe(10).scale)).toThrow(
			"10× pipeline not run"
		);
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
			// Linux can retain a dead orphan's PID until init reaps its zombie entry.
			await expect
				.poll(async () => {
					if (process.platform === "linux") {
						try {
							const stat = await readFile(`/proc/${pid}/stat`, "utf8");
							return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
						} catch (cause) {
							if (
								cause instanceof Error &&
								"code" in cause &&
								cause.code === "ENOENT"
							)
								return true;
							throw cause;
						}
					}
					try {
						process.kill(pid, 0);
						return false;
					} catch (cause) {
						if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
							return true;
						throw cause;
					}
				})
				.toBe(true);
		} finally {
			await killBenchmarkTree(child);
			await closed;
		}
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
