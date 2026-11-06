/**
 * `changedSince` over a generated ~707k-package project; packages are generated, not written.
 * Refresh one case per process, in order: `--mode refresh --case initial|packages|localization`,
 * then `similar`. Measure in a fresh process: `--mode measure --since <case|current> --kind lines`,
 * `--mode similar` or `--mode reference`. Pass `--executable <uasset> --root test-results/<dir>`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Effect, Layer, Result, Schema, Stream } from "effect";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationTarget,
	discoverLocalizationTargets
} from "../packages/localization/dist/index.js";
import type { SavedAssetPackageTextRecord } from "../packages/unreal-assets/dist/index.js";
import {
	GameTextIndexRefresh,
	GameTextIndexSource
} from "../packages/game-text/src/index-contract.ts";
import { gameTextIndexRefreshLayer } from "../packages/game-text/src/index-refresh.ts";
import {
	GameTextIndexQuery,
	nativeIndexQueryLayer
} from "../packages/game-text/src/index-query-native.ts";
import { nativeIndexBuilderLayer } from "../packages/game-text/src/native-index-builder.ts";
import { SharedIndex, sharedIndexNodeLayer } from "../packages/game-text/src/shared-index.ts";
import { LocalizationLineId } from "../packages/game-text/src/localization-schema.ts";
import {
	referenceSimilarKeyChanges,
	similarKeysCorpus,
	similarKeysReferenceLines
} from "../packages/game-text/src/similar-keys-reference.test-support.ts";

const decodeLocalizationLineId = Schema.decodeSync(LocalizationLineId);

const { values } = parseArgs({
	options: {
		mode: { type: "string" },
		case: { type: "string" },
		executable: { type: "string" },
		root: { type: "string", default: "test-results/changed-since" },
		packages: { type: "string", default: "707000" },
		since: { type: "string" },
		kind: { type: "string", default: "lines" },
		limit: { type: "string", default: "1000" }
	}
});
const mode = values.mode;
if (mode !== "refresh" && mode !== "measure" && mode !== "similar" && mode !== "reference")
	throw new Error("--mode must be refresh, measure, similar or reference.");
if (!values.executable) throw new Error("Provide --executable, the paired uasset reader.");
const executable = resolve(values.executable);
const root = resolve(values.root);
const within = relative(resolve("test-results"), root);
if (!within || within.startsWith("..") || isAbsolute(within))
	throw new Error("--root must be beneath this worktree's test-results directory.");
const projectRoot = join(root, "project");
const cacheRoot = join(root, "cache");
const generationsFile = join(root, "generations.json");
const count = Number(values.packages);
if (!Number.isSafeInteger(count) || count < 1000) throw new Error("--packages must be >= 1000.");

// The project: folders of ordinary packages, one in sixteen with text. A sync adds World
// Partition external actors, almost all without text.
const TEXT_EVERY = 16;
const ADDED = 55_000;
const ADDED_WITH_TEXT = 218;
const CHANGED_LINES = 1000;
const NAMESPACE = "Generated";
const CASES = ["initial", "packages", "localization", "similar"] as const;
type Case = (typeof CASES)[number];
const isCase = (value: string | undefined): value is Case => CASES.some((step) => step === value);

const packagePath = (id: number) =>
	`Content/Area${String(id % 97).padStart(2, "0")}/Group${String((id >> 5) % 89).padStart(2, "0")}/P${id}.uasset`;
const actorPath = (id: number) =>
	`Content/__ExternalActors__/Maps/World${id % 7}/${createHash("sha1")
		.update(String(id))
		.digest("hex")
		.slice(0, 2)
		.toUpperCase()}/A${id}.uasset`;
interface Generated {
	readonly path: string;
	readonly selected: boolean;
	readonly id: number;
}
/** The packages of a case's project: the base, and after `packages`, the sync's additions. */
const project = (step: Case) => {
	const packages: Generated[] = [];
	for (let id = 0; id < count; id++)
		packages.push({ path: packagePath(id), selected: id % TEXT_EVERY === 0, id });
	if (step !== "initial")
		for (let n = 0; n < ADDED; n++)
			packages.push({
				path: actorPath(count + n),
				selected: n % 252 === 0 && n / 252 < ADDED_WITH_TEXT,
				id: count + n
			});
	return packages;
};
const slots = (id: number) => 1 + (id % 3);
/**
 * The `similar` case's keys, over 600 of the base's text packages: earlier keys gathered from
 * them that they no longer save, and new keys they save that nothing gathered.
 */
const SIMILAR_PACKAGES = Array.from(
	{ length: 600 },
	(_, n) => n * TEXT_EVERY * Math.floor(count / TEXT_EVERY / 600)
);
const similar = similarKeysCorpus({
	seed: 707,
	earlier: 5000,
	fresh: 5000,
	packages: SIMILAR_PACKAGES.map(packagePath),
	namespace: NAMESPACE
});
const similarOccurrences = new Map(
	SIMILAR_PACKAGES.map((id, index) => [id, similar.packages[index]?.occurrences ?? []])
);
const source = (id: number, slot: number) => `Generated text ${id % 5000} slot ${slot} of ${id}`;
const record = (entry: Generated, step: Case): SavedAssetPackageTextRecord => {
	const name = `P${entry.id}`;
	const added = step === "similar" ? (similarOccurrences.get(entry.id) ?? []) : [];
	const object = `/Game/Generated/${name}.${name}`;
	return {
		event: "text_package_record",
		path: join(projectRoot, entry.path),
		fileBytes: 4096 + entry.id,
		schema_version: 1,
		status: "complete",
		decodeErrors: 0,
		occurrences: Array.from(
			{ length: slots(entry.id) },
			(_, slot): SavedAssetPackageTextRecord["occurrences"][number] => ({
				source: source(entry.id, slot),
				dev_notes: "",
				identity: { status: "resolved", namespace: NAMESPACE, key: `K${entry.id}-${slot}` },
				location: {
					kind: "asset_property",
					object_path: `${object}.Widget${slot}`,
					class_path: "/Script/UMG.TextBlock",
					property_path: "Text"
				},
				edit_capability: "read_only"
			})
		).concat(added),
		gapCounts: {
			unsupported_text_history: 0,
			legacy_container_element_without_type_information: 0,
			feature_unavailable_for_engine_version: 0,
			property_decoder_rejected: 0
		},
		gapSamples: []
	};
};

const discovered = discoverLocalizationTargets({
	configs: [
		{
			relativePath: "Config/Localization/Generated.ini",
			text: [
				"[CommonSettings]",
				"ManifestName=Generated.manifest",
				"NativeCulture=en",
				"CulturesToGenerate=en",
				"CulturesToGenerate=de",
				"[GatherTextStep0]",
				"CommandletClass=GatherTextFromAssets",
				"IncludePathFilters=Content/*",
				"PackageFileNameFilters=*.uasset",
				"ShouldExcludeDerivedClasses=false",
				""
			].join("\n")
		}
	]
});
if (Result.isFailure(discovered)) throw discovered.failure;
const recipe = discovered.success.targets[0];
if (recipe === undefined) throw new Error("The generated recipe produced no target.");
const folder = "Content/Localization/Generated";
const target = Schema.decodeSync(LocalizationTarget)({
	...recipe,
	outputPaths: {
		...recipe.outputPaths,
		manifest: `${folder}/Generated.manifest`,
		archives: Object.fromEntries(
			recipe.cultures.map((culture) => [culture, `${folder}/${culture}/Generated.archive`])
		),
		portableObjects: Object.fromEntries(
			recipe.cultures.map((culture) => [culture, `${folder}/${culture}/Generated.po`])
		)
	}
});

/** The localized lines: every base text package's keys. `localization` revises German. */
const writeLocalization = async (step: Case) => {
	const lines: { key: string; text: string; path: string; revised: boolean }[] = [];
	for (let id = 0; id < count; id += TEXT_EVERY)
		for (let slot = 0; slot < slots(id); slot++)
			lines.push({
				key: `K${id}-${slot}`,
				text: source(id, slot),
				path: `/Game/Generated/P${id}.P${id}.Widget${slot}`,
				revised: false
			});
	if (step === "localization" || step === "similar") {
		const stride = Math.floor(lines.length / CHANGED_LINES);
		for (let n = 0; n < CHANGED_LINES; n++) lines[n * stride]!.revised = true;
	}
	const write = async (path: string | null | undefined, text: string) => {
		if (!path) throw new Error("The generated target has no such output path.");
		const file = join(projectRoot, path);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, text);
	};
	await write(
		target.outputPaths.manifest,
		JSON.stringify({
			FormatVersion: 1,
			Namespace: NAMESPACE,
			Children: [
				...lines.map((line) => ({
					Source: { Text: line.text },
					Keys: [{ Key: line.key, Path: line.path }]
				})),
				...(step === "similar" ? similar.children : [])
			]
		})
	);
	for (const culture of target.cultures) {
		const translation = (line: (typeof lines)[number]) =>
			culture === target.nativeCulture
				? line.text
				: `${culture} ${line.text}${line.revised ? " (revised)" : ""}`;
		await write(
			target.outputPaths.archives[culture],
			JSON.stringify({
				FormatVersion: 2,
				Namespace: NAMESPACE,
				Children: [
					...lines.map((line) => ({
						Key: line.key,
						Source: { Text: line.text },
						Translation: { Text: translation(line) }
					})),
					...(step === "similar" ? similar.archiveChildren(culture) : [])
				]
			})
		);
		await write(
			target.outputPaths.portableObjects[culture],
			lines
				.map(
					(line) =>
						`msgctxt "${NAMESPACE},${line.key}"\nmsgid "${line.text}"\nmsgstr "${translation(line)}"\n`
				)
				.join("\n")
		);
	}
	return lines.length;
};

const indexConfiguration = {
	cacheRoot,
	projectKey: projectRoot,
	targetKey: target.name,
	projectView: { kind: "localization" as const, target: target.name }
};
const readerConfiguration = { executable, timeoutMs: 3_600_000, catalogTimeoutMs: 3_600_000 };
const readGenerations = async (): Promise<Partial<Record<Case, string>>> =>
	JSON.parse(await readFile(generationsFile, "utf8").catch(() => "{}"));

const refresh = async (step: Case) => {
	await mkdir(projectRoot, { recursive: true });
	const filesStarted = performance.now();
	const lines = await writeLocalization(step);
	const filesMs = performance.now() - filesStarted;
	const byPath = new Map(project(step).map((entry) => [join(projectRoot, entry.path), entry]));
	const inventory = [...byPath.entries()]
		.map(([path, entry]) => ({ path, entry, key: Buffer.from(path) }))
		.sort((a, b) => Buffer.compare(a.key, b.key))
		.map(({ path, entry }) => ({
			path,
			// A package's signature changes only when `similar` adds keys to it.
			signature:
				step === "similar" && similarOccurrences.has(entry.id)
					? `s1-${entry.id}`
					: `s0-${entry.id}`,
			headerData: {
				packageFlags: entry.selected ? 0x40000 : 0,
				gatherableTextDataCount: entry.selected ? 1 : 0,
				gatherableTextDataOffset: entry.selected ? 1 : 0,
				hasTextProperty: entry.selected
			}
		}));
	let reads = 0;
	const packageSource = Layer.succeed(GameTextIndexSource, {
		inventory: () => Effect.succeed(inventory),
		read: (_root, entries) => {
			reads += entries.length;
			return Stream.fromIterable(entries).pipe(
				Stream.map((entry) => record(byPath.get(entry.path)!, step))
			);
		}
	});
	const evidence = Layer.effect(
		LocalizationEvidence,
		Effect.gen(function* () {
			const live = yield* LocalizationEvidence;
			return LocalizationEvidence.of({
				...live,
				discover: () =>
					Effect.succeed({ schemaVersion: 1, targets: [target], diagnostics: [] })
			});
		})
	).pipe(Layer.provide(LocalizationEvidenceNodeLive));
	const layer = gameTextIndexRefreshLayer(cacheRoot).pipe(
		Layer.provide(packageSource),
		Layer.provide(nativeIndexBuilderLayer(readerConfiguration)),
		Layer.provide(nativeIndexQueryLayer(readerConfiguration)),
		Layer.provide(evidence)
	);
	const started = performance.now();
	const refreshed = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const model = yield* (yield* GameTextIndexRefresh).refresh({
					projectRoot,
					targetName: target.name
				});
				return {
					generation: model.generation,
					lines: model.join.count,
					rebuilt: model.join.rebuilt,
					packagesRead: model.packages.readPackages
				};
			})
		).pipe(Effect.provide(layer))
	);
	if (refreshed.generation === undefined) throw new Error("The refresh reported no generation.");
	const generations = await readGenerations();
	generations[step] = refreshed.generation;
	await writeFile(generationsFile, JSON.stringify(generations, null, "\t") + "\n");
	return {
		mode,
		case: step,
		node: process.version,
		executable,
		inventory: inventory.length,
		localizedLines: lines,
		reads,
		filesMs: Math.round(filesMs),
		refreshMs: Math.round(performance.now() - started),
		...refreshed
	};
};

/** Runs a command and returns what it printed. */
const output = (command: string, args: readonly string[]) =>
	new Promise<string>((done, fail) => {
		const child = spawn(command, args, { windowsHide: true });
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.on("error", fail);
		child.on("close", () => done(stdout));
	});

/** The engine process's working set, sampled every 25 ms until stopped. */
const watch = (pid: number) => {
	const samples: { readonly workingSet: number; readonly peak: number }[] = [];
	const child = spawn(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`while ($true) { $p = Get-Process -Id ${pid} -ErrorAction Stop; "$($p.WorkingSet64) $($p.PeakWorkingSet64)"; Start-Sleep -Milliseconds 25 }`
		],
		{ windowsHide: true }
	);
	let buffered = "";
	child.stdout.on("data", (chunk: Buffer) => {
		buffered += chunk.toString();
		const lines = buffered.split(/\r?\n/u);
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			const [workingSet, peak] = line.trim().split(" ").map(Number);
			if (workingSet && peak) samples.push({ workingSet, peak });
		}
	});
	return {
		samples,
		/** The first sample taken after now. */
		next: async () => {
			const seen = samples.length;
			while (samples.length < seen + 2) await new Promise((done) => setTimeout(done, 10));
			return samples.at(-1)!;
		},
		stop: () => child.kill()
	};
};

const measure = async (kind: "lines" | "packages", since: string | undefined) => {
	const limit = Number(values.limit);
	const children = await output("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`
	]);
	const before = new Set(children.trim().split(/\r?\n/u));
	const engine = async () => {
		const listed = await output("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`
		]);
		const engines = listed
			.trim()
			.split(/\r?\n/u)
			.filter((line) => !before.has(line) && line.toLowerCase().includes("uasset"));
		if (engines.length !== 1)
			throw new Error(`Expected one engine process, found ${engines.length}.`);
		return Number(engines[0]!.trim().split(" ")[0]);
	};
	const mib = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10;
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const manifest = yield* (yield* SharedIndex).inspect;
				const joinedKey = manifest.active.joined;
				if (joinedKey === undefined) throw new Error("No joined target is published.");
				const openStarted = performance.now();
				const query = yield* (yield* GameTextIndexQuery).open({
					configuration: indexConfiguration,
					storeEpoch: manifest.generation,
					joinedKey
				});
				const openMs = performance.now() - openStarted;
				const watcher = watch(yield* Effect.promise(engine));
				const start = yield* Effect.promise(watcher.next);
				const firstSample = watcher.samples.length;
				const started = performance.now();
				let firstPageMs = 0;
				let pages = 0;
				let items = 0;
				let after: string | undefined;
				let answer;
				do {
					answer = yield* query.changedSince({
						since: since ?? joinedKey,
						kind,
						limit,
						...(after === undefined ? undefined : { after })
					});
					if (pages++ === 0) firstPageMs = performance.now() - started;
					if (answer.status !== "changes") break;
					items += answer.items.length;
					after = answer.nextCursor;
				} while (after !== undefined);
				const everyPageMs = performance.now() - started;
				const end = yield* Effect.promise(watcher.next);
				watcher.stop();
				const during = watcher.samples.slice(firstSample);
				return {
					mode,
					since: values.since,
					kind,
					limit,
					node: process.version,
					executable,
					joinedKey,
					openMs: Math.round(openMs),
					status: answer.status,
					...(answer.status === "changes" ? { counts: answer.counts } : undefined),
					...(answer.status === "too_old" ? { reason: answer.reason } : undefined),
					pages,
					items,
					firstPageMs: Math.round(firstPageMs * 10) / 10,
					everyPageMs: Math.round(everyPageMs * 10) / 10,
					engineMemoryMiB: {
						workingSetBefore: mib(start.workingSet),
						workingSetPeakDuring: mib(
							Math.max(start.workingSet, ...during.map((sample) => sample.workingSet))
						),
						workingSetAfter: mib(end.workingSet),
						processPeakAfter: mib(end.peak),
						samples: during.length
					}
				};
			})
		).pipe(
			Effect.provide(
				Layer.mergeAll(
					nativeIndexQueryLayer(readerConfiguration),
					sharedIndexNodeLayer(indexConfiguration)
				)
			)
		)
	);
};

/** The line ID of a generated key in the target. */
const lineId = (key: string) => `${target.name}:${JSON.stringify([NAMESPACE, key])}`;

/**
 * `related` with similar keys in a fresh reader: a plain read of one new key first, so the
 * reader's projection and related index are warm, then the first similar-keys read (the index
 * build and its answer), then one for another key.
 */
const measureSimilar = async () => {
	const listChildren = () =>
		output("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`
		]);
	const before = new Set((await listChildren()).trim().split(/\r?\n/u));
	const engine = async () => {
		const engines = (await listChildren())
			.trim()
			.split(/\r?\n/u)
			.filter((line) => !before.has(line) && line.toLowerCase().includes("uasset"));
		if (engines.length !== 1)
			throw new Error(`Expected one engine process, found ${engines.length}.`);
		return Number(engines[0]!.trim().split(" ")[0]);
	};
	const mib = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10;
	const ms = (started: number) => Math.round((performance.now() - started) * 10) / 10;
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const manifest = yield* (yield* SharedIndex).inspect;
				const joinedKey = manifest.active.joined;
				if (joinedKey === undefined) throw new Error("No joined target is published.");
				const query = yield* (yield* GameTextIndexQuery).open({
					configuration: indexConfiguration,
					storeEpoch: manifest.generation,
					joinedKey
				});
				const watcher = watch(yield* Effect.promise(engine));
				const start = yield* Effect.promise(watcher.next);
				const firstSample = watcher.samples.length;
				const read = (key: string, withSimilar: boolean) =>
					query.related({
						target: target.name,
						selection: {
							kind: "line",
							id: decodeLocalizationLineId(lineId(key))
						},
						pageSize: 10,
						...(withSimilar ? { similarKeys: { limit: 20 } } : undefined)
					});
				let started = performance.now();
				const plain = yield* read("New1", false);
				const plainMs = ms(started);
				if (plain === undefined) throw new Error("The generated key New1 has no line.");
				started = performance.now();
				const first = (yield* read("New1", true))?.similarKeys;
				const firstMs = ms(started);
				started = performance.now();
				const later = (yield* read("New2", true))?.similarKeys;
				const laterMs = ms(started);
				const end = yield* Effect.promise(watcher.next);
				watcher.stop();
				const during = watcher.samples.slice(firstSample);
				return {
					mode,
					node: process.version,
					executable,
					joinedKey,
					plainRelatedMs: plainMs,
					firstSimilarMs: firstMs,
					firstBuildMs: Math.round((first?.buildMs ?? 0) * 10) / 10,
					laterSimilarMs: laterMs,
					laterBuildMs: later?.buildMs,
					pairs: first?.pairs,
					truncated: first?.truncated,
					firstState: first?.state,
					firstPaired: first?.pair !== undefined,
					laterCandidates: later?.candidates.length,
					engineMemoryMiB: {
						workingSetBefore: mib(start.workingSet),
						workingSetPeakDuring: mib(
							Math.max(start.workingSet, ...during.map((sample) => sample.workingSet))
						),
						workingSetAfter: mib(end.workingSet),
						processPeakAfter: mib(end.peak),
						samples: during.length
					}
				};
			})
		).pipe(
			Effect.provide(
				Layer.mergeAll(
					nativeIndexQueryLayer(readerConfiguration),
					sharedIndexNodeLayer(indexConfiguration)
				)
			)
		)
	);
};

/** The JavaScript reference matcher over the `similar` case's keys, three times. */
const measureReference = () => {
	const { olds, news } = similarKeysReferenceLines(similar);
	const runs = [0, 1, 2].map(() => {
		const started = performance.now();
		const result = referenceSimilarKeyChanges(olds, news);
		return {
			ms: performance.now() - started,
			pairs: result.pairs.length,
			truncated: result.truncated
		};
	});
	const sorted = runs.map((run) => run.ms).toSorted((a, b) => a - b);
	return {
		mode,
		node: process.version,
		earlier: olds.length,
		fresh: news.length,
		pairs: runs[0]?.pairs,
		truncated: runs[0]?.truncated,
		runsMs: runs.map((run) => Math.round(run.ms * 10) / 10),
		medianMs: Math.round((sorted[1] ?? 0) * 10) / 10
	};
};

if (mode === "similar") {
	console.log(JSON.stringify(await measureSimilar()));
} else if (mode === "reference") {
	console.log(JSON.stringify(measureReference()));
} else if (mode === "refresh") {
	if (!isCase(values.case)) throw new Error(`--case must be one of ${CASES.join(", ")}.`);
	console.log(JSON.stringify(await refresh(values.case)));
} else {
	const kind = values.kind;
	if (kind !== "lines" && kind !== "packages")
		throw new Error("--kind must be lines or packages.");
	const generations = await readGenerations();
	const since = isCase(values.since) ? generations[values.since] : undefined;
	if (values.since !== "current" && since === undefined)
		throw new Error("--since must name a recorded case, or be current.");
	console.log(JSON.stringify(await measure(kind, since)));
}
