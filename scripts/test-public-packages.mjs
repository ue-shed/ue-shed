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
				dependencies: dependencyEntries,
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
	run(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			"const protocol = await import('@ue-shed/protocol'); " +
				"const assets = await import('@ue-shed/unreal-assets'); " +
				"if (protocol.CURRENT_PROTOCOL_VERSION.major !== 0) throw new Error('bad protocol'); " +
				"if (typeof assets.decodeSavedAssetInspection !== 'function') throw new Error('bad assets export');"
		],
		consumerDirectory,
		{ env: consumerEnvironment }
	);
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
