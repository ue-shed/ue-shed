import { createHash, type BinaryLike } from "node:crypto";
import { cp, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	GAME_TEXT_PACKAGE_NAME,
	MAP_HISTORY_PACKAGE_NAME,
	packPublicPackages,
	PUBLIC_PACKAGES,
	WASM_PACKAGE_NAME
} from "./pack-public-packages.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface RunOptions {
	readonly env?: NodeJS.ProcessEnv;
}

function executable(name: string) {
	return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command: string, args: readonly string[], cwd: string, options: RunOptions = {}) {
	const isCommandShim = process.platform === "win32" && command.endsWith(".cmd");
	const result = spawnSync(
		isCommandShim ? (process.env.ComSpec ?? "cmd.exe") : command,
		isCommandShim ? ["/d", "/s", "/c", command, ...args] : args,
		{
			cwd,
			encoding: "utf8",
			shell: false,
			env: options.env ?? process.env
		}
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
		);
	}
	return result.stdout.trim();
}

function sha256(bytes: BinaryLike) {
	return createHash("sha256").update(bytes).digest("hex");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "ue-shed-public-packages-"));
try {
	const packageDirectory = join(temporaryRoot, "packages");
	const consumerDirectory = join(temporaryRoot, "consumer");
	await mkdir(packageDirectory);
	await mkdir(consumerDirectory);
	const packed = await packPublicPackages({ output: packageDirectory });
	assert.deepEqual(
		packed.map((entry) => entry.name),
		PUBLIC_PACKAGES.map((entry) => entry.name),
		"packed package order must match the protected release order"
	);
	for (const entry of packed) {
		assert.equal(entry.manifest.license, "MIT", `${entry.name} must retain MIT metadata`);
	}
	const wasmEntry = packed.find((entry) => entry.name === WASM_PACKAGE_NAME);
	assert.ok(wasmEntry, "the public package graph must contain the WASM package");
	const wasmFiles = run("tar", ["-tzf", basename(wasmEntry.path)], packageDirectory)
		.split(/\r?\n/u)
		.filter(Boolean);
	assert.ok(
		wasmFiles.some((file) => file.endsWith(".wasm")),
		"the packed WASM package must contain a .wasm artifact"
	);
	assert.ok(
		wasmFiles.some((file) => file.endsWith(".d.ts")),
		"the packed WASM package must contain TypeScript declarations"
	);
	const wasmBuildInfo = JSON.parse(
		run(
			"tar",
			["-xOf", basename(wasmEntry.path), "package/dist/build-info.json"],
			packageDirectory
		)
	);
	assert.equal(wasmBuildInfo.packageVersion, wasmEntry.manifest.version);
	assert.deepEqual(wasmBuildInfo.targets, ["nodejs", "web"]);
	assert.ok(
		wasmBuildInfo.optimizer?.enabled === true || wasmBuildInfo.optimizer?.enabled === false
	);
	assert.equal(Object.prototype.toString.call(wasmBuildInfo.tools?.wasmOpt), "[object String]");
	if (wasmBuildInfo.optimizer.enabled) {
		assert.equal(
			Object.prototype.toString.call(wasmBuildInfo.optimizer.version),
			"[object String]"
		);
		assert.equal(wasmBuildInfo.tools.wasmOpt, wasmBuildInfo.optimizer.version);
	} else {
		assert.equal(wasmBuildInfo.optimizer.status, "disabled");
		assert.equal(
			Object.prototype.toString.call(wasmBuildInfo.optimizer.reason),
			"[object String]"
		);
		assert.match(wasmBuildInfo.tools.wasmOpt, /disabled|no[ -]?opt/iu);
	}
	const gameTextEntry = packed.find((entry) => entry.name === GAME_TEXT_PACKAGE_NAME);
	assert.ok(gameTextEntry, "the public package graph must contain Game Text");
	const gameTextFiles = run("tar", ["-tzf", basename(gameTextEntry.path)], packageDirectory)
		.split(/\r?\n/u)
		.filter(Boolean);
	assert.ok(gameTextFiles.includes("package/ADOPTING.md"));
	assert.ok(gameTextFiles.includes("package/adoption.manifest.json"));
	const gameTextAdoption = JSON.parse(
		run(
			"tar",
			["-xOf", basename(gameTextEntry.path), "package/adoption.manifest.json"],
			packageDirectory
		)
	);
	assert.equal(gameTextAdoption.feature, "game-text");
	assert.equal(gameTextAdoption.release.versionSource, "package.json");
	assert.equal(gameTextAdoption.release.nativeBinaryBundled, false);
	assert.equal(gameTextAdoption.release.uiBundled, false);
	assert.equal(
		gameTextAdoption.packageGraph.dependencies["@ue-shed/unreal-assets"],
		"package.json#dependencies"
	);
	assert.deepEqual(gameTextAdoption.capabilities.required, [
		"saved-project",
		"saved-asset-reader"
	]);
	assert.ok(gameTextAdoption.capabilities.notRequired.includes("ue-shed-unreal-plugin"));
	const packageChecksums = await readFile(join(packageDirectory, "SHA256SUMS"), "utf8");
	const checksumRows = packageChecksums
		.trim()
		.split(/\r?\n/u)
		.map((line) => line.trim().split(/\s+/u));
	assert.equal(checksumRows.length, packed.length, "checksum manifest must cover every package");
	for (const [expectedDigest, filename] of checksumRows) {
		const entry = packed.find((candidate) => candidate.filename === filename);
		assert.ok(entry, `checksum manifest contains an unknown package ${filename}`);
		assert.equal(
			sha256(await readFile(entry.path)),
			expectedDigest,
			`checksum mismatch for ${filename}`
		);
		assert.equal(entry.sha256, expectedDigest, `returned digest mismatch for ${filename}`);
	}
	const packagesManifest = JSON.parse(
		await readFile(join(packageDirectory, "packages-manifest.json"), "utf8")
	);
	assert.equal(packagesManifest.schemaVersion, 1);
	assert.deepEqual(
		packagesManifest.packages.map(({ name }: { readonly name: string }) => name),
		PUBLIC_PACKAGES.map(({ name }) => name)
	);
	for (const packageEntry of packagesManifest.packages) {
		const packedEntry = packed.find((entry) => entry.name === packageEntry.name);
		assert.ok(
			packedEntry,
			`packages manifest contains an unknown package ${packageEntry.name}`
		);
		assert.equal(packageEntry.version, packedEntry.manifest.version);
		assert.equal(packageEntry.license, "MIT");
		assert.equal(packageEntry.filename, packedEntry.filename);
		assert.equal(packageEntry.sha256, packedEntry.sha256);
		assert.equal(packageEntry.bytes, packedEntry.bytes);
	}
	const dependencyEntries = Object.fromEntries(
		packed.map((entry) => [entry.name, `file:${entry.path.replaceAll("\\", "/")}`])
	);
	await writeFile(
		join(consumerDirectory, "package.json"),
		`${JSON.stringify(
			{
				name: "ue-shed-packed-consumer",
				private: true,
				type: "module",
				dependencies: {
					...dependencyEntries,
					effect: "4.0.0-beta.98"
				}
			},
			null,
			2
		)}\n`,
		"utf8"
	);
	const overrideLines = Object.entries(dependencyEntries).map(
		([name, locator]) => `  "${name}": "${locator}"`
	);
	await writeFile(
		join(consumerDirectory, "pnpm-workspace.yaml"),
		`overrides:\n${overrideLines.join("\n")}\n`,
		"utf8"
	);
	// Seed the store with the consumer's resolved graph (catalog ranges can float past the
	// monorepo lockfile), then prove that graph reinstalls offline from store alone.
	run(executable("pnpm"), ["install", "--ignore-scripts"], consumerDirectory);
	await rm(join(consumerDirectory, "node_modules"), { recursive: true, force: true });
	run(
		executable("pnpm"),
		["install", "--offline", "--ignore-scripts", "--frozen-lockfile"],
		consumerDirectory
	);
	const consumerEnvironment = { ...process.env };
	delete consumerEnvironment.UE_SHED_UASSET_EXECUTABLE;
	const consumerScript = join(consumerDirectory, "verify-map-review.mjs");
	await writeFile(
		consumerScript,
		`${[
			"import { Effect, Schema } from 'effect';",
			"import * as protocol from '@ue-shed/protocol';",
			"import * as assets from '@ue-shed/unreal-assets';",
			"import * as observability from '@ue-shed/observability';",
			"import * as connection from '@ue-shed/unreal-connection';",
			"import * as cameras from '@ue-shed/cameras';",
			"import * as reviewContracts from '@ue-shed/cameras/review-contracts';",
			"import * as observatory from '@ue-shed/observatory';",
			"import * as presentation from '@ue-shed/observatory/presentation';",
			"if (protocol.CURRENT_PROTOCOL_VERSION.major !== 0) throw new Error('bad protocol');",
			"if (typeof assets.decodeSavedAssetInspection !== 'function') {",
			"  throw new Error('bad assets export');",
			"}",
			"if (typeof connection.RemoteControlClient !== 'function') {",
			"  throw new Error('bad unreal-connection export');",
			"}",
			"if (typeof cameras.decodeReviewSet !== 'function') {",
			"  throw new Error('bad cameras decodeReviewSet');",
			"}",
			"if (typeof cameras.ReviewCapture !== 'function') {",
			"  throw new Error('bad cameras ReviewCapture');",
			"}",
			"if (reviewContracts.MapReviewResult === undefined) {",
			"  throw new Error('bad review-contracts MapReviewResult');",
			"}",
			"if (typeof observability.aggregateHealth !== 'function') {",
			"  throw new Error('bad observability aggregateHealth');",
			"}",
			"if (typeof observatory.ActorStreamDecoder !== 'function' || typeof presentation.applyTransformBatch !== 'function') {",
			"  throw new Error('bad observatory exports');",
			"}",
			"const reviewSet = await Effect.runPromise(cameras.decodeReviewSet({",
			"  captureProfiles: [{",
			"    id: 'fixture-hd',",
			"    imageFormat: 'png',",
			"    renderProfile: 'full_fidelity',",
			"    resolution: { height: 720, width: 1280 },",
			"    variantPolicy: 'pure_only'",
			"  }],",
			"  contract: { name: 'ue-shed-review-set', version: { major: 1, minor: 0 } },",
			"  displayName: 'Offline Consumer',",
			"  id: 'set-offline-consumer',",
			"  project: { id: 'offline-consumer', mapPath: '/Game/Maps/Demo.Demo' },",
			"  views: []",
			"}));",
			"if (reviewSet.id !== 'set-offline-consumer') throw new Error('review set decode failed');",
			"await Effect.runPromise(",
			"  Schema.decodeUnknownEffect(reviewContracts.MapReviewResult)({ status: 'not_configured' })",
			");",
			"const health = observability.aggregateHealth(observability.defaultHealthInput);",
			"if (health.status !== 'healthy') throw new Error('health aggregation failed');",
			"const bytes = observatory.encodeActorStreamPacket({",
			"  catalogRevision: 1n,",
			"  records: [{ flags: 0, location: { x: 1, y: 2, z: 3 }, rotation: { pitch: 0, roll: 0, yaw: 0 }, streamIndex: 0 }],",
			"  sequence: 1n,",
			"  sessionId: '00112233445566778899aabbccddeeff'",
			"});",
			"const packets = new observatory.ActorStreamDecoder().push(bytes).packets;",
			"if (packets.length !== 1 || packets[0].records.length !== 1) throw new Error('observatory decode failed');",
			"console.log('map-review-offline-ok');"
		].join("\n")}\n`,
		"utf8"
	);
	const mapReviewStatus = run(process.execPath, [consumerScript], consumerDirectory, {
		env: consumerEnvironment
	});
	if (mapReviewStatus !== "map-review-offline-ok") {
		throw new Error(`Map Review offline consumer returned ${JSON.stringify(mapReviewStatus)}.`);
	}
	const version = run(executable("pnpm"), ["exec", "uasset", "--version"], consumerDirectory, {
		env: consumerEnvironment
	});
	const uassetVersion = packed.find((entry) => entry.name === "@ue-shed/uasset")?.manifest
		.version;
	if (version !== `uasset ${uassetVersion}`) {
		throw new Error(`Packed CLI returned ${JSON.stringify(version)}.`);
	}
	const fixtureDirectory = join(consumerDirectory, "fixture");
	await mkdir(fixtureDirectory);
	const fixturePath = join(fixtureDirectory, "DT_Scalars.uasset");
	await copyFile(
		join(
			repositoryRoot,
			"fixtures",
			"unreal-project",
			"Content",
			"Fixture",
			"Authoring",
			"DT_Scalars.uasset"
		),
		fixturePath
	);
	const inspectionRaw = run(
		executable("pnpm"),
		["exec", "uasset", "inspect", fixturePath, "--format", "json"],
		consumerDirectory,
		{ env: consumerEnvironment }
	);
	const inspection = JSON.parse(inspectionRaw);
	if (inspection.schema_version !== 8 || inspection.assets?.[0]?.kind !== "DataTable") {
		throw new Error("Packed CLI did not produce the stable DataTable inspection contract.");
	}
	const gameTextProject = join(consumerDirectory, "game-text-project");
	const gameTextContent = join(gameTextProject, "Content", "Fixture", "Text");
	await mkdir(dirname(gameTextContent), { recursive: true });
	await cp(
		join(repositoryRoot, "fixtures", "unreal-project", "Content", "Fixture", "Text"),
		gameTextContent,
		{ recursive: true }
	);
	const gameTextConsumerScript = join(consumerDirectory, "verify-game-text.mjs");
	await writeFile(
		gameTextConsumerScript,
		`${[
			"import { resolve } from 'node:path';",
			"import { Effect } from 'effect';",
			"import { resolveUassetExecutable } from '@ue-shed/uasset';",
			"import { assetReaderLayer } from '@ue-shed/unreal-assets';",
			"import { scanTextCorpus } from '@ue-shed/game-text';",
			"import { textCorpusQuery } from '@ue-shed/game-text/browser';",
			"const corpus = await Effect.runPromise(",
			"  scanTextCorpus({ projectRoot: resolve('./game-text-project') }).pipe(",
			"    Effect.provide(assetReaderLayer({ executable: resolveUassetExecutable() }))",
			"  )",
			");",
			"if (corpus.coverage.discoveredPackages !== 2 || corpus.coverage.textUnits < 1) {",
			"  throw new Error('packed Game Text scan did not account for the fixture');",
			"}",
			"const query = textCorpusQuery(corpus);",
			"const summary = query.summary();",
			"if (summary.coverage.textUnits !== corpus.coverage.textUnits) {",
			"  throw new Error('packed Game Text summary lost corpus coverage');",
			"}",
			"const page = query.search({ capability: 'all', pageSize: 50, query: '' });",
			"if (page.total < 1 || page.units.length < 1) {",
			"  throw new Error('packed Game Text search returned no fixture text');",
			"}",
			"const focus = query.focus({ id: page.units[0].id, pageSize: 50 });",
			"if (focus === undefined || focus.totalOccurrences < 1) {",
			"  throw new Error('packed Game Text focus returned no occurrence evidence');",
			"}",
			"console.log('game-text-packed-ok');"
		].join("\n")}\n`,
		"utf8"
	);
	const gameTextStatus = run(process.execPath, [gameTextConsumerScript], consumerDirectory, {
		env: consumerEnvironment
	});
	if (gameTextStatus !== "game-text-packed-ok") {
		throw new Error(`Game Text packed consumer returned ${JSON.stringify(gameTextStatus)}.`);
	}
	const mapHistoryConsumerScript = join(consumerDirectory, "verify-map-history.mjs");
	await writeFile(
		mapHistoryConsumerScript,
		`${[
			"import * as mapHistory from '@ue-shed/map-history';",
			"import { MapHistoryQuery } from '@ue-shed/map-history/contract';",
			"import { mapHistoryPlaybackFrameAt } from '@ue-shed/map-history/playback';",
			"if (typeof mapHistory.readPerforceMapHistory !== 'function') throw new Error('missing Map History service');",
			"if (MapHistoryQuery === undefined) throw new Error('missing Map History contract');",
			"const frame = mapHistoryPlaybackFrameAt({",
			"  history: {",
			"    baseline: { status: 'map_not_yet_created' },",
			"    completeness: 'complete',",
			"    diagnostics: [],",
			"    mapDepotPath: '//fixture/Content/Maps/World.umap',",
			"    query: {",
			"      limits: { maxChangelists: 1, maxFilesPerChangelist: 1, maxMaterializedBytes: 1, maxMaterializedFiles: 1 },",
			"      mapPath: 'Content/Maps/World.umap',",
			"      projectRoot: '.',",
			"      range: { since: '2026-01-01T00:00:00.000Z', until: '2026-01-02T00:00:00.000Z' }",
			"    },",
			"    revisions: [],",
			"    schemaVersion: 1",
			"  },",
			"  revisionIndex: undefined",
			"});",
			"if (frame.kind !== 'range_start' || frame.actors.length !== 0) throw new Error('Map History playback failed');",
			"console.log('world-log-packed-ok');"
		].join("\n")}\n`,
		"utf8"
	);
	const mapHistoryStatus = run(process.execPath, [mapHistoryConsumerScript], consumerDirectory, {
		env: consumerEnvironment
	});
	if (mapHistoryStatus !== "world-log-packed-ok") {
		throw new Error(
			`${MAP_HISTORY_PACKAGE_NAME} packed consumer returned ${JSON.stringify(mapHistoryStatus)}.`
		);
	}
	const wasmConsumerScript = join(consumerDirectory, "verify-wasm.mjs");
	await writeFile(
		wasmConsumerScript,
		`${[
			"import { readFile } from 'node:fs/promises';",
			"import * as imported from '@ue-shed/uasset-inspection-wasm';",
			"const api = { ...imported };",
			"if (imported.default && typeof imported.default === 'object') Object.assign(api, imported.default);",
			"if (typeof api.initialize === 'function') await api.initialize();",
			"if (typeof api.init === 'function') await api.init();",
			"if (typeof api.inspect !== 'function' && typeof imported.default === 'function') {",
			"  const initialized = await imported.default();",
			"  if (initialized && typeof initialized === 'object') Object.assign(api, initialized);",
			"}",
			"const extractText = api.extractText ?? api.extract_text;",
			"const extractTextures = api.extractTextures ?? api.extract_textures;",
			"for (const [name, value] of [['inspect', api.inspect], ['version', api.version], ['extractText', extractText], ['extractTextures', extractTextures]]) {",
			"  if (typeof value !== 'function') throw new Error(`missing WASM export ${name}`);",
			"}",
			"const bytes = new Uint8Array(await readFile('./fixture/DT_Scalars.uasset'));",
			"const path = 'fixture/DT_Scalars.uasset';",
			"const decode = async (fn, input = bytes) => {",
			"  const output = await fn(path, input);",
			"  return typeof output === 'string' ? JSON.parse(output) : output;",
			"};",
			"const version = String(await api.version()).replace(/^uasset\\s+/u, '');",
			`if (version !== '${wasmEntry.manifest.version}') throw new Error('unexpected WASM version ' + version);`,
			"const inspection = await decode(api.inspect);",
			"if (inspection.schema_version !== 8 || inspection.assets?.[0]?.kind !== 'DataTable') throw new Error('WASM inspection contract failed');",
			"const repeated = await decode(api.inspect);",
			"if (JSON.stringify(repeated) !== JSON.stringify(inspection)) throw new Error('WASM repeated call changed output');",
			"const text = await decode(extractText);",
			"if (text.schema_version !== 1) throw new Error('WASM text projection contract failed');",
			"const textures = await decode(extractTextures);",
			"if (textures.schema_version !== 1) throw new Error('WASM texture projection contract failed');",
			"const malformed = new Uint8Array([0, 1, 2, 3]);",
			"const malformedInspection = await decode(api.inspect, malformed);",
			"if (malformedInspection.schema_version !== 8 || malformedInspection.status !== 'error') throw new Error('WASM malformed-input contract failed');",
			"console.log('wasm-offline-ok');"
		].join("\n")}\n`,
		"utf8"
	);
	const wasmStatus = run(process.execPath, [wasmConsumerScript], consumerDirectory, {
		env: consumerEnvironment
	});
	if (wasmStatus !== "wasm-offline-ok") {
		throw new Error(`WASM offline consumer returned ${JSON.stringify(wasmStatus)}.`);
	}
	const lockfile = await readFile(join(consumerDirectory, "pnpm-lock.yaml"), "utf8");
	for (const entry of packed) {
		if (!lockfile.includes(entry.filename)) {
			throw new Error(`Consumer lockfile does not resolve ${entry.name} from its tarball.`);
		}
	}
	console.log(
		`Public package conformance passed: ${packed.length} tarballs, clean offline consumer, ${version}.`
	);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
