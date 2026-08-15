import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { CustodianReport } from "./schema.js";
import { Custodian, CustodianNodeLive } from "./service.js";

function withWorkspace<A>(
	use: (root: string) => Effect.Effect<A, unknown>
): Effect.Effect<A, unknown> {
	return Effect.acquireUseRelease(
		Effect.tryPromise(() => mkdtemp(join(tmpdir(), "ue-shed-custodian-"))),
		use,
		(root) =>
			Effect.tryPromise(() => rm(root, { recursive: true, force: true })).pipe(Effect.orDie)
	);
}

function makeProject(options: {
	readonly root: string;
	readonly name?: string;
	readonly cpp?: boolean;
	readonly ageDays?: number;
}) {
	return Effect.tryPromise(async () => {
		const name = options.name ?? "FixtureProject";
		const root = join(options.root, name);
		await mkdir(join(root, "Content"), { recursive: true });
		await mkdir(join(root, "Intermediate", "Build"), { recursive: true });
		await mkdir(join(root, "Binaries", "Win64"), { recursive: true });
		await mkdir(join(root, "Saved", "Autosaves"), { recursive: true });
		if (options.cpp) await mkdir(join(root, "Source", name), { recursive: true });
		await writeFile(
			join(root, `${name}.uproject`),
			JSON.stringify({ EngineAssociation: "5.7" })
		);
		const authored = join(root, "Content", "authored.txt");
		await writeFile(authored, "authored");
		await writeFile(join(root, "Intermediate", "Build", "cache.bin"), "12345678");
		await writeFile(join(root, "Binaries", "Win64", "game.dll"), "1234");
		await writeFile(join(root, "Saved", "Autosaves", "map.umap"), "123456");
		if (options.ageDays !== undefined) {
			const timestamp = new Date(Date.now() - options.ageDays * 86_400_000);
			await utimes(authored, timestamp, timestamp);
		}
		return root;
	});
}

function scan(root: string, ignorePressure = true) {
	return Effect.gen(function* () {
		const custodian = yield* Custodian;
		return yield* custodian.scan({ root, ignorePressure });
	}).pipe(Effect.provide(CustodianNodeLive));
}

it.effect("inventories only known regeneratable project targets", () =>
	withWorkspace((root) =>
		Effect.gen(function* () {
			yield* makeProject({ root, ageDays: 120 });
			const report = yield* scan(root);
			const project = report.projects[0];
			expect(project).toBeDefined();
			expect(project?.targets.map(({ relativePath }) => relativePath)).toEqual([
				"Intermediate",
				"Saved/Autosaves",
				"Binaries"
			]);
			expect(project?.targets.some(({ relativePath }) => relativePath === "Content")).toBe(
				false
			);
			expect(project?.eligibility.kind).toBe("candidate");
			expect(report.plan.items.map(({ name }) => name)).toEqual(["FixtureProject"]);
			expect(report.destructiveOperationsAvailable).toBe(false);
			yield* Schema.decodeUnknownEffect(CustodianReport)(report);
		})
	)
);

it.effect("keeps C++ binaries and recent autosaves out of the plan", () =>
	withWorkspace((root) =>
		Effect.gen(function* () {
			yield* makeProject({ root, cpp: true, ageDays: 30 });
			const report = yield* scan(root);
			const relativePaths = report.projects[0]?.targets.map(
				({ relativePath }) => relativePath
			);
			expect(relativePaths).toEqual(["Intermediate"]);
			expect(relativePaths).not.toContain("Binaries");
			expect(relativePaths).not.toContain("Saved/Autosaves");
		})
	)
);

it.effect("refuses a plugin target whose symlink escapes the project", () =>
	withWorkspace((root) =>
		Effect.gen(function* () {
			const project = yield* makeProject({ root, ageDays: 120 });
			const external = join(root, "ExternalPlugin");
			yield* Effect.tryPromise(async () => {
				await mkdir(join(external, "Intermediate"), { recursive: true });
				await writeFile(join(external, "Intermediate", "external.bin"), "1234");
				await mkdir(join(project, "Plugins"), { recursive: true });
				await symlink(external, join(project, "Plugins", "Linked"), "junction");
			});
			const report = yield* scan(project);
			const found = report.projects[0];
			expect(found?.targets.some(({ path }) => path.includes("ExternalPlugin"))).toBe(false);
			expect(found?.refusals).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "outside_root",
						relativePath: "Plugins/Linked/Intermediate"
					})
				])
			);
		})
	)
);

it.effect("fails a malformed policy closed instead of broadening cleanup authority", () =>
	withWorkspace((root) =>
		Effect.gen(function* () {
			const project = yield* makeProject({ root, ageDays: 120 });
			yield* Effect.tryPromise(() =>
				writeFile(join(project, ".ueclean.json"), JSON.stringify({ targets: ["Content"] }))
			);
			const report = yield* scan(root);
			expect(report.projects[0]?.eligibility.kind).toBe("invalid_policy");
			expect(report.projects[0]?.targets).toEqual([]);
			expect(report.projects[0]?.diagnostics[0]?.code).toBe("invalid_policy");
		})
	)
);

it.effect("protects binaries and intermediate output in an installed engine", () =>
	withWorkspace((root) =>
		Effect.gen(function* () {
			const engine = join(root, "UE_5.7");
			yield* Effect.tryPromise(async () => {
				await mkdir(join(engine, "Engine", "Build", "BatchFiles"), { recursive: true });
				await mkdir(join(engine, "Engine", "Binaries", "Win64"), { recursive: true });
				await mkdir(join(engine, "Engine", "Intermediate", "Build"), { recursive: true });
				await mkdir(join(engine, "Engine", "DerivedDataCache"), { recursive: true });
				await writeFile(
					join(engine, "Engine", "Build", "Build.version"),
					JSON.stringify({ MajorVersion: 5, MinorVersion: 7, PatchVersion: 0 })
				);
				await writeFile(join(engine, "Engine", "Build", "InstalledBuild.txt"), "");
				await writeFile(join(engine, "Engine", "DerivedDataCache", "cache.bin"), "1234");
			});
			const report = yield* scan(root);
			const engineReport = report.engines[0];
			expect(engineReport?.buildKind).toBe("installed");
			expect(engineReport?.targets.map(({ relativePath }) => relativePath)).toEqual([
				"Engine/DerivedDataCache"
			]);
			expect(engineReport?.refusals.map(({ relativePath }) => relativePath)).toEqual(
				expect.arrayContaining(["Engine/Intermediate", "Engine/Binaries"])
			);
		})
	)
);

it.effect("honors an explicit lower pressure threshold", () =>
	withWorkspace((root) =>
		Effect.gen(function* () {
			const project = yield* makeProject({ root, ageDays: 120 });
			yield* Effect.tryPromise(() =>
				writeFile(join(project, ".ueclean.json"), JSON.stringify({ min_free_gb: 50 }))
			);
			const report = yield* scan(root);
			expect(report.plan.thresholdBytes).toBe(50 * 1024 ** 3);
		})
	)
);

it.effect("allows unknown freshness when policy has no age gate", () =>
	withWorkspace((root) =>
		Effect.gen(function* () {
			const project = join(root, "GeneratedFixture");
			yield* Effect.tryPromise(async () => {
				await mkdir(join(project, "Intermediate"), { recursive: true });
				await writeFile(join(project, "GeneratedFixture.uproject"), "{}");
				await writeFile(join(project, "Intermediate", "cache.bin"), "1234");
				await writeFile(
					join(project, ".ueclean.json"),
					JSON.stringify({ min_age_days: 0, targets: ["intermediate"] })
				);
			});
			const report = yield* scan(root);
			expect(report.projects[0]?.freshness.ageDays).toBeUndefined();
			expect(report.projects[0]?.eligibility.kind).toBe("candidate");
		})
	)
);
