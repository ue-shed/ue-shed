/** One fresh runtime/connection per sample. Hashes run after each operation's timer stops. */
import { createHash } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { trackBenchmarkEventLoop } from "../../../scripts/benchmark-event-loop.ts";
import { canonicalLocalizationJson } from "../../../packages/game-text/src/localization-fingerprint.ts";
import type { GameTextContract } from "../../../packages/protocol/dist/index.js";
import {
	cases,
	lines,
	populate,
	textRows,
	parseFacts,
	type Database,
	type Case,
	type SqlRow
} from "./sqlite.ts";
import { expected } from "./oracle.ts";
import { openSqlite } from "./driver.ts";

const [mode, inputPath, resultPath, lane = "node", executable] = process.argv.slice(2);
if (!mode || !inputPath || !resultPath) throw new Error("worker MODE INPUT RESULT [LANE] [EXE]");
const root = resolve(inputPath);
const databasePath = resolve(root, "facts.sqlite");
const checksum = (value: GameTextContract.JsonValue) =>
	createHash("sha256").update(canonicalLocalizationJson(value)).digest("hex");

async function openDatabase(): Promise<Database> {
	return openSqlite(databasePath, lane === "bun" ? "bun" : "node", mode === "build");
}

if (mode === "build") {
	try {
		await stat(databasePath);
		throw new Error("Database already exists.");
	} catch (cause) {
		if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
	}
	const facts = parseFacts(await readFile(resolve(root, "facts.json"), "utf8"));
	const db = await openDatabase();
	try {
		const at = performance.now();
		const counts = populate(db, facts);
		const buildMs = performance.now() - at;
		const workload = cases(facts);
		await writeFile(resolve(root, "cases.json"), JSON.stringify(workload));
		const answers = Object.fromEntries(
			workload.map((entry) => {
				const rows = expected(entry, facts);
				return [entry.name, { sha256: checksum(rows), rows: rows.length }];
			})
		);
		const plans = Object.fromEntries(
			workload.map((entry) => [
				entry.name,
				db.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...entry.parameters)
			])
		);
		const version = db.prepare("SELECT sqlite_version() AS version").all();
		const options = db.prepare("PRAGMA compile_options").all();
		await writeFile(
			resultPath,
			JSON.stringify(
				{
					buildMs,
					counts,
					rows: facts.length,
					version,
					options,
					plans,
					answers,
					memory: process.memoryUsage()
				},
				null,
				2
			)
		);
	} finally {
		db.close();
	}
} else {
	const workload: Case[] = JSON.parse(await readFile(resolve(root, "cases.json"), "utf8"));
	const setup = performance.now();
	let execute: (entry: Case) => Promise<{
		rows: readonly GameTextContract.JsonValue[];
		profile?: GameTextContract.EngineProfile;
		bytes?: number;
	}>;
	let close: () => Promise<void>;
	let version: GameTextContract.JsonValue = null;
	if (lane === "rust" || lane === "sqlite-pipe") {
		if (!executable) throw new Error("An executable is required for pipe lanes.");
		if (lane === "sqlite-pipe") process.env.UE_SHED_SQLITE_SPIKE_DB = databasePath;
		const { Effect } = await import("effect");
		const { GameTextEngineSession } =
			await import("../../../packages/unreal-assets/dist/game-text-engine-session.js");
		const { answerJson, answerRows } =
			await import("../../../packages/unreal-assets/dist/game-text-engine-client.js");
		const { gameTextEngineContract } = await import("../../../packages/protocol/dist/index.js");
		const session = new GameTextEngineSession(resolve(executable));
		try {
			const identity = answerJson<{ contractHash: string }>(
				await Effect.runPromise(session.call({ action: "capabilities" }))
			);
			if (!identity || identity.contractHash !== gameTextEngineContract.contractHash)
				throw new Error("Mismatched native contract.");
			version = identity;
			if (lane === "sqlite-pipe") {
				const metadata = async (sql: string) =>
					answerJson<SqlRow[]>(
						await Effect.runPromise(
							session.call({
								action: "localization_export",
								reader: "sqlite",
								request: { sql, parameters: [], output: "rows" }
							})
						)
					);
				version = {
					identity,
					version: (await metadata("SELECT sqlite_version() AS version")) ?? [],
					options: (await metadata("PRAGMA compile_options")) ?? []
				};
			}
			let reader = "sqlite";
			if (lane === "rust") {
				const { settings } = JSON.parse(
					await readFile(resolve(root, "input.json"), "utf8")
				);
				const opened = answerJson<{ reader: string }>(
					await Effect.runPromise(
						session.call({
							action: "open",
							configuration: settings.configuration,
							expectedGeneration: settings.generation,
							expectedJoined: settings.joinedKey,
							policy: { audienceRules: [] }
						})
					)
				);
				if (!opened) throw new Error("Native open returned no reader.");
				reader = opened.reader;
			}
			execute = async (entry) => {
				if (lane === "rust" && !entry.native) {
					if (
						entry.name === "namespace-counts" ||
						entry.name === "culture-state-counts"
					) {
						const answer = await Effect.runPromise(
							session.call({
								action: "aggregate",
								reader,
								request: {
									selection: { target: "Generated" },
									by:
										entry.name === "namespace-counts"
											? ["namespace"]
											: ["culture", "state"],
									measures: ["lines"]
								}
							})
						);
						const rows = answerRows(answer, "groups").map(
							({ key, lines: count }): SqlRow => {
								if (!Array.isArray(key))
									throw new Error("An aggregate group has no key tuple.");
								const n = Number(count);
								return entry.name === "namespace-counts"
									? { key: key[0]!, n }
									: { culture: key[0]!, state: key[1]!, n };
							}
						);
						rows.sort((a, b) => {
							const left = `${a.key ?? a.culture}\0${a.state ?? ""}`;
							const right = `${b.key ?? b.culture}\0${b.state ?? ""}`;
							return left < right ? -1 : left > right ? 1 : 0;
						});
						return { rows, profile: answer.profile, bytes: answer.profile.batchBytes };
					}
					if (entry.name.startsWith("page:") || entry.name.startsWith("search-page:")) {
						const text = entry.name.startsWith("search-page:")
							? { query: entry.name.slice(12) }
							: undefined;
						const answer = await Effect.runPromise(
							session.call({
								action: "query",
								reader,
								request: {
									selection: { target: "Generated", ...(text && { text }) },
									parts: {
										rows: { limit: text ? 50 : Number(entry.name.slice(5)) }
									}
								}
							})
						);
						return {
							rows: answerRows(answer, "lines").map(({ id, identity, source }) => ({
								id,
								identity,
								source
							})),
							profile: answer.profile,
							bytes: answer.profile.batchBytes
						};
					}
					throw new Error(`No native mapping for ${entry.name}`);
				}
				const request =
					lane === "rust"
						? entry.native!
						: {
								action: "localization_export" as const,
								request: {
									sql: entry.sql,
									parameters: entry.parameters,
									output: entry.output
								}
							};
				const answer = await Effect.runPromise(session.call({ ...request, reader }));
				const rows =
					entry.output === "lines"
						? answerRows(answer, "lines")
						: answerJson<SqlRow[]>(answer);
				if (!rows) throw new Error("A SQL answer has no rows part.");
				return { rows, profile: answer.profile, bytes: answer.profile.batchBytes };
			};
			close = () => session.close();
		} catch (cause) {
			await session.close();
			throw cause;
		}
	} else {
		const db = await openDatabase();
		db.exec("PRAGMA cache_size=-65536");
		version = {
			version: db.prepare("SELECT sqlite_version() AS version").all(),
			options: db.prepare("PRAGMA compile_options").all()
		};
		const statements = new Map(workload.map((entry) => [entry.name, db.prepare(entry.sql)]));
		execute = async (entry) => {
			const rows = statements.get(entry.name)!.all(...entry.parameters);
			return { rows: entry.output === "lines" ? lines(rows) : textRows(rows) };
		};
		close = async () => {
			db.close();
		};
	}
	const setupMs = performance.now() - setup;
	try {
		const selected = workload.filter(
			(entry) =>
				lane !== "rust" ||
				entry.native ||
				entry.name.startsWith("page:") ||
				entry.name.startsWith("search-page:") ||
				entry.name.endsWith("-counts")
		);
		const warmups: Record<string, string> = {};
		for (const entry of selected) warmups[entry.name] = checksum((await execute(entry)).rows);
		const samples = [];
		const repetitions = Number(process.env.UE_SHED_SPIKE_REPETITIONS ?? "7");
		if (!Number.isSafeInteger(repetitions) || repetitions < 1)
			throw new Error("Invalid repetitions.");
		for (let round = 0; round < repetitions; round++) {
			const rotated = [
				...selected.slice(round % selected.length),
				...selected.slice(0, round % selected.length)
			];
			for (const entry of rotated) {
				const loop = trackBenchmarkEventLoop();
				const started = performance.now();
				let answer: Awaited<ReturnType<typeof execute>>;
				try {
					answer = await execute(entry);
				} finally {
					loop.stop();
				}
				const elapsedMs = performance.now() - started;
				const callbackGap = loop.stop();
				const sha256 = checksum(answer.rows);
				if (sha256 !== warmups[entry.name])
					throw new Error(`Non-repeatable answer: ${entry.name}`);
				samples.push({
					name: entry.name,
					round,
					elapsedMs,
					rows: answer.rows.length,
					sha256,
					profile: answer.profile,
					batchBytes: answer.bytes,
					callbackGap
				});
			}
		}
		await writeFile(
			resultPath,
			JSON.stringify(
				{
					lane,
					warmups,
					setupMs,
					version,
					runtime: process.versions,
					samples,
					memory: process.memoryUsage()
				},
				null,
				2
			)
		);
	} finally {
		await close();
	}
}
