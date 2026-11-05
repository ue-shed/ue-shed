import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { assetReaderLayer } from "@ue-shed/unreal-assets";
import { DateTime, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { runOperation } from "p4client-ts";
import { layerNode, materializeDepotFiles, materializedFilePath } from "p4client-ts/node";
import { mapHistoryLayer, readPerforceMapHistory } from "./map-history.js";
import { perforceHistorySourceLayer } from "./perforce.js";
import { PerforceMapHistoryQuery, type PerforceMapRevision } from "./schema.js";

const runFile = promisify(execFile);

const SubmittedChange = Schema.Struct({
	change: Schema.Int.check(Schema.isGreaterThan(0)),
	submittedAtSeconds: Schema.Int.check(Schema.isGreaterThan(0))
});
const HarnessConfig = Schema.Struct({
	p4: Schema.Struct({
		client: Schema.NonEmptyString,
		configFileName: Schema.NonEmptyString,
		enviro: Schema.NonEmptyString,
		executable: Schema.NonEmptyString,
		port: Schema.NonEmptyString,
		tickets: Schema.NonEmptyString,
		trust: Schema.NonEmptyString,
		user: Schema.NonEmptyString
	}),
	projectRoot: Schema.NonEmptyString,
	seeded: Schema.Struct({
		conventional: Schema.Struct({
			baseline: SubmittedChange,
			mapPath: Schema.NonEmptyString,
			range: Schema.Struct({ since: Schema.NonEmptyString, until: Schema.NonEmptyString }),
			revisions: Schema.Array(SubmittedChange)
		}),
		relocatedConventional: Schema.Struct({
			baseline: SubmittedChange,
			mapPath: Schema.NonEmptyString,
			relocatedMapPath: Schema.NonEmptyString,
			range: Schema.Struct({ since: Schema.NonEmptyString, until: Schema.NonEmptyString }),
			revisions: Schema.Array(SubmittedChange)
		}),
		worldPartition: Schema.Struct({
			baseline: SubmittedChange,
			mapPath: Schema.NonEmptyString,
			range: Schema.Struct({ since: Schema.NonEmptyString, until: Schema.NonEmptyString }),
			revisions: Schema.Array(SubmittedChange)
		})
	}),
	uassetExecutable: Schema.NonEmptyString
});
type HarnessConfig = Schema.Schema.Type<typeof HarnessConfig>;
const decodeHarnessConfig = Schema.decodeUnknownSync(HarnessConfig);
const decodeQuery = Schema.decodeUnknownSync(PerforceMapHistoryQuery);

function readHarnessConfig(): HarnessConfig | undefined {
	const path = process.env.UE_SHED_PERFORCE_MAP_HISTORY_CONFIG;
	if (path === undefined) return undefined;
	return decodeHarnessConfig(JSON.parse(readFileSync(path, "utf8")));
}

const config = readHarnessConfig();

function p4Environment(value: HarnessConfig): NodeJS.ProcessEnv {
	return {
		...process.env,
		P4CHARSET: "none",
		P4CLIENT: value.p4.client,
		P4CONFIG: value.p4.configFileName,
		P4ENVIRO: value.p4.enviro,
		P4HOST: value.p4.client,
		P4PORT: value.p4.port,
		P4TICKETS: value.p4.tickets,
		P4TRUST: value.p4.trust,
		P4USER: value.p4.user
	};
}

function query(value: HarnessConfig, mapPath: string, range: { since: string; until: string }) {
	return decodeQuery({
		limits: {
			maxChangelists: 16,
			maxConcurrency: 2,
			maxDurationMs: 60_000,
			maxMaterializedFiles: 32,
			maxPackages: 32
		},
		mapPath,
		projectRoot: value.projectRoot,
		range
	});
}

function layer(value: HarnessConfig) {
	return Layer.provide(
		mapHistoryLayer,
		Layer.merge(
			assetReaderLayer({ executable: value.uassetExecutable }),
			perforceHistorySourceLayer({
				cwd: value.projectRoot,
				env: p4Environment(value),
				executable: value.p4.executable,
				timeoutMs: 15_000
			})
		)
	);
}

async function p4Have(value: HarnessConfig) {
	const result = await runFile(value.p4.executable, ["-Mj", "-z", "tag", "have"], {
		cwd: value.projectRoot,
		encoding: "utf8",
		env: p4Environment(value),
		windowsHide: true
	});
	return result.stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.sort((left, right) => String(left.depotFile).localeCompare(String(right.depotFile)));
}

function submittedAtSeconds(value: PerforceMapRevision): number {
	return DateTime.toEpochMillis(value.submittedAt) / 1_000;
}

function requireConfig(): HarnessConfig {
	if (config === undefined) {
		throw new Error("The real Perforce test must be started by test:perforce-map-history.");
	}
	return config;
}

describe.skipIf(config === undefined)("real Perforce Map History conformance", () => {
	it("rejects a deleted revision and preserves an existing output", async () => {
		const value = requireConfig();
		const directory = await mkdtemp(join(tmpdir(), "ue-shed-p4-materialize-"));
		const depotFile =
			"//ue-shed-map-history/Content/__ExternalActors__/Fixture/History/L_MapHistoryWorld/3/75/FQFCSRE35IMERPMI8K3KT5.uasset";
		const localPath = materializedFilePath(directory, depotFile);
		try {
			await mkdir(dirname(localPath), { recursive: true });
			await writeFile(localPath, "previous output");
			const error = await Effect.runPromise(
				runOperation(materializeDepotFiles, {
					directory,
					fileSpec: [{ depotFile, revision: 2, action: "delete" }],
					maxFiles: 1
				}).pipe(
					Effect.flip,
					Effect.provide(
						layerNode({
							cwd: value.projectRoot,
							env: p4Environment(value),
							executable: value.p4.executable,
							timeoutMs: 15_000
						})
					)
				)
			);
			expect(error).toMatchObject({
				_tag: "P4MaterializationError",
				reason: "missing_output"
			});
			expect(await readFile(localPath, "utf8")).toBe("previous output");
			expect(await readdir(dirname(localPath))).toEqual(["FQFCSRE35IMERPMI8K3KT5.uasset"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("reconstructs a conventional map revision through the isolated Perforce path", async () => {
		const value = requireConfig();
		const beforeHave = await p4Have(value);
		const history = await Effect.runPromise(
			readPerforceMapHistory(
				query(value, value.seeded.conventional.mapPath, value.seeded.conventional.range)
			).pipe(Effect.provide(layer(value)))
		);
		const afterHave = await p4Have(value);

		expect(history.baseline).toEqual({
			change: value.seeded.conventional.baseline.change,
			status: "available"
		});
		expect(history.revisions).toHaveLength(1);
		expect(history.revisions[0]?.change).toBe(value.seeded.conventional.revisions[0]?.change);
		expect(history.revisions[0]?.changes.map((change) => change.kind)).toEqual(["actor_moved"]);
		expect(history.externalActorDepotRoot).toBeUndefined();
		expect(history.rangeStartSnapshot?.actors).toEqual(
			expect.arrayContaining([expect.objectContaining({ label: "Conventional Marker" })])
		);
		expect(history.completeness).toBe("complete");
		expect(afterHave).toEqual(beforeHave);
	});

	it("follows a direct map move from a stale local source path", async () => {
		const value = requireConfig();
		const fixture = value.seeded.relocatedConventional;
		const beforeHave = await p4Have(value);
		const history = await Effect.runPromise(
			readPerforceMapHistory(query(value, fixture.mapPath, fixture.range)).pipe(
				Effect.provide(layer(value))
			)
		);
		const afterHave = await p4Have(value);

		expect(history.baseline).toEqual({
			change: fixture.baseline.change,
			status: "available"
		});
		expect(history.mapDepotPath).toBe(`//ue-shed-map-history/${fixture.relocatedMapPath}`);
		expect(history.revisions.map((revision) => revision.change)).toEqual(
			fixture.revisions.map((revision) => revision.change)
		);
		expect(history.revisions[0]?.files.map((file) => file.action)).toEqual([
			"move/delete",
			"move/add"
		]);
		expect(history.revisions[0]?.changes).toEqual([]);
		expect(history.revisions[0]?.unclassifiedPackageChanges).toHaveLength(2);
		expect(history.rangeStartSnapshot?.mapPath).toBe(fixture.mapPath);
		expect(history.rangeEndSnapshot?.mapPath).toBe(fixture.relocatedMapPath);
		expect(afterHave).toEqual(beforeHave);
	});

	it("attributes World Partition semantic evidence without changing have-state", async () => {
		const value = requireConfig();
		const beforeHave = await p4Have(value);
		const history = await Effect.runPromise(
			readPerforceMapHistory(
				query(value, value.seeded.worldPartition.mapPath, value.seeded.worldPartition.range)
			).pipe(Effect.provide(layer(value)))
		);
		const afterHave = await p4Have(value);
		const expectedRevisions = value.seeded.worldPartition.revisions;

		expect(history.baseline).toEqual({
			change: value.seeded.worldPartition.baseline.change,
			status: "available"
		});
		expect(history.mapDepotPath).toBe(
			"//ue-shed-map-history/Content/Fixture/History/L_MapHistoryWorld.umap"
		);
		expect(history.externalActorDepotRoot).toBe(
			"//ue-shed-map-history/Content/__ExternalActors__/Fixture/History/L_MapHistoryWorld"
		);
		expect(history.revisions.map((revision) => revision.change)).toEqual(
			expectedRevisions.map((revision) => revision.change)
		);
		expect(
			history.revisions.map((revision) => revision.changes.map((change) => change.kind))
		).toEqual([
			["actor_moved"],
			["actor_label_changed"],
			["actor_added"],
			["actor_removed"],
			["actor_transform_changed", "actor_transform_changed"]
		]);
		for (const [index, revision] of history.revisions.entries()) {
			const expected = expectedRevisions[index];
			if (expected === undefined || revision === undefined) {
				throw new Error("The real Perforce fixture returned an unexpected revision count.");
			}
			expect(revision?.description).toBe(
				`Map History fixture: ${
					[
						"move-east",
						"label-north",
						"add-arrival",
						"delete-south",
						"two-unclassified-package-edits"
					][index]
				}`
			);
			expect(revision?.user).toBe("ue-shed-map-history");
			expect(submittedAtSeconds(revision)).toBe(expected.submittedAtSeconds);
		}
		// The saved-world projection now resolves these fixture rotation/scale edits.
		// Both the original 0.12.1 adapter and 0.13 expose them as semantic changes.
		expect(history.revisions.at(-1)?.unclassifiedPackageChanges).toEqual([]);
		expect(history.completeness).toBe("complete");
		expect(history.rangeStartSnapshot?.actors).toHaveLength(6);
		expect(afterHave).toEqual(beforeHave);
	});
});
