import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SavedAssetScan } from "@ue-shed/protocol";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import type {
	AssetReaderConfiguration,
	SavedAssetScanOptions,
	ScanProgressStore
} from "./asset-reader.js";
import { readerPathKey } from "./protocol-path-identity.js";
import { invokeProtocolScan } from "./protocol-transport.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();

/** A no-op `./` prefix that makes each path about 2 KiB, so a small request limit holds one. */
const pad = (path: string) => `${"./".repeat(1_000)}${path}`;
/** Fits one padded path next to a scan envelope, never two. */
const ONE_PATH_PER_REQUEST = 4_200;

function store(): ScanProgressStore {
	return {
		current: {
			cacheHits: 0,
			emittedAssets: 0,
			phase: "idle",
			processedAssets: 0,
			totalAssets: 0
		}
	};
}

async function packageCount(directory: string): Promise<number> {
	let count = 0;
	for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }))
		if (entry.isFile() && /\.(uasset|umap)$/iu.test(entry.name)) count += 1;
	return count;
}

describe.skipIf(!executable)("batched reads against the native reader", () => {
	let workers = 0;
	const configuration = (): AssetReaderConfiguration => ({
		catalogTimeoutMs: 120_000,
		executable: executable!,
		protocolObserver: (event) => {
			if (event.kind === "worker_started") workers += 1;
		},
		timeoutMs: 120_000
	});
	const scan = (
		options: Omit<SavedAssetScanOptions, "projectRoot">,
		maximumRequestBytes?: number
	) => {
		workers = 0;
		return invokeProtocolScan(
			configuration(),
			{ depth: "header", projectRoot: fixture.root, ...options },
			store(),
			maximumRequestBytes === undefined ? {} : { maximumRequestBytes }
		);
	};
	const keys = (result: SavedAssetScan) =>
		result.assets
			.map((entry) =>
				readerPathKey(
					fixture.root,
					entry.depth === "header" ? entry.header.path : entry.inspection.path
				)
			)
			.sort();

	it("reads a path repeated across the split once", async () => {
		const a = "Content/Fixture/Animation/SK_Fixture.uasset";
		const b = "Content/Fixture/Animation/A_FixtureMotion.uasset";
		// The repeat is spelled differently but is one path to the reader.
		const paths = [pad(a), pad(b), pad(a.replaceAll("/", "\\"))];
		const result = await Effect.runPromise(
			scan({ maximumAssets: 2, paths }, ONE_PATH_PER_REQUEST)
		);

		expect(workers).toBe(2);
		expect(keys(result)).toEqual(
			[b, a].map((path) => readerPathKey(fixture.root, path)).sort()
		);
		expect(result.summary.scannedAssets).toBe(2);
	});

	it("reads overlapping roots as one request would", async () => {
		const paths = [
			"Content/Fixture/Animation",
			"Content/Fixture/Animation/SK_Fixture.uasset",
			"Content/Fixture/Sequences"
		];
		const whole = await Effect.runPromise(scan({ paths }));
		expect(workers).toBe(1);
		const batched = await Effect.runPromise(
			scan({ paths: paths.map(pad) }, ONE_PATH_PER_REQUEST)
		);

		expect(workers).toBe(2);
		expect(keys(batched)).toEqual(keys(whole));
		expect(batched.summary.scannedAssets).toBe(whole.summary.scannedAssets);
		expect(batched.summary.emittedAssets).toBe(whole.summary.emittedAssets);
	});

	it("refuses unique packages over maximumAssets across batches and starts no more", async () => {
		const directories = [
			"Content/Fixture/Animation",
			"Content/Fixture/Text",
			"Content/Fixture/Sequences"
		];
		const [first, second] = await Promise.all(
			directories.slice(0, 2).map((directory) => packageCount(join(fixture.root, directory)))
		);
		const maximumAssets = first! + second! - 1;
		const error = await Effect.runPromise(
			Effect.flip(scan({ maximumAssets, paths: directories.map(pad) }, ONE_PATH_PER_REQUEST))
		);

		expect(error).toMatchObject({
			kind: "resource_limit",
			code: "resource_limit",
			nextStep: "fix_input",
			retrySafe: false,
			exitCode: 7,
			message: `Scan found ${first! + second!} packages, above the limit of ${maximumAssets}.`
		});
		expect(workers).toBe(2);
	});

	describe("header cache", () => {
		let caches: string;
		beforeAll(async () => {
			caches = await mkdtemp(join(tmpdir(), "ue-shed-batch-cache-"));
		});
		afterAll(async () => {
			await rm(caches, { recursive: true, force: true });
		});

		it("keeps one cache per batch, so an unchanged batched scan hits every package", async () => {
			const cachePath = join(caches, "scan.json");
			// Leftovers of an earlier, longer scan: batch 2 is removed, batch 4 is past the gap.
			await writeFile(`${cachePath}.batch-2`, "{}");
			await writeFile(`${cachePath}.batch-4`, "{}");
			const options = {
				cachePath,
				paths: ["Content/Fixture/Animation", "Content/Fixture/Text"].map(pad)
			};
			const cold = await Effect.runPromise(scan(options, ONE_PATH_PER_REQUEST));
			expect(workers).toBe(2);
			expect(cold.summary.cacheHits).toBe(0);
			const warm = await Effect.runPromise(scan(options, ONE_PATH_PER_REQUEST));

			expect(warm.summary.scannedAssets).toBeGreaterThan(0);
			expect(warm.summary.cacheHits).toBe(warm.summary.scannedAssets);
			expect(existsSync(`${cachePath}.batch-0`)).toBe(true);
			expect(existsSync(`${cachePath}.batch-1`)).toBe(true);
			expect(existsSync(`${cachePath}.batch-2`)).toBe(false);
			expect(existsSync(`${cachePath}.batch-4`)).toBe(true);
			// The single-request cache is left for a later scan that fits one request.
			expect(existsSync(cachePath)).toBe(false);
		});
	});
});
