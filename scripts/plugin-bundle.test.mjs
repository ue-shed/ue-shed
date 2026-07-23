import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildPluginBundle } from "./plugin-bundle.mjs";

async function writeFixtureFile(root, relativePath, contents) {
	const path = join(root, relativePath);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, contents, "utf8");
}

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-plugin-fixture-"));
	const pluginRoot = join(root, "Plugins");
	await writeFixtureFile(root, "LICENSE", "MIT License\n");
	await writeFixtureFile(
		pluginRoot,
		"UEShedAlpha/UEShedAlpha.uplugin",
		JSON.stringify({
			FileVersion: 3,
			Version: 1,
			VersionName: "0.1.0",
			Name: "UEShedAlpha",
			Plugins: []
		})
	);
	await writeFixtureFile(pluginRoot, "UEShedAlpha/README.md", "Alpha\n");
	await writeFixtureFile(pluginRoot, "UEShedAlpha/Source/Alpha.cpp", "source\n");
	await writeFixtureFile(pluginRoot, "UEShedAlpha/Intermediate/generated.cpp", "generated\n");
	await writeFixtureFile(pluginRoot, "UEShedAlpha/Binaries/Win64/Alpha.dll", "binary\n");
	await writeFixtureFile(pluginRoot, "UEShedAlpha/.vs/local.json", "local\n");
	await writeFixtureFile(pluginRoot, "UEShedAlpha/Project.sln", "local\n");
	await writeFixtureFile(
		pluginRoot,
		"UEShedBeta/UEShedBeta.uplugin",
		JSON.stringify({
			FileVersion: 3,
			Version: 2,
			VersionName: "0.2.0",
			Name: "UEShedBeta",
			Plugins: [{ Name: "UEShedAlpha", Enabled: true }]
		})
	);
	await writeFixtureFile(pluginRoot, "UEShedBeta/Source/Beta.cpp", "source\n");
	await writeFixtureFile(pluginRoot, "UEShedScenarios/README.md", "Roadmap only\n");
	return { root, pluginRoot };
}

function archiveEntries(path) {
	const result = spawnSync("tar", ["-tzf", basename(path)], {
		cwd: dirname(path),
		encoding: "utf8",
		shell: false,
		windowsHide: true
	});
	if (result.status !== 0) throw new Error(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	return result.stdout.split(/\r?\n/u).filter(Boolean);
}

test("builds deterministic source archive and excludes local Unreal output", async () => {
	const fixture = await createFixture();
	const candidatePath = join(fixture.root, "candidate-manifest.json");
	await writeFile(candidatePath, '{"candidateVersion":"0.1.0-rc.1"}\n', "utf8");
	const firstOutput = join(fixture.root, "first");
	const secondOutput = join(fixture.root, "second");
	try {
		const first = await buildPluginBundle({
			output: firstOutput,
			releaseVersion: "0.1.0-rc.1",
			pluginRoot: fixture.pluginRoot,
			licensePath: join(fixture.root, "LICENSE"),
			sourceRef: "refs/tags/v0.1.0-rc.1",
			candidateManifest: candidatePath,
			unreal: { minimum: "5.7", maximum: "5.7" }
		});
		const second = await buildPluginBundle({
			output: secondOutput,
			releaseVersion: "0.1.0-rc.1",
			pluginRoot: fixture.pluginRoot,
			licensePath: join(fixture.root, "LICENSE"),
			sourceRef: "refs/tags/v0.1.0-rc.1",
			candidateManifest: candidatePath,
			unreal: { minimum: "5.7", maximum: "5.7" }
		});
		const firstArchive = await readFile(first.archivePath);
		const secondArchive = await readFile(second.archivePath);
		assert.deepEqual(firstArchive, secondArchive);
		assert.equal(first.manifest.artifact.sha256, second.manifest.artifact.sha256);
		assert.equal(first.manifest.artifact.bytes, firstArchive.byteLength);
		assert.deepEqual(
			first.manifest.plugins.map(({ id, version, dependencies }) => ({
				id,
				version,
				dependencies
			})),
			[
				{ id: "UEShedAlpha", version: "0.1.0", dependencies: [] },
				{ id: "UEShedBeta", version: "0.2.0", dependencies: ["UEShedAlpha"] }
			]
		);
		assert.equal(first.manifest.provenance.candidateManifest.version, "0.1.0-rc.1");
		assert.equal(
			first.manifest.provenance.candidateManifest.manifestPath,
			"candidate-manifest.json"
		);
		const entries = archiveEntries(first.archivePath);
		assert.ok(entries.includes("UEShed/LICENSE"));
		assert.ok(entries.includes("UEShed/Plugins/UEShedAlpha/UEShedAlpha.uplugin"));
		assert.ok(entries.includes("UEShed/Plugins/UEShedAlpha/Source/Alpha.cpp"));
		assert.ok(
			!entries.some((entry) => /(?:Intermediate|Binaries|\.vs|\.sln)(?:\/|$)/iu.test(entry))
		);
		assert.ok(!entries.some((entry) => entry.includes("UEShedScenarios")));
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("rejects a descriptor dependency that is absent from the bundle", async () => {
	const fixture = await createFixture();
	const descriptorPath = join(fixture.pluginRoot, "UEShedBeta", "UEShedBeta.uplugin");
	await writeFile(
		descriptorPath,
		JSON.stringify({
			VersionName: "0.2.0",
			Name: "UEShedBeta",
			Plugins: [{ Name: "MissingPlugin", Enabled: true }]
		}),
		"utf8"
	);
	try {
		await assert.rejects(
			buildPluginBundle({
				output: join(fixture.root, "output"),
				releaseVersion: "0.1.0-rc.1",
				pluginRoot: fixture.pluginRoot,
				licensePath: join(fixture.root, "LICENSE")
			}),
			/missing plugin dependencies: MissingPlugin/
		);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});
