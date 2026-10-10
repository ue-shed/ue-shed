import { fork } from "node:child_process";
import { open, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { zstdDecompressSync } from "node:zlib";
import { Schema } from "effect";
import {
	openSnapshotFile,
	type SnapshotFileReader
} from "../packages/game-text/src/snapshot-file.ts";
import type { SnapshotEntry } from "../packages/game-text/src/snapshot-format.ts";
import { repositoryPath } from "./game-text-scale-options.ts";
import {
	benchmarkRunSeconds,
	benchmarkRunExpired,
	childWorkingSet,
	killBenchmarkTree,
	maximumHeapMiB,
	maximumRssBytes,
	maximumStageSeconds
} from "./game-text-scale-safety.ts";
import {
	absentId,
	compress,
	baselineHash,
	buildFront,
	buildHash,
	buildPerfect,
	compareBytes,
	frontRange,
	frontReader,
	hashBytes,
	lookupFront,
	lookupHash,
	perfectCandidate,
	sortBytes,
	stringBytes,
	type PackedStrings
} from "./game-text-dictionary.ts";

const started = 0;
const { values } = parseArgs({
	options: {
		input: { type: "string" },
		output: { type: "string" },
		scale: { type: "string" },
		candidate: { type: "string" },
		worker: { type: "boolean" }
	}
});
if (!values.input || !values.output || !values.scale || !values.candidate)
	throw new Error("Provide --input, --output, --scale and --candidate.");
const input = repositoryPath(values.input),
	output = repositoryPath(values.output);
const scale = Schema.decodeUnknownSync(Schema.Literals([1, 10]))(Number(values.scale));
const candidate = Schema.decodeUnknownSync(Schema.Literals(["A16", "A32", "A64", "B", "C"]))(
	values.candidate
);
const runSeconds = benchmarkRunSeconds(scale);
const Message = Schema.Struct({
	kind: Schema.Literals(["progress", "result", "failed", "done", "sample"]),
	result: Schema.optionalKey(Schema.Json),
	error: Schema.optionalKey(Schema.String),
	heap: Schema.optionalKey(Schema.Number),
	buffers: Schema.optionalKey(Schema.Number),
	rss: Schema.optionalKey(Schema.Number)
});

interface StoredBlock {
	start: number;
	count: number;
	data: Buffer;
	compressed: boolean;
}
async function loadDomain(reader: SnapshotFileReader, entries: readonly SnapshotEntry[]) {
	const count = entries[0]!.stringCount;
	const offsets = new Uint32Array(count + 1);
	// Block payloads include u32 offsets and a count, but no dictionary strings are materialised.
	const size =
		entries.reduce((n, entry) => n + entry.rawLength, 0) - count * 4 - entries.length * 8;
	const bytes = Buffer.allocUnsafe(size),
		stored: StoredBlock[] = [];
	const handle = await open(input, "r");
	let id = 0,
		position = 0;
	try {
		for (const entry of entries) {
			const raw = await reader.load(entry.name);
			if (!(raw instanceof Uint8Array)) throw new Error("Invalid string block kind");
			const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
				n = view.getUint32(0, true),
				payload = 4 + (n + 1) * 4;
			for (let row = 0; row < n; row++)
				offsets[id + row] = position + view.getUint32(4 + row * 4, true);
			bytes.set(raw.subarray(payload), position);
			const data = Buffer.allocUnsafe(entry.storedLength);
			for (let read = 0; read < data.length; ) {
				const next = await handle.read(data, read, data.length - read, entry.offset + read);
				if (!next.bytesRead) throw new Error("Truncated stored block");
				read += next.bytesRead;
			}
			stored.push({ start: id, count: n, data, compressed: entry.codec === 1 });
			id += n;
			position += raw.length - payload;
		}
	} finally {
		await handle.close();
	}
	if (id !== count || position !== size) throw new Error("Domain count/bytes mismatch");
	offsets[count] = position;
	return { strings: { bytes, offsets }, stored };
}
function decodeOriginal(stored: readonly StoredBlock[], ids: Uint32Array, strings: PackedStrings) {
	const ordered = ids.slice().sort();
	let block = 0,
		previous = -1,
		raw: Buffer = Buffer.alloc(0),
		readBytes = 0,
		blocks = 0;
	for (const id of ordered) {
		while (id >= stored[block]!.start + stored[block]!.count) block++;
		if (block !== previous) {
			const frame = stored[block]!;
			raw = frame.compressed ? zstdDecompressSync(frame.data) : frame.data;
			previous = block;
			readBytes += frame.data.length;
			blocks++;
		}
		const local = id - stored[block]!.start,
			n = raw.readUInt32LE(0),
			payload = 4 + (n + 1) * 4;
		const value = raw.subarray(
			payload + raw.readUInt32LE(4 + local * 4),
			payload + raw.readUInt32LE(8 + local * 4)
		);
		if (compareBytes(value, stringBytes(strings, id)) !== 0)
			throw new Error("Original page decode mismatch");
	}
	return { readBytes, blocks };
}
function requestSet(strings: PackedStrings, count: number) {
	const total = strings.offsets.length - 1,
		ids = new Uint32Array(count),
		chunks: Buffer[] = [],
		offsets = new Uint32Array(count + 2);
	let size = 0;
	for (let i = 0; i < count; i++) {
		const id = Math.floor((i * total) / count),
			value = stringBytes(strings, id);
		ids[i] = id;
		offsets[i] = size;
		size += value.length;
		chunks.push(value);
	}
	// The changed source is a new exact value. Null cannot appear in these saved sets.
	const changed = Buffer.concat([stringBytes(strings, 0), Buffer.from("\0dictionary-change")]);
	offsets[count] = size;
	size += changed.length;
	offsets[count + 1] = size;
	chunks.push(changed);
	return { strings: { bytes: Buffer.concat(chunks, size), offsets }, ids };
}
function checkLookup(
	result: Uint32Array,
	requests: PackedStrings,
	strings: PackedStrings,
	order?: Uint32Array
) {
	for (let row = 0; row < result.length; row++) {
		const request = order ? order[row]! : row,
			id = result[row]!;
		if (request === requests.offsets.length - 2) {
			if (id !== absentId) throw new Error("Absent key accepted");
		} else if (
			id === absentId ||
			compareBytes(stringBytes(requests, request), stringBytes(strings, id)) !== 0
		)
			throw new Error("Dictionary lookup mismatch");
	}
}
async function worker() {
	const reader = await openSnapshotFile(input);
	try {
		const domains = new Map<string, SnapshotEntry[]>();
		for (const entry of reader.directory.entries.values())
			if (entry.kind === "strings") {
				const list = domains.get(entry.domain) ?? [];
				list.push(entry);
				domains.set(entry.domain, list);
			}
		for (const [domain, entries] of domains) {
			process.send?.({ kind: "progress", result: { domain, stage: "load" } });
			globalThis.gc?.();
			const loadStarted = performance.now(),
				{ strings, stored } = await loadDomain(reader, entries);
			const loadSeconds = (performance.now() - loadStarted) / 1000,
				count = strings.offsets.length - 1;
			// Model one PO file: two identity columns and source/translation/path columns.
			const requested = ["source", "identity", "paths", "comments", "c0"].includes(domain)
				? Math.min(count, Math.round(132606 * scale * (domain === "identity" ? 2 : 1)))
				: 0;
			const requests = requested ? requestSet(strings, requested) : undefined;
			const pageIds = Uint32Array.from({ length: 300 }, (_, i) =>
				Math.floor((i * count) / 300)
			);
			process.send?.({ kind: "progress", result: { domain, stage: "build", count } });
			const buildStarted = performance.now(),
				level = domain === "paths" ? 9 : domain === "identity" ? 6 : 3;
			let storedBytes = 0,
				rawBytes = 0,
				indexBytes = 0,
				mphBytes = 0,
				appendMs = 0,
				pageMs = 0,
				rangeMs = 0;
			let appendReadBytes = 0,
				appendBlocks = 0,
				confirmations = 0,
				absentFalsePositives = 0,
				absentTrials = 0,
				pageReadBytes = 0,
				pageBlocks = 0,
				rangeMatches = 0;
			let buildSeconds = 0;
			const prefix = Buffer.from(domain === "paths" && scale === 1 ? "/Game/" : "1/");
			if (candidate.startsWith("A")) {
				const order = sortBytes(strings),
					dictionary = buildFront(strings, order, Number(candidate.slice(1)), level);
				buildSeconds = (performance.now() - buildStarted) / 1000;
				storedBytes = dictionary.storedBytes;
				rawBytes = dictionary.rawBytes;
				indexBytes = dictionary.indexBytes;
				if (requests) {
					const time = performance.now(),
						sorted = sortBytes(requests.strings),
						lookup = lookupFront(dictionary, requests.strings, sorted);
					appendMs = performance.now() - time;
					appendReadBytes = lookup.stats.bytes;
					appendBlocks = lookup.stats.blocks;
					// Sort-rank IDs are exact; verify against the original insertion-order payload.
					const originalIds = Uint32Array.from(lookup.result, (id) =>
						id === absentId ? absentId : order[id]!
					);
					checkLookup(originalIds, requests.strings, strings, sorted);
				}
				const inverse = new Uint32Array(count);
				for (let i = 0; i < count; i++) inverse[order[i]!] = i;
				const ranks = Uint32Array.from(pageIds, (id) => inverse[id]!).sort(),
					page = frontReader(dictionary);
				const time = performance.now();
				for (const rank of ranks) {
					const value = page.block(Math.floor(rank / dictionary.blockSize))[
						rank % dictionary.blockSize
					]!;
					if (compareBytes(value, stringBytes(strings, order[rank]!)) !== 0)
						throw new Error("Front page mismatch");
				}
				pageMs = performance.now() - time;
				pageReadBytes = page.stats.bytes;
				pageBlocks = page.stats.blocks;
				const rangeTime = performance.now(),
					range = frontRange(dictionary, prefix);
				rangeMs = performance.now() - rangeTime;
				rangeMatches = range.end - range.start;
			} else {
				// Re-encode baseline string frames at the current store's domain policy too.
				// This charges B/C for their string build and keeps compression levels equal.
				for (const frame of stored) {
					const raw = frame.compressed ? zstdDecompressSync(frame.data) : frame.data;
					const encoded = compress(raw, level);
					frame.data = encoded.data;
					frame.compressed = encoded.compressed;
				}
				const dictionary = candidate === "B" ? buildPerfect(strings) : buildHash(strings);
				buildSeconds = (performance.now() - buildStarted) / 1000;
				const originalBytes = stored.reduce(
					(n, block) => n + block.data.length,
					48 + stored.length * 99 + stored.length * 4
				);
				storedBytes = originalBytes + dictionary.storedBytes;
				indexBytes = dictionary.storedBytes;
				rawBytes =
					strings.bytes.length + strings.offsets.byteLength + dictionary.storedBytes;
				if ("mphBytes" in dictionary) mphBytes = dictionary.mphBytes;
				if (requests) {
					const time = performance.now();
					let result: Uint32Array;
					if ("levels" in dictionary) {
						result = new Uint32Array(requested + 1).fill(absentId);
						const confirmed = new Uint32Array(result.length);
						let n = 0;
						for (let i = 0; i < result.length; i++) {
							const key = stringBytes(requests.strings, i),
								hash = hashBytes(key),
								id = perfectCandidate(dictionary, hash[0], hash[1]);
							if (id !== absentId) {
								confirmed[n++] = id;
								confirmations++;
								if (compareBytes(key, stringBytes(strings, id)) === 0)
									result[i] = id;
							}
						}
						const read = decodeOriginal(stored, confirmed.subarray(0, n), strings);
						appendReadBytes = read.readBytes + dictionary.storedBytes;
						appendBlocks = read.blocks;
					} else {
						const hashes = Uint32Array.from({ length: requested + 1 }, (_, i) =>
							baselineHash(stringBytes(requests.strings, i))
						);
						const lookup = lookupHash(dictionary, strings, requests.strings, hashes);
						result = lookup.result;
						confirmations = lookup.stats.confirmations;
						const read = decodeOriginal(
							stored,
							result.filter((id) => id !== absentId),
							strings
						);
						appendReadBytes = read.readBytes + lookup.stats.bytes;
						appendBlocks = read.blocks;
					}
					appendMs = performance.now() - time;
					checkLookup(result, requests.strings, strings);
				}
				if ("levels" in dictionary) {
					// Independent absent-key trial, outside the one-byte append timing.
					absentTrials = 10000;
					for (let i = 0; i < absentTrials; i++) {
						const hash = hashBytes(Buffer.from(`\0absent-dictionary-key-${i}`));
						if (perfectCandidate(dictionary, hash[0], hash[1]) !== absentId)
							absentFalsePositives++;
					}
				}
				const time = performance.now(),
					page = decodeOriginal(stored, pageIds, strings);
				pageMs = performance.now() - time;
				pageReadBytes = page.readBytes;
				pageBlocks = page.blocks;
				const rangeTime = performance.now();
				for (let i = 0; i < count; i++)
					if (stringBytes(strings, i).subarray(0, prefix.length).equals(prefix))
						rangeMatches++;
				rangeMs = performance.now() - rangeTime;
			}
			// Independent range census proves the contiguous-range result.
			let expectedRange = 0;
			for (let i = 0; i < count; i++)
				if (stringBytes(strings, i).subarray(0, prefix.length).equals(prefix))
					expectedRange++;
			if (expectedRange !== rangeMatches) throw new Error("Range mismatch");
			process.send?.({
				kind: "result",
				result: {
					domain,
					count,
					utf8Bytes: strings.bytes.length,
					storedBytes,
					rawBytes,
					indexBytes,
					mphBytes,
					loadSeconds,
					buildSeconds,
					requests: requested + Number(requested > 0),
					appendMs,
					appendReadBytes,
					appendBlocks,
					confirmations,
					absentTrials,
					absentFalsePositives,
					pageMs,
					pageReadBytes,
					pageBlocks,
					rangeMs,
					rangeMatches,
					prefix: prefix.toString()
				}
			});
		}
	} finally {
		await reader.close();
	}
}
if (values.worker) {
	if (!process.send) throw new Error("Dictionary worker requires its supervised parent.");
	const sample = () => {
		const m = process.memoryUsage();
		process.send?.({ kind: "sample", heap: m.heapUsed, buffers: m.arrayBuffers, rss: m.rss });
	};
	const timer = setInterval(sample, 25);
	try {
		await worker();
		sample();
		process.send?.({ kind: "done" });
	} catch (cause) {
		process.send?.({ kind: "failed", error: String(cause) });
		process.exitCode = 1;
	} finally {
		clearInterval(timer);
		process.disconnect?.();
	}
} else {
	const directory = await openSnapshotFile(input);
	try {
		if (directory.directory.entries.get("line.source")?.count !== 583507 * scale)
			throw new Error("Saved snapshot does not match the declared 1×/10× scale.");
	} finally {
		await directory.close();
	}
	await mkdir(resolve(output, ".."), { recursive: true });
	const environment = { ...process.env };
	delete environment.NODE_OPTIONS;
	const child = fork(
		fileURLToPath(import.meta.url),
		[
			"--worker",
			"--input",
			input,
			"--output",
			output,
			"--scale",
			String(scale),
			"--candidate",
			candidate
		],
		{
			execArgv: ["--import", "tsx", `--max-old-space-size=${maximumHeapMiB}`, "--expose-gc"],
			env: environment,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe", "ipc"]
		}
	);
	const results: Schema.Json[] = [],
		peak = { heap: 0, buffers: 0, rss: 0 };
	let outcome: "done" | "failed" | undefined,
		error = "",
		stageStarted = performance.now(),
		polling = false,
		termination = Promise.resolve();
	const stop = (message: string) => {
		if (outcome === "failed") return;
		outcome = "failed";
		error = message;
		termination = killBenchmarkTree(child);
	};
	const save = () =>
		writeFile(
			output,
			JSON.stringify(
				{
					candidate,
					scale,
					input,
					node: process.version,
					outcome,
					error,
					wallSeconds: (performance.now() - started) / 1000,
					limits: {
						heapMiB: maximumHeapMiB,
						rssBytes: maximumRssBytes,
						stageSeconds: maximumStageSeconds,
						runSeconds: runSeconds ?? null
					},
					peak,
					results
				},
				null,
				"\t"
			) + "\n"
		);
	child.stderr?.on("data", (chunk) => {
		error = (error + String(chunk)).slice(-4096);
	});
	child.on("message", (value) => {
		if (benchmarkRunExpired(started, performance.now(), runSeconds)) {
			stop("Whole 10× run exceeded 15 minutes.");
			return;
		}
		if (outcome === "failed") return;
		const decoded = Schema.decodeUnknownResult(Message)(value);
		if (decoded._tag === "Failure") {
			stop("Invalid dictionary worker message.");
			return;
		}
		const message = decoded.success;
		if (message.kind === "sample") {
			peak.heap = Math.max(peak.heap, message.heap ?? 0);
			peak.buffers = Math.max(peak.buffers, message.buffers ?? 0);
			peak.rss = Math.max(peak.rss, message.rss ?? 0);
		} else if (message.kind === "progress") {
			stageStarted = performance.now();
			console.log(JSON.stringify(message.result));
		} else if (message.kind === "result" && message.result !== undefined) {
			results.push(message.result);
			console.log(JSON.stringify(message.result));
		} else if (message.kind === "done") outcome = "done";
		else if (message.kind === "failed") {
			outcome = "failed";
			error = message.error ?? "Worker failed";
		}
	});
	const deadline =
		runSeconds === undefined
			? undefined
			: setTimeout(
					() => stop("Whole 10× run exceeded 15 minutes."),
					Math.max(0, runSeconds * 1000 - (performance.now() - started))
				);
	const watchdog = setInterval(() => {
		if (performance.now() - stageStarted >= maximumStageSeconds * 1000)
			stop("Stage exceeded 20 minutes.");
		if (polling || !child.pid || outcome) return;
		polling = true;
		void childWorkingSet(child.pid)
			.then((rss) => {
				peak.rss = Math.max(peak.rss, rss);
				if (rss > maximumRssBytes) stop("RSS exceeded 20 GB.");
			})
			.catch((cause) => {
				if (child.exitCode === null && child.signalCode === null) stop(String(cause));
			})
			.finally(() => {
				polling = false;
			});
	}, 1000);
	await new Promise<void>((done) => {
		child.once("error", (cause) => stop(String(cause)));
		child.once("close", () => done());
	});
	clearInterval(watchdog);
	clearTimeout(deadline);
	await termination;
	if (benchmarkRunExpired(started, performance.now(), runSeconds)) {
		outcome = "failed";
		error = "Whole 10× run exceeded 15 minutes.";
	}
	if (!outcome) {
		outcome = "failed";
		error ||= "Worker exited without a result";
	}
	await save();
	console.log(`${candidate} ${scale}×: ${outcome}`);
	if (outcome !== "done") process.exitCode = 1;
}
