import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packPublicPackages, PUBLIC_VERSION } from "./pack-public-packages.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function executable(name) {
	return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command, args, cwd, options = {}) {
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

const temporaryRoot = await mkdtemp(join(tmpdir(), "ue-shed-public-packages-"));
try {
	const packageDirectory = join(temporaryRoot, "packages");
	const consumerDirectory = join(temporaryRoot, "consumer");
	await mkdir(packageDirectory);
	await mkdir(consumerDirectory);
	const packed = await packPublicPackages({ output: packageDirectory });
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
				},
				pnpm: { overrides: dependencyEntries }
			},
			null,
			2
		)}\n`,
		"utf8"
	);
	run(executable("pnpm"), ["install", "--offline", "--ignore-scripts"], consumerDirectory);
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
	if (version !== `uasset ${PUBLIC_VERSION}`) {
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
	if (inspection.schema_version !== 7 || inspection.assets?.[0]?.kind !== "DataTable") {
		throw new Error("Packed CLI did not produce the stable DataTable inspection contract.");
	}
	const checksums = await readFile(join(packageDirectory, "SHA256SUMS"), "utf8");
	if (checksums.trim().split(/\r?\n/u).length !== packed.length) {
		throw new Error("Packed checksum manifest does not cover every public package.");
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
