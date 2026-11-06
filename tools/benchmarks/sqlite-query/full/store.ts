import { createReadStream } from "node:fs";
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Schema } from "effect";
import {
	textLocationOrigin,
	textLocationPath,
	textFileLabel,
	textFileKey,
	normalizeTextPath,
	manifestPathOrigin
} from "../../../../packages/game-text/src/text-origin.ts";
import { textProblems, type TextFacts } from "../../../../packages/game-text/src/text-problems.ts";
import { textGroupOf } from "../../../../packages/game-text/src/text-groups.ts";
import {
	TextGroupBy,
	TextOriginKind,
	TextEditing
} from "../../../../packages/game-text/src/schema.ts";
import { LocalizationLine } from "../../../../packages/game-text/src/localization-schema.ts";
import { TEXT_PROBLEMS } from "../../../../packages/game-text/src/text-problem-rules.ts";
import { sqlText } from "../sqlite.ts";
import { gatheredTextIdentity } from "../../../../packages/game-text/src/localization.ts";
import { localizationWordCount } from "../../../../packages/game-text/src/localization-words.ts";
import { openDatabase } from "./database.ts";
import { Records } from "./records.ts";
import { verify } from "./seal.ts";
import { json, type RetainedInput, type LineRecord, type UnitRecord } from "./model.ts";

export const q = (value: string): string =>
	`CAST(X'${Buffer.from(sqlText(value), "utf8").toString("hex")}' AS TEXT)`;
export const mask = (values: readonly string[], all: readonly string[]) =>
	values.reduce((n, value) => n | (1 << all.indexOf(value)), 0);
export const problemMask = (values: readonly string[]) =>
	mask(
		values.filter((v) => v !== "up_to_date"),
		TEXT_PROBLEMS
	);

export const schema = `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-131072; PRAGMA foreign_keys=ON;
CREATE TABLE metadata(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
CREATE TABLE row_data(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,rank INTEGER NOT NULL,key TEXT NOT NULL,namespace TEXT,audience TEXT NOT NULL,source TEXT NOT NULL,characters INTEGER NOT NULL,words INTEGER NOT NULL,raw INTEGER NOT NULL,preview INTEGER,view INTEGER,base_problems INTEGER NOT NULL,visible INTEGER NOT NULL,UNIQUE(kind,key));
CREATE INDEX row_order ON row_data(kind,visible,rank);
CREATE INDEX row_namespace ON row_data(kind,namespace,rank);
CREATE INDEX row_audience ON row_data(kind,audience,rank);
CREATE TABLE feature(owner INTEGER NOT NULL,field TEXT NOT NULL,value TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(owner,field,value)) WITHOUT ROWID;
CREATE INDEX feature_value ON feature(field,value,owner);
CREATE TABLE saved_place(owner INTEGER NOT NULL,position INTEGER NOT NULL,origin TEXT,editing TEXT,notes INTEGER NOT NULL,path TEXT,file TEXT,PRIMARY KEY(owner,position)) WITHOUT ROWID;
CREATE INDEX place_file ON saved_place(file,owner);
CREATE TABLE culture_mark(owner INTEGER NOT NULL,culture TEXT NOT NULL,state TEXT NOT NULL,facts INTEGER NOT NULL,problems INTEGER NOT NULL,reason_bits INTEGER NOT NULL,reduced INTEGER NOT NULL,review TEXT,review_bits INTEGER NOT NULL,translation TEXT,archive_text TEXT,po_text TEXT,PRIMARY KEY(owner,culture)) WITHOUT ROWID;
CREATE INDEX culture_state ON culture_mark(culture,state,owner);
CREATE TABLE row_group(owner INTEGER NOT NULL,dimension TEXT NOT NULL,key TEXT NOT NULL,label TEXT NOT NULL,ordinal BLOB NOT NULL,PRIMARY KEY(owner,dimension)) WITHOUT ROWID;
CREATE INDEX group_key ON row_group(dimension,key,owner);
CREATE TABLE row_unit(line INTEGER NOT NULL,unit INTEGER NOT NULL,PRIMARY KEY(line,unit)) WITHOUT ROWID;
CREATE INDEX unit_line ON row_unit(unit,line);
CREATE TABLE line_preview(owner INTEGER PRIMARY KEY,unit INTEGER);
CREATE TABLE row_measure(owner INTEGER PRIMARY KEY,line_break_words INTEGER,gathered INTEGER NOT NULL);
CREATE TABLE mark_value(owner INTEGER,culture TEXT,dimension TEXT,value TEXT,PRIMARY KEY(owner,culture,dimension,value)) WITHOUT ROWID;
CREATE TABLE row_folder(owner INTEGER,key TEXT,label TEXT,depth INTEGER,PRIMARY KEY(owner,key)) WITHOUT ROWID;
CREATE TABLE raw_line(rank INTEGER PRIMARY KEY,key TEXT UNIQUE,value INTEGER NOT NULL);
`;

export async function* ndjson(path: string): AsyncGenerator<unknown> {
	let pending = "";
	for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
		pending += chunk;
		let end: number;
		while ((end = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, end);
			pending = pending.slice(end + 1);
			if (line) yield JSON.parse(line);
		}
	}
	if (pending) yield JSON.parse(pending);
}

export async function build(inputPath: string): Promise<void> {
	const root = resolve(inputPath),
		path = resolve(root, "complete.sqlite");
	await verify(root);
	try {
		await stat(path);
		throw new Error("Refusing to overwrite a retained database");
	} catch (cause) {
		if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
	}
	const input: RetainedInput = JSON.parse(await readFile(resolve(root, "input.json"), "utf8"));
	const db = await openDatabase(path, true);
	const started = performance.now();
	try {
		db.exec(schema);
		const records = new Records(db, true);
		db.exec("BEGIN IMMEDIATE");
		try {
			const header = db.prepare("INSERT INTO metadata VALUES (?,?)");
			header.run("input", records.put(json(input)));
			const insertRow = db.prepare(
				"INSERT INTO row_data VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
			);
			const insertPlace = db.prepare("INSERT INTO saved_place VALUES (?,?,?,?,?,?,?)");
			const insertMeasure = db.prepare("INSERT INTO row_measure VALUES (?,?,?)");
			const insertMarkValue = db.prepare("INSERT INTO mark_value VALUES (?,?,?,?)");
			let nextId = 0,
				rank = 0;
			const addFeatures = featureWriter(db);
			for await (const value of ndjson(resolve(root, "units.ndjson"))) {
				// SAFETY: retained bundle is our engine's output, not an authored input; units get a boundary check.
				// Verified by: conformance reads every retained unit back from SQLite.
				const record = value as UnitRecord;
				const unit = record.unit,
					preview = record.preview;
				const id = ++nextId;
				const gathered = gatheredTextIdentity(unit);
				const signals = preview?.reviewSignals ?? [];
				const sources =
					unit.source.status === "consistent" ? [unit.source.value] : unit.source.values;
				const wordCount = localizationWordCount([...sources].sort()[0] ?? "");
				insertMeasure.run(id, wordCount.status === "counted" ? wordCount.words : null, 0);
				const places = unit.occurrences.map((place) => ({
					origin: textLocationOrigin(place.location),
					editing: TextEditing.make(
						place.editCapability === "source_editable" ? "editable" : "read_only"
					),
					notes: place.devNotes.length > 0,
					path: normalizeTextPath(textLocationPath(place.location)),
					file: textFileLabel(place.packageFile)
				}));
				const facts: TextFacts = {
					problems: preview?.problems ?? [],
					findings: [],
					translation: [],
					origins: [...new Set(places.map((place) => place.origin))],
					editing: [...new Set(places.map((place) => place.editing))],
					paths: [
						...new Set(
							unit.occurrences.flatMap((place) => [
								normalizeTextPath(textLocationPath(place.location)),
								normalizeTextPath(place.packageFile)
							])
						)
					],
					files: [...new Set(places.map((place) => place.file))].sort(),
					namespace:
						unit.identity.status === "resolved"
							? unit.identity.namespace
							: unit.identity.status === "string_table"
								? unit.identity.tableId
								: undefined,
					notes: places.some((place) => place.notes) ? "present" : "missing",
					audience: preview?.audience ?? "unknown",
					sources: [...sources].sort(),
					reviewSignals: signals,
					translationKeys: gathered
						? [JSON.stringify([gathered.namespace, gathered.key])]
						: []
				};
				insertRow.run(
					id,
					"unit",
					rank++,
					sqlText(unit.id),
					facts.namespace === undefined ? null : sqlText(facts.namespace),
					facts.audience,
					sqlText(sources.join("\n").toLowerCase()),
					preview?.characterCount ?? 0,
					preview?.wordCount ?? 0,
					records.put(json(unit)),
					preview ? records.put(json(preview)) : null,
					null,
					problemMask(textProblems({ signals, keyChanged: false })),
					Number(preview !== null)
				);
				places.forEach((place, index) =>
					insertPlace.run(
						id,
						index,
						place.origin,
						place.editing,
						Number(place.notes),
						sqlText(place.path),
						sqlText(textFileKey(place.file))
					)
				);
				addFeatures(id, facts);
				if (rank % 25000 === 0)
					console.log(
						JSON.stringify({
							phase: "store-units",
							count: rank,
							rss: process.memoryUsage().rss
						})
					);
			}
			console.log(JSON.stringify({ phase: "stored-units", count: rank }));
			rank = 0;
			const insertMark = db.prepare(
				"INSERT INTO culture_mark VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
			);
			const unitId = db.prepare("SELECT id FROM row_data WHERE kind='unit' AND key=?");
			const units = db.prepare("INSERT INTO row_unit VALUES (?,?)");
			const linePreview = db.prepare("INSERT INTO line_preview VALUES (?,?)");
			for await (const value of ndjson(resolve(root, "lines.ndjson"))) {
				// SAFETY: own handshake-checked bundle. Full lines receive the public persisted-data check.
				// Verified by: native complete-answer parity, including full evidence round trips.
				const record = value as LineRecord;
				const line = record.line,
					{ view, preview } = record;
				const id = ++nextId,
					signals = view.signals ?? [];
				const gatheredText =
					line.manifest.find((entry) => !entry.optional)?.source.Text ?? line.source;
				const wordCount = localizationWordCount(gatheredText);
				insertMeasure.run(
					id,
					wordCount.status === "counted" ? wordCount.words : null,
					Number(line.manifest.length > 0)
				);
				linePreview.run(
					id,
					record.unitPreview ? records.put(json(record.unitPreview)) : null
				);
				const owners =
					line.origin.kind === "corpus"
						? line.origin.unitIds.flatMap((key) =>
								unitId.all(sqlText(key)).map((row) => Number(row.id))
							)
						: [];
				owners.forEach((unit) => units.run(id, unit));
				let places = owners.length
					? db
							.prepare(
								`SELECT origin,editing,notes,path,file FROM saved_place WHERE owner IN (${owners.join(",")}) ORDER BY owner,position`
							)
							.all()
					: [];
				if (places.length === 0)
					places = line.manifest.map((entry) => ({
						origin: manifestPathOrigin(entry.path),
						editing: "read_only",
						notes: Number(Boolean(entry.devNotes)),
						path: sqlText(normalizeTextPath(entry.path)),
						file: sqlText(textFileKey(entry.path))
					}));
				const facts: TextFacts = {
					problems: view.problems ?? [],
					findings: [],
					translation: [],
					origins: [
						...new Set(
							places.map((place) =>
								Schema.decodeUnknownSync(TextOriginKind)(place.origin)
							)
						)
					],
					editing: [
						...new Set(
							places.map((place) =>
								Schema.decodeUnknownSync(TextEditing)(place.editing)
							)
						)
					],
					paths: places.map((place) => String(place.path)),
					files: [
						...new Set(
							view.places.length
								? view.places.map((place) => textFileLabel(place.packageFile))
								: line.manifest.map((entry) => textFileLabel(entry.path))
						)
					].sort(),
					namespace: line.identity?.namespace,
					notes: places.some((place) => place.notes) ? "present" : "missing",
					audience: line.audience ?? "unknown",
					sources: [line.source],
					reviewSignals: signals,
					translationKeys: line.identity
						? [JSON.stringify([line.identity.namespace, line.identity.key])]
						: []
				};

				insertRow.run(
					id,
					"line",
					rank++,
					sqlText(line.id),
					facts.namespace === undefined ? null : sqlText(facts.namespace),
					facts.audience,
					sqlText(line.source.toLowerCase()),
					line.source.length,
					line.source.trim().split(/\s+/u).filter(Boolean).length,
					records.put(json(line)),
					records.put(json(preview)),
					records.put(json(view)),
					problemMask(
						textProblems({ signals, keyChanged: line.keyChange?.direction === "to" })
					),
					1
				);
				places.forEach((place, index) =>
					insertPlace.run(
						id,
						index,
						String(place.origin),
						String(place.editing),
						Number(place.notes),
						String(place.path),
						String(place.file)
					)
				);
				for (const mark of line.cultures) {
					const review = mark.review;
					const flags = review?.status === "current" ? review.flags : [];
					const reviewable = ["translated", "needs_update", "not_synced"].includes(
						mark.state
					);
					const reviews = [
						...(flags.includes("reviewed")
							? ["reviewed"]
							: reviewable
								? ["not_reviewed"]
								: []),
						...(reviewable && !flags.includes("proofread") ? ["not_proofread"] : []),
						...(review?.status === "changed" ? ["changed_since_review"] : []),
						...(flags.includes("machine_translated") ? ["machine_translated"] : [])
					];

					for (const [dimension, values] of Object.entries({
						fact: mark.facts,
						unknown_reason: mark.unknownReasons,
						review: review ? reviews : [],
						review_flag: review?.status === "current" ? review.flags : []
					})) {
						for (const value of values)
							insertMarkValue.run(id, mark.culture, dimension, sqlText(value));
					}
					insertMark.run(
						id,
						mark.culture,
						mark.state,
						mask(mark.facts, states),
						problemMask(
							textProblems({ signals: [], keyChanged: false, marks: [mark] })
						),
						mask(mark.unknownReasons, reasons),
						Number(mark.reducedSourceChecking),
						review?.status ?? null,
						mask(reviews, reviewLenses),
						view.marks.find((m) => m.culture === mark.culture)?.translation ?? null,
						mark.archive?.translation.Text == null
							? null
							: sqlText(mark.archive.translation.Text.toLowerCase()),
						mark.poTranslation === null
							? null
							: sqlText(mark.poTranslation.toLowerCase())
					);
				}
				addFeatures(id, facts);
				if (rank % 25000 === 0)
					console.log(
						JSON.stringify({
							phase: "store-lines",
							count: rank,
							rss: process.memoryUsage().rss
						})
					);
			}
			console.log(JSON.stringify({ phase: "stored-lines", count: rank }));
			rank = 0;
			const raw = db.prepare("INSERT INTO raw_line VALUES (?,?,?)");
			const retainedLine = db.prepare("SELECT raw FROM row_data WHERE kind='line' AND key=?");
			for await (const value of ndjson(resolve(root, "raw-lines.ndjson"))) {
				// SAFETY: sealed, same-contract native output; complete round trips are checked separately.
				// Verified by: full/conformance.checks.ts and the all-record fingerprint campaign.
				const line = value as LocalizationLine;
				const existing = retainedLine.all(sqlText(line.id))[0];
				raw.run(
					rank++,
					sqlText(line.id),
					existing ? Number(existing.raw) : records.put(json(line))
				);
			}
			db.exec("COMMIT; ANALYZE; PRAGMA wal_checkpoint(TRUNCATE)");
		} catch (cause) {
			db.exec("ROLLBACK");
			throw cause;
		}
		await writeFile(
			resolve(root, "build.json"),
			JSON.stringify({
				wallMs: performance.now() - started,
				bytes: (await stat(path)).size,
				sqlite: db.prepare("SELECT sqlite_version() AS version").all(),
				rows: db.prepare("SELECT kind,count(*) AS count FROM row_data GROUP BY kind").all(),
				nodes: db
					.prepare("SELECT kind,count(*) AS count FROM value_node GROUP BY kind")
					.all()
			})
		);
	} finally {
		db.close();
	}
}
export const states = [
	"translated",
	"not_translated",
	"needs_update",
	"not_synced",
	"not_gathered",
	"changed_since_gather",
	"not_found",
	"gathered_only",
	"outside_target",
	"unknown"
];
export const reasons = [
	"missing_manifest",
	"missing_archive",
	"missing_po",
	"duplicate_manifest_identity",
	"duplicate_archive_identity",
	"duplicate_po_identity",
	"package_partial",
	"package_failed",
	"package_not_scanned",
	"unresolved_identity",
	"string_table_namespace_unavailable",
	"conflicting_source",
	"gather_settings_unavailable",
	"class_hierarchy_unavailable",
	"asset_class_unavailable",
	"path_not_project_relative",
	"ambiguous_po_identity",
	"string_table_entry_missing"
];
export const reviewLenses = [
	"reviewed",
	"not_reviewed",
	"not_proofread",
	"changed_since_review",
	"machine_translated"
];
if (
	import.meta.url === new URL(process.argv[1]!, "file:///").href ||
	process.argv[1]?.replaceAll("\\", "/").endsWith("/full/store.ts")
)
	await build(process.argv[2]!);

export function featureWriter(db: import("./database.ts").Database) {
	const insertFeature = db.prepare("INSERT OR IGNORE INTO feature VALUES (?,?,?,?)");
	const insertGroup = db.prepare("INSERT INTO row_group VALUES (?,?,?,?,?)");
	const insertFolder = db.prepare("INSERT OR IGNORE INTO row_folder VALUES (?,?,?,?)");
	return (id: number, facts: TextFacts) => {
		for (const file of facts.files) {
			const parts = file.split("/");
			for (let depth = 1; depth < parts.length; depth++) {
				const label = parts.slice(0, depth).join("/");
				insertFolder.run(id, sqlText(normalizeTextPath(label)), sqlText(label), depth);
			}
		}
		const fields = {
			origins: facts.origins,
			editing: facts.editing,
			files: facts.files.map(textFileKey),
			paths: facts.paths,
			sources: facts.sources ?? [],
			facts: facts.reviewSignals ?? [],
			translationKey: facts.translationKeys ?? [],
			assetTypes: facts.assetTypes ?? [],
			findings: facts.findings
		};
		for (const [field, values] of Object.entries(fields))
			for (const value of values)
				insertFeature.run(
					id,
					field,
					sqlText(value),
					sqlText(
						field === "files"
							? (facts.files.find((file) => textFileKey(file) === value) ?? value)
							: value
					)
				);
		for (const dimension of TextGroupBy.literals.filter(
			(by) => by !== "problem" && by !== "finding"
		)) {
			const { key, label } = textGroupOf(facts, dimension);
			insertGroup.run(
				id,
				dimension,
				sqlText(key),
				sqlText(label),
				Buffer.from(label, "utf16le").swap16()
			);
		}
	};
}
