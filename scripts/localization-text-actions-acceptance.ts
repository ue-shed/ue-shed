// Real-editor acceptance for the public localization migration, including explicit deletion.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Stream } from "effect";
import {
	makeStringTableKeyMigrations,
	StringTableKeyMigrationId,
	type StringTableKeyMigrationHostApi
} from "../packages/localization/dist/index.js";
import { RemoteControlClientLive } from "../packages/unreal-connection/dist/index.js";
import {
	assetReaderLayer,
	extractProjectTextPackages
} from "../packages/unreal-assets/dist/index.js";
import { verifyGameTextActions } from "../packages/game-text/src/text-actions.ts";

export async function acceptLocalizationMigration(options: {
	projectRoot: string;
	endpoint: string;
	executable: string;
	deleteOldEntry?: boolean;
}) {
	const { projectRoot, endpoint } = options;
	const deleting = options.deleteOldEntry === true;
	const oldKey = deleting ? "Welcome" : "Farewell";
	const newKey = deleting ? "WelcomeRenamed" : "FarewellRenamed";
	const source = deleting ? "Welcome aboard" : "Fair winds";
	const directory = join(projectRoot, "Saved/UEShed/StringTableMigrations");
	mkdirSync(directory, { recursive: true });
	const table = "/Game/Fixture/GameTextActions/Slice2/ST_IdentityTable.ST_IdentityTable";
	const tableFile = join(
		projectRoot,
		"Content/Fixture/GameTextActions/Slice2/ST_IdentityTable.uasset"
	);
	const referenceFile = join(
		projectRoot,
		"Content/Fixture/GameTextActions/Slice2/DA_IdentityReferences.uasset"
	);
	const id = StringTableKeyMigrationId.make(randomUUID());
	const artifact = (suffix = ".json") => join(directory, `${id}${suffix}`);
	const io = <A>(operation: () => A) =>
		Effect.try({
			try: operation,
			catch: (cause) => ({
				message: String(cause),
				recovery: "Inspect the disposable migration project and journal."
			})
		});
	const reader = assetReaderLayer({ executable: options.executable });
	const host: StringTableKeyMigrationHostApi = {
		current: () => Effect.succeed({ projectRoot, endpoint }),
		store: {
			create: (record) =>
				io(() =>
					writeFileSync(artifact(), JSON.stringify(record, null, 2), { flag: "wx" })
				),
			read: () => io(() => JSON.parse(readFileSync(artifact(), "utf8"))),
			write: (record) =>
				io(() => {
					writeFileSync(artifact(".pending"), JSON.stringify(record, null, 2));
					renameSync(artifact(".pending"), artifact());
				}),
			claim: () => io(() => writeFileSync(artifact(".started"), "claimed", { flag: "wx" }))
		},
		readConfig: (_root, file) =>
			io(() =>
				existsSync(join(projectRoot, file))
					? readFileSync(join(projectRoot, file), "utf8")
					: undefined
			),
		writeConfig: (_root, file, before, after) =>
			io(() => {
				const path = join(projectRoot, file);
				const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
				assert.equal(current, before, "Configuration changed since review");
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path + ".migration", after);
				renameSync(path + ".migration", path);
			}),
		verifySaved: (_root, request, result) =>
			Effect.gen(function* () {
				const records = yield* Stream.runCollect(
					extractProjectTextPackages({
						projectRoot,
						paths: [
							...new Set(
								request.actions.map((action) =>
									resolve(projectRoot, action.place.packageFile)
								)
							)
						]
					})
				);
				const verification = verifyGameTextActions(
					request,
					{
						...result,
						actions: result.actions.map((outcome) => ({
							...outcome,
							status: outcome.status === "unchanged" ? "applied" : outcome.status
						}))
					},
					records.filter((event) => event.event === "text_package_record")
				);
				return (
					verification.complete &&
					verification.mismatches.length === 0 &&
					verification.verified === request.actions.length
				);
			}).pipe(
				Effect.provide(reader),
				Effect.mapError((cause) => ({
					message: String(cause),
					recovery: "Inspect saved package evidence."
				}))
			)
	};
	const record = await Effect.runPromise(
		Effect.gen(function* () {
			const migrations = yield* makeStringTableKeyMigrations(host);
			const prepared = yield* migrations.prepare({
				id,
				projectRoot,
				packageFile: tableFile,
				objectPath: table,
				tableId: table,
				namespace: "IdentityTable",
				oldKey,
				newKey,
				source,
				...(deleting ? { deleteOldEntry: true } : undefined),
				references: deleting
					? [
							{
								id: "fixture-reference",
								place: {
									packageFile: referenceFile,
									objectPath:
										"/Game/Fixture/GameTextActions/Slice2/DA_IdentityReferences.DA_IdentityReferences",
									propertyPath: "StringTableReference"
								}
							}
						]
					: []
			});
			assert.equal(
				prepared.preview.actions.some((action) => action.id === id + ":remove"),
				deleting
			);
			assert.equal(prepared.plan.remove.edit.kind, "remove_string_table_entry");
			return yield* migrations.execute({ id });
		}).pipe(Effect.provide(RemoteControlClientLive))
	);
	assert.equal(record.state.status, "complete");
	assert.equal(
		record.outcomes.find((item) => item.step === "delete_old_entry")?.verified,
		deleting ? true : undefined
	);
	assert.ok(record.outcomes.every((item) => item.verified));
	const saved = await Effect.runPromise(
		Stream.runCollect(extractProjectTextPackages({ projectRoot, paths: [tableFile] })).pipe(
			Effect.provide(reader)
		)
	);
	const entries = saved
		.filter((event) => event.event === "text_package_record")
		.flatMap((event) => event.occurrences)
		.filter((occurrence) => occurrence.location.kind === "string_table_entry");
	assert.equal(
		entries.some(
			(entry) =>
				entry.location.kind === "string_table_entry" && entry.location.entry_key === oldKey
		),
		!deleting
	);
	assert.ok(
		entries.some(
			(entry) =>
				entry.location.kind === "string_table_entry" && entry.location.entry_key === newKey
		)
	);
	writeFileSync(
		join(directory, deleting ? "acceptance.json" : "acceptance-retained.json"),
		JSON.stringify(
			{
				id,
				status: record.state.status,
				table,
				oldKey,
				newKey,
				explicitDeletion: deleting,
				journal: artifact()
			},
			null,
			2
		)
	);
	return {
		table,
		oldKey,
		newKey,
		source,
		configFile: "Config/DefaultEngine.ini"
	};
}
