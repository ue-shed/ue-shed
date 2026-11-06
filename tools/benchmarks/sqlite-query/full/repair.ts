/** Project query facts from visible saved units and complete gathered evidence. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { openDatabase, type Database } from "./database.ts";
import { ndjson, featureWriter } from "./store.ts";

import { sqlText, hostText } from "../sqlite.ts";
import { localizationManifestNotes } from "../../../../packages/game-text/src/localization.ts";
import {
	manifestPathOrigin,
	textFileLabel,
	normalizeTextPath
} from "../../../../packages/game-text/src/text-origin.ts";
import { TextOriginKind, TextEditing } from "../../../../packages/game-text/src/schema.ts";
import type { TextFacts } from "../../../../packages/game-text/src/text-problems.ts";
import { verify } from "./seal.ts";

export async function refreshQueryFacts(db: Database, root: string): Promise<void> {
	const addFeatures = featureWriter(db);
	const find = db.prepare("SELECT id FROM row_data WHERE kind='line' AND key=?");
	const owners = db.prepare(
		"SELECT r.id,r.visible FROM row_unit u JOIN row_data r ON r.id=u.unit WHERE u.line=?"
	);
	const cleanFeature = db.prepare("DELETE FROM feature WHERE owner=?");
	const cleanGroup = db.prepare("DELETE FROM row_group WHERE owner=?");
	const cleanFolder = db.prepare("DELETE FROM row_folder WHERE owner=?");
	const manifestNotes = db.prepare(
		"INSERT INTO feature VALUES (?,'manifestNotes','present','present')"
	);
	const notes = db.prepare("INSERT INTO feature VALUES (?,'notes',?,?)");
	db.exec("BEGIN IMMEDIATE");
	let count = 0;
	try {
		for await (const value of ndjson(resolve(root, "lines.ndjson"))) {
			// SAFETY: sealed same-contract bundle; the constructor verified the contract and file hashes.
			// Verified by: conformance.checks.ts and all-record round trips.
			const { line, view } = value as import("./model.ts").LineRecord;
			const id = Number(find.all(sqlText(line.id))[0]!.id);
			const all = owners.all(id),
				visible = all.filter((owner) => owner.visible).map((owner) => Number(owner.id));
			const features = visible.length
				? db.prepare(`SELECT * FROM feature WHERE owner IN (${visible.join(",")})`).all()
				: [];
			const values = (field: string) => [
				...new Set(
					features
						.filter((row) => row.field === field)
						.map((row) => hostText(String(row.value)))
				)
			];
			const labels = (field: string) =>
				[
					...new Set(
						features
							.filter((row) => row.field === field)
							.map((row) => hostText(String(row.label)))
					)
				].sort();
			const fallback = all.length === 0;
			const hasManifestNotes = line.manifest.some(
				(entry) => localizationManifestNotes(entry).length > 0
			);
			const hasUnitNotes =
				visible.length > 0 &&
				db
					.prepare(
						`SELECT 1 AS found FROM saved_place WHERE owner IN (${visible.join(",")}) AND notes=1 LIMIT 1`
					)
					.all().length > 0;
			const facts: TextFacts = {
				problems: view.problems,
				findings: [],
				translation: [],
				origins: fallback
					? [...new Set(line.manifest.map((entry) => manifestPathOrigin(entry.path)))]
					: values("origins").map((value) =>
							Schema.decodeUnknownSync(TextOriginKind)(value)
						),
				editing: fallback
					? ["read_only"]
					: values("editing").map((value) =>
							Schema.decodeUnknownSync(TextEditing)(value)
						),
				paths: fallback
					? line.manifest.map((entry) => normalizeTextPath(entry.path))
					: values("paths"),
				files: fallback
					? [...new Set(line.manifest.map((entry) => textFileLabel(entry.path)))].sort()
					: labels("files"),
				namespace: line.identity?.namespace,
				notes: hasManifestNotes || hasUnitNotes ? "present" : "missing",
				audience: line.audience ?? "unknown",
				sources: [line.source],
				reviewSignals: view.signals,
				translationKeys: line.identity
					? [JSON.stringify([line.identity.namespace, line.identity.key])]
					: [],
				assetTypes: values("assetTypes")
			};
			cleanFeature.run(id);
			cleanGroup.run(id);
			cleanFolder.run(id);
			addFeatures(id, facts);
			notes.run(id, facts.notes, facts.notes);
			if (hasManifestNotes) manifestNotes.run(id);
			if (++count % 25000 === 0) console.log(JSON.stringify({ phase: "query-facts", count }));
		}

		db.exec("COMMIT; ANALYZE; PRAGMA wal_checkpoint(TRUNCATE)");
	} catch (cause) {
		db.exec("ROLLBACK");
		throw cause;
	}
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/full/repair.ts")) {
	const root = resolve(process.argv[2]!);
	await readFile(resolve(root, "retention.json"));
	await verify(root);
	const db = await openDatabase(resolve(root, "complete.sqlite"), true);
	try {
		await refreshQueryFacts(db, root);
	} finally {
		db.close();
	}
}
