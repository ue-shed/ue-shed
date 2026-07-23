import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { installPluginBundle, verifyPluginManifest } from "./plugin-installer.js";

const roots: string[] = [];
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function makeFixture(): Promise<{
	readonly archivePath: string;
	readonly manifestPath: string;
	readonly projectPath: string;
	readonly root: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-plugin-installer-"));
	roots.push(root);
	const source = join(root, "source", "UEShed", "Plugins", "UEShedCore");
	await mkdir(source, { recursive: true });
	await writeFile(join(source, "UEShedCore.uplugin"), '{"FileVersion":3}\n', "utf8");
	await writeFile(join(source, "Source.txt"), "portable plugin source\n", "utf8");
	const archivePath = join(root, "plugins.tar.gz");
	const tar = spawnSync("tar", ["-czf", "plugins.tar.gz", "-C", "source", "UEShed"], {
		cwd: root,
		encoding: "utf8",
		shell: false,
		windowsHide: true
	});
	if (tar.status !== 0) throw new Error(tar.stderr);
	const archive = await readFile(archivePath);
	const manifestPath = join(root, "plugins.manifest.json");
	await writeFile(
		manifestPath,
		JSON.stringify({
			artifact: {
				bytes: archive.byteLength,
				id: "ue-shed-plugin-source",
				kind: "plugin-source",
				path: "plugins.tar.gz",
				sha256: `sha256:${digest(archive)}`
			},
			plugins: [
				{
					dependencies: [],
					descriptorPath: "UEShedCore/UEShedCore.uplugin",
					directory: "UEShedCore",
					id: "UEShedCore",
					version: "0.1.0"
				}
			],
			provenance: {
				candidateManifest: {
					manifestPath: "candidate-manifest.json",
					sha256: `sha256:${"c".repeat(64)}`,
					version: "0.1.0-rc.1"
				},
				source: {
					commit: "a".repeat(40),
					ref: "refs/tags/v0.1.0-rc.1",
					repository: "https://github.com/ue-shed/ue-shed"
				}
			},
			releaseVersion: "0.1.0-rc.1",
			schemaVersion: 1,
			unreal: { maximum: "5.7", minimum: "5.7" }
		}) + "\n",
		"utf8"
	);
	const projectPath = join(root, "Fixture.uproject");
	await writeFile(
		projectPath,
		JSON.stringify(
			{
				EngineAssociation: "5.7",
				Plugins: [
					{ Enabled: false, Name: "UnrelatedPlugin" },
					{ Enabled: false, Name: "UEShedCore" }
				]
			},
			null,
			"	"
		) + "\n",
		"utf8"
	);
	return { archivePath, manifestPath, projectPath, root };
}

afterEach(async () => {
	while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("plugin installer", () => {
	it("verifies and installs a bundle idempotently while preserving unrelated project plugins", async () => {
		const fixture = await makeFixture();
		const verified = await Effect.runPromise(
			verifyPluginManifest({ manifestPath: fixture.manifestPath })
		);
		expect(verified.artifact.status).toBe("verified");
		expect(verified.manifest.plugins).toEqual(["UEShedCore"]);

		const first = await Effect.runPromise(
			installPluginBundle({
				manifestPath: fixture.manifestPath,
				projectPath: fixture.projectPath
			})
		);
		expect(first.status).toBe("installed");
		expect(
			await readFile(
				join(fixture.root, "Plugins", "UEShed", "UEShedCore", "Source.txt"),
				"utf8"
			)
		).toContain("portable plugin source");
		const project = JSON.parse(await readFile(fixture.projectPath, "utf8")) as {
			Plugins: Array<{ Enabled: boolean; Name: string }>;
		};
		expect(project.Plugins).toEqual([
			{ Enabled: false, Name: "UnrelatedPlugin" },
			{ Enabled: true, Name: "UEShedCore" }
		]);

		const second = await Effect.runPromise(
			installPluginBundle({
				manifestPath: fixture.manifestPath,
				projectPath: fixture.projectPath
			})
		);
		expect(second.status).toBe("unchanged");
	});

	it("refuses a modified installer-owned file before replacing the project", async () => {
		const fixture = await makeFixture();
		await Effect.runPromise(
			installPluginBundle({
				manifestPath: fixture.manifestPath,
				projectPath: fixture.projectPath
			})
		);
		const ownedFile = join(fixture.root, "Plugins", "UEShed", "UEShedCore", "Source.txt");
		await writeFile(ownedFile, "edited by project owner\n", "utf8");
		const exit = await Effect.runPromiseExit(
			installPluginBundle({
				manifestPath: fixture.manifestPath,
				projectPath: fixture.projectPath
			})
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("modified");
		expect(await readFile(ownedFile, "utf8")).toBe("edited by project owner\n");
	});

	it("rejects an artifact whose checksum does not match the manifest", async () => {
		const fixture = await makeFixture();
		await writeFile(
			fixture.manifestPath,
			(await readFile(fixture.manifestPath, "utf8")).replace(/[a-f0-9]{64}/u, "b".repeat(64)),
			"utf8"
		);
		const exit = await Effect.runPromiseExit(
			verifyPluginManifest({ manifestPath: fixture.manifestPath })
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("checksum mismatch");
	});
});
