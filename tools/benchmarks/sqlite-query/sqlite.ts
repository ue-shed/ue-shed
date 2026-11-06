/** One SQL workload for Node, Bun, and the experimental Rust pipe adapter. */
import type { GameTextContract } from "../../../packages/protocol/dist/index.js";
import { Schema } from "effect";
import type { SqlRequest, Parameter } from "./contract.generated.ts";

export const Fact = Schema.Struct({
	id: Schema.String,
	identity: Schema.NullOr(Schema.Struct({ namespace: Schema.String, key: Schema.String })),
	source: Schema.String,
	audience: Schema.optionalKey(Schema.String),
	marks: Schema.Array(
		Schema.Struct({
			culture: Schema.String,
			state: Schema.String,
			translation: Schema.NullOr(Schema.String)
		})
	),
	places: Schema.Array(
		Schema.Struct({
			packageFile: Schema.String,
			objectPath: Schema.String,
			origin: Schema.String
		})
	)
});
export type Fact = typeof Fact.Type;
export const parseFacts = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Fact)));
export type SqlRow = { readonly [column: string]: GameTextContract.JsonValue };
export type { Parameter } from "./contract.generated.ts";
export interface Statement {
	all(...parameters: (Parameter | Uint8Array)[]): SqlRow[];
	run(...parameters: (Parameter | Uint8Array)[]): void;
}
export interface Database {
	exec(sql: string): void;
	prepare(sql: string): Statement;
	close(): void;
}
export interface Case extends SqlRequest {
	readonly name: string;
	readonly native?: Omit<
		GameTextContract.EngineRequest & { action: "localization_export" },
		"reader"
	>;
}

export const schema = `
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=FULL;
PRAGMA cache_size=-65536;
PRAGMA foreign_keys=ON;
CREATE TABLE string(id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE, folded TEXT NOT NULL, utf16 BLOB NOT NULL);
CREATE TABLE line(rank INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, namespace INTEGER REFERENCES string, key INTEGER REFERENCES string, source INTEGER NOT NULL REFERENCES string, audience TEXT NOT NULL);
CREATE TABLE culture(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE line_culture(line INTEGER NOT NULL REFERENCES line ON DELETE CASCADE, culture INTEGER NOT NULL REFERENCES culture, state TEXT NOT NULL, translation INTEGER REFERENCES string, PRIMARY KEY(line,culture)) WITHOUT ROWID;
CREATE TABLE place(line INTEGER NOT NULL REFERENCES line ON DELETE CASCADE, position INTEGER NOT NULL, package INTEGER NOT NULL REFERENCES string, object INTEGER NOT NULL REFERENCES string, origin TEXT NOT NULL, PRIMARY KEY(line,position)) WITHOUT ROWID;
CREATE INDEX line_source ON line(source,rank);
CREATE INDEX line_namespace ON line(namespace,rank);
CREATE INDEX line_audience ON line(audience,rank);
CREATE INDEX culture_state ON line_culture(culture,state,line);
CREATE INDEX place_package ON place(package,line);
CREATE VIRTUAL TABLE text_fts USING fts5(folded, content=string, content_rowid=id, tokenize='trigram case_sensitive 1', detail=none);
CREATE VIEW text_lines AS SELECT l.rank,l.id,n.value AS namespace,k.value AS key,s.value AS source,l.audience FROM line l LEFT JOIN string n ON n.id=l.namespace LEFT JOIN string k ON k.id=l.key JOIN string s ON s.id=l.source;
`;

export function populate(db: Database, facts: readonly Fact[]) {
	db.exec(schema);
	const insertString = db.prepare(
		"INSERT INTO string(value,folded,utf16) VALUES (?,?,?) RETURNING id"
	);
	const ids = new Map<string, number>();
	const intern = (value: string) => {
		const previous = ids.get(value);
		if (previous !== undefined) return previous;
		const raw = Buffer.from(value, "utf16le");
		const row = insertString.all(sqlText(value), sqlText(value.toLowerCase()), raw.swap16())[0];
		if (!row) throw new Error("String insertion returned no ID.");
		const id = Number(row.id);
		if (!Number.isSafeInteger(id)) throw new Error("Invalid inserted string ID.");
		ids.set(value, id);
		return id;
	};
	const line = db.prepare("INSERT INTO line VALUES (?,?,?,?,?,?)");
	const culture = db.prepare("INSERT INTO culture(name) VALUES (?) RETURNING id");
	const mark = db.prepare("INSERT INTO line_culture VALUES (?,?,?,?)");
	const place = db.prepare("INSERT INTO place VALUES (?,?,?,?,?)");
	const cultures = new Map<string, number>();
	db.exec("BEGIN IMMEDIATE");
	try {
		for (const [rank, fact] of facts.entries()) {
			line.run(
				rank,
				fact.id,
				fact.identity ? intern(fact.identity.namespace) : null,
				fact.identity ? intern(fact.identity.key) : null,
				intern(fact.source),
				fact.audience ?? "unknown"
			);
			for (const value of fact.marks) {
				let ci = cultures.get(value.culture);
				if (ci === undefined) {
					ci = Number(culture.all(value.culture)[0]!.id);
					cultures.set(value.culture, ci);
				}
				mark.run(
					rank,
					ci,
					value.state,
					value.translation === null ? null : intern(value.translation)
				);
			}
			for (const [position, value] of fact.places.entries())
				place.run(
					rank,
					position,
					intern(value.packageFile),
					intern(value.objectPath),
					value.origin
				);
		}
		db.exec(`INSERT INTO text_fts(text_fts) VALUES ('rebuild');
CREATE TRIGGER string_insert AFTER INSERT ON string BEGIN INSERT INTO text_fts(rowid,folded) VALUES(new.id,new.folded); END;
CREATE TRIGGER string_delete AFTER DELETE ON string BEGIN INSERT INTO text_fts(text_fts,rowid,folded) VALUES('delete',old.id,old.folded); END;
CREATE TRIGGER string_update AFTER UPDATE ON string BEGIN INSERT INTO text_fts(text_fts,rowid,folded) VALUES('delete',old.id,old.folded); INSERT INTO text_fts(rowid,folded) VALUES(new.id,new.folded); END;
ANALYZE; COMMIT`);
	} catch (cause) {
		db.exec("ROLLBACK");
		throw cause;
	}
	return { strings: ids.size, cultures: cultures.size };
}

/** Values are projected to the same output the native line export returns. */
export function lines(rows: readonly SqlRow[]) {
	return rows.map(({ id, namespace, key, source }) => ({
		id,
		identity:
			namespace === null
				? null
				: { namespace: hostText(String(namespace)), key: hostText(String(key)) },
		source: hostText(String(source))
	}));
}

/** SQLite TEXT uses scalar UTF-8; the view matches the native engine's reversible string view. */
export function sqlText(text: string): string {
	if (!/[\ud800-\udfff\u{f0000}-\u{f0800}]/u.test(text)) return text;
	let view = "";
	for (const character of text) {
		const point = character.codePointAt(0)!;
		if (point >= 0xd800 && point <= 0xdfff)
			view += String.fromCodePoint(0xf0001 + point - 0xd800);
		else view += (point >= 0xf0000 && point <= 0xf0800 ? "\u{f0000}" : "") + character;
	}
	return view;
}

/** Decode only declared text columns, keeping numbers and nulls as SQL returned them. */
export function textRows(rows: readonly SqlRow[]): SqlRow[] {
	return rows.map((row) =>
		Object.fromEntries(
			Object.entries(row).map(([key, value]) => [
				key,
				value !== null && ["key", "namespace", "source", "culture", "state"].includes(key)
					? hostText(String(value))
					: value
			])
		)
	);
}

export function hostText(view: string): string {
	if (!/[\u{f0000}-\u{f0800}]/u.test(view)) return view;
	let text = "";
	const characters = view[Symbol.iterator]();
	for (let step = characters.next(); !step.done; step = characters.next()) {
		const point = step.value.codePointAt(0)!;
		if (point === 0xf0000) {
			const literal = characters.next();
			if (literal.done) throw new Error("Truncated reversible SQLite text.");
			text += literal.value;
		} else
			text +=
				point >= 0xf0001 && point <= 0xf0800
					? String.fromCharCode(point - 0xf0001 + 0xd800)
					: step.value;
	}
	return text;
}

export function cases(facts: readonly Fact[]): Case[] {
	const select =
		"SELECT l.id,n.value AS namespace,k.value AS key,s.value AS source FROM line l LEFT JOIN string n ON n.id=l.namespace LEFT JOIN string k ON k.id=l.key JOIN string s ON s.id=l.source";
	const exported = (
		name: string,
		predicate: string,
		parameters: Parameter[],
		selection: GameTextContract.QuerySelection = {}
	): Case => ({
		name,
		sql: `${select} WHERE ${predicate} ORDER BY l.rank`,
		parameters,
		output: "lines",
		native: {
			action: "localization_export",
			request: {
				selection: { target: "Generated", ...selection },
				fields: ["identity", "source"]
			}
		}
	});
	const list: Case[] = [
		exported("all-lines", "1", []),
		{ name: "boundary:scalar", sql: "SELECT 1 AS n", parameters: [], output: "rows" }
	];
	for (const query of ["t", "ta", "tal", "taluma", "zzzx_no_match_059", "中文", "é", "🙂"]) {
		list.push(
			exported(`search:${query}`, "instr(s.folded,?)>0", [query.toLowerCase()], {
				text: { query }
			})
		);
		list.push({
			name: `search-page:${query}`,
			sql: `${select} WHERE instr(s.folded,?)>0 ORDER BY l.rank LIMIT 50`,
			parameters: [query.toLowerCase()],
			output: "lines"
		});
	}
	// FTS supplies candidates only; instr verifies exact substring semantics after normalization.
	for (const query of ["tal", "taluma", "zzzx_no_match_059"])
		list.push(
			exported(
				`fts:${query}`,
				"s.id IN (SELECT rowid FROM text_fts WHERE folded GLOB ?) AND instr(s.folded,?)>0",
				[`*${query}*`, query],
				{ text: { query } }
			)
		);
	const namespace = facts.find((fact) => fact.identity?.namespace)?.identity?.namespace ?? "";
	list.push(
		exported("namespace", "n.value=?", [sqlText(namespace)], {
			where: { eq: [{ field: "namespace" }, { lit: namespace }] }
		})
	);
	list.push(
		exported("audience", "l.audience=?", ["unknown"], {
			where: { eq: [{ field: "audience" }, { lit: "unknown" }] }
		})
	);
	list.push(
		exported(
			"culture-state",
			"EXISTS (SELECT 1 FROM line_culture c JOIN culture t ON t.id=c.culture WHERE c.line=l.rank AND t.name=? AND c.state=?)",
			["de", "not_translated"],
			{
				cultures: ["de"],
				where: { anyCulture: { eq: [{ field: "state" }, { lit: "not_translated" }] } }
			}
		)
	);
	for (const limit of [1, 50, 5000])
		list.push({
			name: `page:${limit}`,
			sql: `${select} ORDER BY l.rank LIMIT ?`,
			parameters: [limit],
			output: "lines"
		});
	list.push({
		name: "namespace-counts",
		sql: "SELECT coalesce(n.value,'') AS key,count(*) AS n FROM line l LEFT JOIN string n ON n.id=l.namespace GROUP BY coalesce(n.value,'') ORDER BY n.utf16",
		parameters: [],
		output: "rows"
	});
	list.push({
		name: "culture-state-counts",
		sql: "SELECT t.name AS culture,c.state AS state,count(*) AS n FROM line_culture c JOIN culture t ON t.id=c.culture GROUP BY c.culture,c.state ORDER BY culture,state",
		parameters: [],
		output: "rows"
	});
	list.push({
		name: "rule:duplicate-source",
		sql: "SELECT s.value AS source,count(*) AS n FROM line l JOIN string s ON s.id=l.source GROUP BY l.source HAVING count(*)>1 ORDER BY s.utf16",
		parameters: [],
		output: "rows"
	});
	list.push({
		name: "rule:source-length",
		sql: "SELECT l.id FROM line l JOIN string s ON s.id=l.source WHERE length(s.utf16)/2>140 ORDER BY l.rank",
		parameters: [],
		output: "rows"
	});
	list.push({
		name: "rule:empty-translation",
		sql: "SELECT l.id,t.name AS culture FROM line l JOIN line_culture c ON c.line=l.rank JOIN culture t ON t.id=c.culture JOIN string s ON s.id=c.translation WHERE c.state='not_translated' AND length(s.utf16)=0 ORDER BY l.rank,t.name",
		parameters: [],
		output: "rows"
	});
	list.push({
		name: "report:length-distribution",
		sql: "SELECT length(s.utf16)/2 AS utf16Length,count(*) AS n FROM line l JOIN string s ON s.id=l.source GROUP BY length(s.utf16)/2 ORDER BY utf16Length",
		parameters: [],
		output: "rows"
	});
	return list;
}
