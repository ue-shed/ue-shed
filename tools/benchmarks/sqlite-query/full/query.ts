import type {
	TextCorpusSearchRequest,
	TextGroupBy as GroupBy
} from "../../../../packages/game-text/src/schema.ts";
import {
	TEXT_PROBLEMS,
	TEXT_PROBLEM_LABELS
} from "../../../../packages/game-text/src/text-problem-rules.ts";
import {
	TEXT_ORIGIN_KINDS,
	TEXT_ORIGIN_LABELS,
	normalizeTextPath,
	textFileKey
} from "../../../../packages/game-text/src/text-origin.ts";
import { TEXT_AUDIENCE_LABELS } from "../../../../packages/game-text/src/text-audience-schema.ts";
import {
	localizationFocusPage,
	type LocalizationFocusRequest
} from "../../../../packages/game-text/src/localization-view.ts";
import { LocalizationLine } from "../../../../packages/game-text/src/localization-schema.ts";
import { CultureCode } from "../../../../packages/localization/dist/browser.js";
import type { TextAggregateRequest } from "../../../../packages/game-text/src/index-reads.ts";
import { TextCorpusHeader } from "../../../../packages/game-text/src/index-reads.ts";
import { sqlText, hostText } from "../sqlite.ts";
import { Records } from "./records.ts";
import { q, states, reasons, reviewLenses } from "./store.ts";
import { json, RetainedInputCodec, type Json, type RetainedInput } from "./model.ts";
import { Schema } from "effect";
import type { Database, Row } from "./database.ts";
import { createHash } from "node:crypto";
import { canonical } from "./canonical.ts";

type Request = TextCorpusSearchRequest;
type ObjectValue = { [key: string]: Json };
const obj = (value: Json | undefined): ObjectValue => {
	if (!(value instanceof Object) || Array.isArray(value))
		throw new Error("Expected a retained object");
	// SAFETY: narrowed JSON object; Array.isArray does not narrow readonly arrays in TypeScript.
	// Verified by: recursive record conformance, including arrays/null.
	return value as ObjectValue;
};
const list = (values: readonly string[]) => values.map(q).join(",") || "NULL";
const scoped = (request: Request, alias = "m") =>
	request.localization?.culture
		? `${alias}.culture=${q(request.localization.culture)}`
		: request.localization?.cultures
			? `${alias}.culture IN (${list(request.localization.cultures)})`
			: "1";
const feature = (field: string, predicate: string, alias = "r") =>
	`EXISTS(SELECT 1 FROM feature f WHERE f.owner=${alias}.id AND f.field=${q(field)} AND ${predicate})`;
const has = (field: string, values: readonly string[], alias = "r") => {
	const mapped =
		field === "origins"
			? { column: "q_origins", names: TEXT_ORIGIN_KINDS }
			: field === "editing"
				? { column: "q_editing", names: ["editable", "read_only"] }
				: field === "facts"
					? {
							column: "q_signals",
							names: [
								"unresolved",
								"conflicting",
								"evidence_only",
								"compiled_copy_differs"
							]
						}
					: undefined;
	if (mapped)
		return `(${alias}.${mapped.column} & ${values.reduce((bits, value) => {
			const i = mapped.names.findIndex((name) => name === value);
			return i < 0 ? bits : bits | (1 << i);
		}, 0)})<>0`;
	return feature(field, `f.value IN (${list(values)})`, alias);
};
const worst = (mask: string) =>
	`CASE ${TEXT_PROBLEMS.slice(0, -1)
		.map((_, bit) => `WHEN (${mask} & ${1 << bit})<>0 THEN ${bit}`)
		.join(" ")} ELSE 7 END`;
const settled = (mask: string) => `CASE WHEN (${mask})=0 THEN 128 ELSE (${mask}) END`;
const problems = (bits: number) => TEXT_PROBLEMS.filter((_, i) => bits & (1 << i));
interface RowsDocument {
	readonly units: readonly Json[];
	readonly nextCursor?: string;
	readonly localization?: {
		readonly target: string;
		readonly nextCursor?: string;
		readonly lines: readonly Json[];
	};
	readonly openGroups?: readonly {
		readonly key: string;
		readonly page?: RowsDocument;
		readonly rowsOmitted?: true;
	}[];
}

export class SqliteQuery {
	readonly db: Database;
	readonly records: Records;
	readonly input: RetainedInput;
	readonly #cultureProblems = new Map<string, string>();
	readonly #trigramPlans = new Map<string, boolean>();
	#sourceRows = 0;
	#corpusHeader: RetainedInput["corpus"] | undefined;
	constructor(db: Database) {
		this.db = db;
		this.records = new Records(db);
		// SAFETY: own fully retained engine input; schema checks happen while producing the bundle.
		// Verified by: complete corpus/line parity and all query cases in conformance.ts.
		const root = Number(
			db.prepare("SELECT value FROM metadata WHERE name='input'").all()[0]!.value
		);
		const { corpus: _corpus, ...fields } = RetainedInputCodec.fields;
		const core = Schema.decodeUnknownSync(Schema.Struct(fields))(
			this.records.project([root], Object.keys(fields))[0]
		);
		const corpus = () => {
			if (!this.#corpusHeader)
				this.#corpusHeader = Schema.decodeUnknownSync(TextCorpusHeader)(
					obj(this.records.project([root], ["corpus"])[0]).corpus
				);
			return this.#corpusHeader;
		};
		this.input = {
			...core,
			get corpus() {
				return corpus();
			}
		};
	}
	problem(request: Request, alias = "r"): string {
		if (!request.localization) return settled(`${alias}.base_problems`);
		const scope = scoped(request);
		let table = this.#cultureProblems.get(scope);
		if (!table) {
			table = `culture_problems_${this.#cultureProblems.size}`;
			const bits = TEXT_PROBLEMS.slice(0, -1)
				.map((_, bit) => `(max((m.problems & ${1 << bit})<>0)*${1 << bit})`)
				.join(" | ");
			this.db.exec(
				`CREATE TEMP TABLE ${table}(owner INTEGER PRIMARY KEY,problems INTEGER NOT NULL); INSERT INTO ${table} SELECT m.owner,${bits} FROM culture_mark m WHERE ${scope} GROUP BY m.owner;`
			);
			this.#cultureProblems.set(scope, table);
		}
		return settled(
			`(${alias}.base_problems | coalesce((SELECT problems FROM ${table} p WHERE p.owner=${alias}.id),0))`
		);
	}
	selection(request: Request, except?: string): string {
		if (request.findings) throw new Error("This pilot has no authored findings layer yet");
		if (request.localization && request.localization.target !== this.input.target)
			throw new Error("Target not found");
		const tests = [`r.kind=${q(request.localization ? "line" : "unit")}`, "r.visible=1"];
		const mark = (test: string) =>
			`EXISTS(SELECT 1 FROM culture_mark m WHERE m.owner=r.id AND ${scoped(request)} AND (${test}))`;
		if (request.lines) tests.push(`r.key IN (${list(request.lines)})`);
		for (const term of request.query.toLowerCase().trim().split(/\s+/u).filter(Boolean)) {
			if (!request.localization?.searchTranslations && /^[a-z0-9]{3}/u.test(term)) {
				const token = `"${term.slice(0, 3)}"`;
				let indexed = this.#trigramPlans.get(token);
				if (indexed === undefined) {
					if (!this.#sourceRows)
						this.#sourceRows = Number(
							this.db.prepare("SELECT count(*) AS n FROM row_data").all()[0]!.n
						);
					const candidates = Number(
						this.db
							.prepare("SELECT count(*) AS n FROM row_fts WHERE row_fts MATCH ?")
							.all(token)[0]!.n
					);
					indexed = candidates < this.#sourceRows / 8;
					if (this.#trigramPlans.size >= 128) this.#trigramPlans.clear();
					this.#trigramPlans.set(token, indexed);
				}
				if (indexed)
					tests.push(
						`r.id IN (SELECT rowid FROM row_fts WHERE row_fts MATCH ${q(token)})`
					);
			}
			const source = `instr(r.source,${q(term)})>0`;
			tests.push(
				request.localization?.searchTranslations
					? `(${source} OR ${mark(`instr(m.archive_text,${q(term)})>0 OR instr(m.po_text,${q(term)})>0`)})`
					: source
			);
		}
		for (const clause of request.filter ?? []) {
			if (clause.field === except) continue;
			const values = clause.values;
			let test: string;
			switch (clause.field) {
				case "problem":
					test = `(${this.problem(request)} & ${values.reduce((n, name) => n | (1 << TEXT_PROBLEMS.findIndex((problem) => problem === name)), 0)})<>0`;
					break;
				case "audience":
					test = `r.audience IN (${list(values)})`;
					break;
				case "namespace":
					test = `coalesce(r.namespace IN (${list(values)}),0)`;
					break;
				case "notes":
					test =
						values.length === 2
							? "1"
							: `${values[0] === "present" ? "" : "NOT "}(${this.hasNotes("r")})`;
					break;
				case "folder":
					test = feature(
						"paths",
						values
							.map(
								(value) =>
									`substr(f.value,1,length(${q(normalizeTextPath(value))}))=${q(normalizeTextPath(value))}`
							)
							.join(" OR ")
					);
					break;
				case "asset":
					test = has("files", values.map(textFileKey));
					break;
				case "source":
					test = has("sources", values);
					break;
				case "translation_key":
					test = has("translationKey", values);
					break;
				case "asset_type":
					test = has("assetTypes", values);
					break;
				case "translation":
					test = mark(
						values
							.map((state) =>
								state === "not_synced"
									? "(m.state='not_synced' OR (m.facts & 8)<>0)"
									: `m.state=${q(state === "missing" ? "not_translated" : "needs_update")}`
							)
							.join(" OR ")
					);
					break;
				default:
					test = has(
						(
							{
								fact: "facts",
								origin: "origins",
								editing: "editing",
								finding: "findings"
							} as const
						)[clause.field],
						values
					);
			}
			tests.push(clause.op === "is_not" ? `NOT (${test})` : `(${test})`);
		}
		const placeTest = (alias: string, fallback = false) => {
			const parts: string[] = [];
			if (request.capability !== "all" && except !== "capability")
				parts.push(
					fallback
						? request.capability === "read_only"
							? "1"
							: "0"
						: has(
								"editing",
								[
									request.capability === "source_editable"
										? "editable"
										: "read_only"
								],
								alias
							)
				);
			if (request.withoutNotes && except !== "withoutNotes")
				parts.push(
					`NOT (${this.hasNotes(alias)})${request.localization && !fallback ? ` AND NOT ${has("manifestNotes", ["present"])}` : ""}`
				);
			if (request.where?.kinds && except !== "kinds")
				parts.push(has("origins", request.where.kinds, alias));
			if (request.where?.pathPrefix) {
				const prefix = q(normalizeTextPath(request.where.pathPrefix));
				parts.push(
					feature("paths", `substr(f.value,1,length(${prefix}))=${prefix}`, alias)
				);
			}
			if (request.where?.files)
				parts.push(has("files", request.where.files.map(textFileKey), alias));
			return parts;
		};
		const place = placeTest("r");
		if (place.length)
			tests.push(
				request.localization
					? `(EXISTS(SELECT 1 FROM row_unit link JOIN query_row u ON u.id=link.unit WHERE link.line=r.id AND u.visible=1 AND ${placeTest("u").join(" AND ")}) OR (NOT EXISTS(SELECT 1 FROM row_unit link WHERE link.line=r.id) AND ${placeTest("r", true).join(" AND ")}))`
					: place.join(" AND ")
			);

		if (request.localization?.state)
			tests.push(
				mark(
					request.localization.state === "not_synced"
						? "(m.facts & 8)<>0"
						: `m.state=${q(request.localization.state)}`
				)
			);
		if (request.localization?.review)
			tests.push(
				mark(
					`(m.review_bits & ${1 << reviewLenses.indexOf(request.localization.review)})<>0`
				)
			);
		if (request.localization?.keyChanged) tests.push("(r.base_problems & 1)<>0");
		return tests.join(" AND ");
	}
	hasNotes(alias: string): string {
		return `${alias}.q_notes<>0`;
	}

	matched(request: Request, except?: string): string {
		return `SELECT r.*,${this.problem(request)} AS pm FROM query_row r WHERE ${this.selection(request, except)}`;
	}
	rows(request: Request): RowsDocument {
		if (request.openGroups !== undefined && request.group !== undefined) {
			const {
				openGroups,
				firstRows,
				cursor: _cursor,
				localizationCursor: _localizationCursor,
				...base
			} = request;
			let budget = 500;
			const open = openGroups.map((key) => {
				const page = this.rows({ ...base, openGroup: key, pageSize: firstRows ?? 50 });
				const count = page.localization?.lines.length ?? page.units.length;
				if (count > budget) {
					budget = 0;
					return { key, rowsOmitted: true } as const;
				}
				budget -= count;
				return { key, page };
			});
			return {
				units: [],
				...(request.localization && {
					localization: { target: this.input.target, lines: [] }
				}),
				openGroups: open
			};
		}
		const after = request.localization ? request.localizationCursor : request.cursor;
		const selection = this.matched(request);
		let group = "";
		if (request.group && request.openGroup !== undefined)
			group =
				request.group === "problem"
					? ` AND ${worst("pm")}=${TEXT_PROBLEMS.findIndex((problem) => problem === request.openGroup)}`
					: ` AND EXISTS(SELECT 1 FROM row_group g WHERE g.owner=r.id AND g.dimension=${q(request.group)} AND g.key=${q(request.openGroup)})`;
		const cursor = after
			? ` AND r.rank > coalesce((SELECT rank FROM selected WHERE key=${q(after)}${group}),-1)`
			: "";
		const rows = this.db
			.prepare(
				`WITH selected AS (${selection}) SELECT * FROM selected r WHERE 1${group}${cursor} ORDER BY rank LIMIT ${request.pageSize + 1}`
			)
			.all();
		const page = rows.slice(0, request.pageSize);
		const next =
			rows.length > request.pageSize
				? { nextCursor: hostText(String(page.at(-1)!.key)) }
				: {};
		const payloads = this.records
			.read(page.map((row) => Number(row.preview)))
			.map((value, index) => ({
				...obj(value),
				problems: problems(Number(page[index]!.pm))
			}));
		if (!request.localization) return { ...next, units: payloads };
		const unitRows = page.map(
			(row) =>
				this.db
					.prepare("SELECT unit FROM line_preview WHERE owner=?")
					.all(Number(row.id))[0]?.unit ?? null
		);
		const units: Json[] = [];
		for (let index = 0; index < page.length; index++)
			if (unitRows[index] !== null) {
				const value = obj(this.records.read([Number(unitRows[index])])[0]);
				units.push({ ...value, problems: payloads[index]!.problems! });
			}
		return { localization: { target: this.input.target, ...next, lines: payloads }, units };
	}
	counts(request: Request) {
		interface Metric {
			key: string;
			predicate: string;
			except?: string;
		}
		const tab = (name: string) => (request.localization ? undefined : name);
		const metrics: Metric[] = [
			{ key: "all", predicate: "1" },
			{ key: "unresolved", predicate: has("facts", ["unresolved"]) },
			{ key: "conflicting", predicate: has("facts", ["conflicting"]) },
			{
				key: "editable",
				predicate: has("editing", ["editable"]),
				...(tab("capability") && { except: "capability" })
			},
			{
				key: "readOnly",
				predicate: has("editing", ["read_only"]),
				...(tab("capability") && { except: "capability" })
			},
			{
				key: "withoutNotes",
				predicate: `NOT (${this.hasNotes("r")})`,
				...(tab("withoutNotes") && { except: "withoutNotes" })
			},
			...TEXT_ORIGIN_KINDS.map((origin) => ({
				key: `origin_${origin}`,
				predicate: has("origins", [origin]),
				except: "kinds"
			}))
		];
		const queries = new Map<string, Metric[]>();
		for (const metric of metrics) {
			const where = this.selection(request, metric.except);
			const items = queries.get(where) ?? [];
			items.push(metric);
			queries.set(where, items);
		}
		const values = new Map<string, number>();
		for (const [where, items] of queries) {
			const row = this.db
				.prepare(
					`SELECT ${items.map((metric) => `coalesce(sum((${metric.predicate})),0) AS "${metric.key}"`).join(",")} FROM query_row r WHERE ${where}`
				)
				.all()[0]!;
			for (const metric of items) values.set(metric.key, Number(row[metric.key]));
		}
		return {
			all: values.get("all")!,
			unresolved: values.get("unresolved")!,
			conflicting: values.get("conflicting")!,
			editable: values.get("editable")!,
			readOnly: values.get("readOnly")!,
			withoutNotes: values.get("withoutNotes")!,
			origins: Object.fromEntries(
				TEXT_ORIGIN_KINDS.map((origin) => [origin, values.get(`origin_${origin}`)!])
			)
		};
	}

	localizationCounts(request: Request) {
		const matched = this.matched(request);
		const rows = this.db
			.prepare(
				`WITH selected AS (${matched}) SELECT m.culture,m.state,count(*) AS lines,sum(r.words) AS words,${reasons.map((_, i) => `sum((m.reason_bits & ${1 << i})<>0) AS reason${i}`).join(",")},max(m.reduced) AS reduced FROM selected r JOIN culture_mark m ON m.owner=r.id GROUP BY m.culture,m.state`
			)
			.all();
		const stateTests = states.map((state) =>
			state === "not_synced" ? "(m.facts & 8)<>0" : `m.state=${q(state)}`
		);
		const summary = this.db
			.prepare(
				`WITH selected AS (${matched}), per_line AS (SELECT r.id,r.base_problems,${stateTests.map((test, i) => `max(${test}) AS s${i}`).join(",")},${reviewLenses.map((_, i) => `max((m.review_bits & ${1 << i})<>0) AS v${i}`).join(",")},sum((m.facts & 8)<>0) AS not_synced,max(m.review IS NOT NULL) AS reviewed FROM selected r JOIN culture_mark m ON m.owner=r.id WHERE ${scoped(request)} GROUP BY r.id) SELECT count(*) AS rows,coalesce(sum((base_problems & 1)<>0),0) AS key_changed,coalesce(sum(not_synced),0) AS not_synced,max(reviewed) AS reviewed,${states.map((_, i) => `coalesce(sum(s${i}),0) AS s${i}`).join(",")},${reviewLenses.map((_, i) => `coalesce(sum(v${i}),0) AS v${i}`).join(",")} FROM per_line`
			)
			.all()[0]!;
		const cultures = request.localization?.cultures ?? this.input.cultures;
		const keyChanged = Number(summary.key_changed),
			notSynced = Number(summary.not_synced),
			reviewed = Boolean(summary.reviewed);

		return {
			target: this.input.target,
			counts: cultures.map((culture) => {
				const values = rows.filter((row) => row.culture === culture);
				return {
					culture,
					states: Object.fromEntries(
						states.map((state) => {
							const value = values.find((row) => row.state === state);
							return [
								state,
								{
									lines: Number(value?.lines ?? 0),
									sourceWords: Number(value?.words ?? 0)
								}
							];
						})
					),
					unknownReasons: Object.fromEntries(
						reasons.map((reason, index) => [
							reason,
							values.reduce((n, value) => n + Number(value[`reason${index}`]), 0)
						])
					),
					reducedSourceChecking: values.some((row) => row.reduced)
						? Number(summary.rows)
						: 0
				};
			}),
			stateCounts: Object.fromEntries(
				states.map((state) => [state, Number(summary[`s${states.indexOf(state)}`])])
			),
			notSynced,
			...(reviewed && {
				reviewCounts: Object.fromEntries(
					reviewLenses.map((name, bit) => [name, Number(summary[`v${bit}`])])
				)
			}),
			...((keyChanged || request.localization?.keyChanged) && { keyChanged })
		};
	}
	groups(request: Request, by: GroupBy, facet = false, except?: string) {
		const matched = this.matched(request, except);
		if (by === "finding") return { entries: [], more: 0 };
		let source: string;
		if (by === "problem")
			source = `SELECT r.id,${worst("r.pm")} AS key,${worst("r.pm")} AS label,r.pm FROM selected r`;
		else if (facet) {
			const field = {
				origin: "origins",
				asset: "files",
				audience: "audience",
				namespace: "namespace",
				source: "sources",
				folder: "paths"
			}[by];
			if (by === "audience")
				source = "SELECT id,audience AS key,audience AS label,pm FROM selected";
			else if (!field) return { entries: [], more: 0 };
			else
				source = `SELECT DISTINCT r.id,f.value AS key,f.label,r.pm FROM selected r JOIN feature f ON f.owner=r.id AND f.field=${q(field)}`;
		} else
			source = `SELECT r.id,g.key,g.label,r.pm FROM selected r JOIN row_group g ON g.owner=r.id AND g.dimension=${q(by)}`;
		const rows = this.db
			.prepare(
				`WITH selected AS (${matched}), members AS (${source}) SELECT key,label,count(*) AS count,sum((${worst("pm")})<5) AS needWork,min(${worst("pm")}) AS worst FROM members GROUP BY key HAVING count(*)>=${request.minGroupSize ?? 1}`
			)
			.all();
		const display = (row: Row) => {
			const key =
				by === "problem" ? TEXT_PROBLEMS[Number(row.key)]! : hostText(String(row.key));
			let label = hostText(String(row.label));
			if (by === "problem") label = TEXT_PROBLEM_LABELS[TEXT_PROBLEMS[Number(row.key)]!];
			if (by === "origin") {
				const origin = TEXT_ORIGIN_KINDS.find((origin) => origin === key);
				label = origin ? TEXT_ORIGIN_LABELS[origin] : "";
			}
			if (by === "audience") {
				const audience = ["player", "editor", "unknown"].find(
					(audience) => audience === key
				);
				label =
					audience === "player"
						? TEXT_AUDIENCE_LABELS.player
						: audience === "editor"
							? TEXT_AUDIENCE_LABELS.editor
							: TEXT_AUDIENCE_LABELS.unknown;
			}
			return {
				key,
				label,
				count: Number(row.count),
				needWork: Number(row.needWork),
				worst: TEXT_PROBLEMS[Number(row.worst)]!
			};
		};
		const groups = rows
			.map(display)
			.sort(
				(a, b) =>
					TEXT_PROBLEMS.indexOf(a.worst) - TEXT_PROBLEMS.indexOf(b.worst) ||
					b.needWork - a.needWork ||
					b.count - a.count ||
					(a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
			);
		return { entries: groups.slice(0, 200), more: Math.max(0, groups.length - 200) };
	}
	folders(request: Request, under: string): Json {
		const parent = normalizeTextPath(under).replace(/\/+$/u, "");
		const depth = parent ? parent.split("/").length + 1 : 1;
		const members = `SELECT DISTINCT r.id,f.key,f.label,r.pm FROM selected r JOIN row_folder f ON f.owner=r.id WHERE f.depth=${depth}${parent ? ` AND substr(f.key,1,length(${q(parent + "/")}))=${q(parent + "/")}` : ""}`;
		const rows = this.db
			.prepare(
				`WITH selected AS (${this.matched(request, "folder")}), members AS (${members}) SELECT key,label,count(*) AS count,sum((${worst("pm")})<5) AS needWork,min(${worst("pm")}) AS worst FROM members GROUP BY key`
			)
			.all();
		const entries = rows
			.map((row) => ({
				key: hostText(String(row.key)),
				label: hostText(String(row.label)),
				count: Number(row.count),
				needWork: Number(row.needWork),
				worst: TEXT_PROBLEMS[Number(row.worst)]!
			}))
			.sort(
				(a, b) =>
					TEXT_PROBLEMS.indexOf(a.worst) - TEXT_PROBLEMS.indexOf(b.worst) ||
					b.needWork - a.needWork ||
					b.count - a.count ||
					(a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
			);
		return { under, entries: entries.slice(0, 200), more: Math.max(0, entries.length - 200) };
	}
	cultures(request: Request): Json {
		const { cultures: _cultures, ...localization } = request.localization!;
		const base = { ...request, localization };
		const rows = this.db
			.prepare(
				`WITH selected AS (${this.matched(base)}) SELECT m.culture,count(*) AS lines,sum(m.state='translated') AS shipped,sum(m.state='not_translated') AS missing,sum(m.state='needs_update') AS toUpdate,sum(m.state='not_synced' OR (m.facts & 8)<>0) AS notSynced FROM selected r JOIN culture_mark m ON m.owner=r.id GROUP BY m.culture`
			)
			.all();
		return this.input.cultures
			.map((culture) => {
				const row = rows.find((row) => row.culture === culture);
				return {
					culture,
					lines: Number(row?.lines ?? 0),
					shipped: Number(row?.shipped ?? 0),
					missing: Number(row?.missing ?? 0),
					toUpdate: Number(row?.toUpdate ?? 0),
					notSynced: Number(row?.notSynced ?? 0)
				};
			})
			.sort(
				(a, b) =>
					b.missing + b.toUpdate - (a.missing + a.toUpdate) ||
					(a.culture < b.culture ? -1 : a.culture > b.culture ? 1 : 0)
			);
	}
	search(request: Request) {
		const rows = this.rows(request),
			counts = this.counts(request);
		const selected = this.matched(request, "problem");
		const totals = this.db
			.prepare(
				`WITH selected AS (${selected}) SELECT ${TEXT_PROBLEMS.map((_, bit) => `coalesce(sum((pm & ${1 << bit})<>0),0) AS p${bit}`).join(",")} FROM selected`
			)
			.all()[0]!;
		const problemCounts = Object.fromEntries(
			TEXT_PROBLEMS.map((name, bit) => [name, Number(totals[`p${bit}`])])
		);

		const facets: ObjectValue = {};
		if (request.facets?.origins)
			facets.origins = this.groups(request, "origin", true, "origin");
		if (request.facets?.assets) facets.assets = this.groups(request, "asset", true, "asset");
		if (request.facets?.audiences)
			facets.audiences = this.groups(request, "audience", true, "audience");
		if (request.facets?.assetTypes) facets.assetTypes = { entries: [], more: 0 };
		if (request.facets?.findings) facets.findings = { entries: [], more: 0 };
		if (request.facets?.folder !== undefined)
			facets.folders = this.folders(request, request.facets.folder);
		if (request.facets?.cultures && request.localization)
			facets.cultures = this.cultures(request);
		if (request.facets?.facts)
			facets.facts = Object.fromEntries(
				["unresolved", "conflicting", "evidence_only", "compiled_copy_differs"].map(
					(fact) => [
						fact,
						Number(
							this.db
								.prepare(
									`SELECT count(*) AS n FROM query_row r WHERE ${this.selection(request, "fact")} AND ${has("facts", [fact])}`
								)
								.all()[0]!.n
						)
					]
				)
			);
		return {
			...rows,
			...(request.localization && {
				localization: {
					...obj(rows.localization),
					...this.localizationCounts(request)
				}
			}),
			counts,
			total: counts.all!,
			problems: problemCounts,
			...(request.group && {
				groups: { by: request.group, ...this.groups(request, request.group) }
			}),
			...(request.facets && { facets }),
			...(request.where?.files && { fileScope: this.fileScope(request) })
		};
	}
	fileScope(request: Request): Json {
		const keys = [...new Set(request.where!.files!.map(textFileKey).filter(Boolean))];
		const outside = keys.filter((key) => /^(?:\/|[a-z]:\/)/u.test(key)).length;
		const local = keys.filter((key) => !/^(?:\/|[a-z]:\/)/u.test(key));
		const textFiles = Number(
			this.db
				.prepare(
					`WITH selected AS (${this.matched(request)}) SELECT count(DISTINCT f.value) AS n FROM selected r JOIN feature f ON f.owner=r.id AND f.field='files' WHERE f.value IN (${list(local)})`
				)
				.all()[0]!.n
		);
		const scanned = new Set(
			(this.input.corpus.packageCoverage ?? []).map((entry) => textFileKey(entry.packageFile))
		);
		return {
			files: local.length + outside,
			textFiles,
			outside,
			notScanned: local.filter((key) => !/\.[^/]+$/u.test(key) && !scanned.has(key)).length
		};
	}
	readCorpus(): Json {
		return {
			...obj(json(this.input.corpus)),
			units: this.records.read(
				this.db
					.prepare("SELECT raw FROM row_data WHERE kind='unit' ORDER BY rank")
					.all()
					.map((row) => Number(row.raw))
			)
		};
	}
	corpusFingerprint(progress?: (count: number) => void): string {
		const hash = createHash("sha256");
		const header = obj(json(this.input.corpus));
		const keys = [...Object.keys(header), "units"].sort();
		progress?.(0);
		hash.update("{");
		for (const [index, key] of keys.entries()) {
			if (index) hash.update(",");
			hash.update(JSON.stringify(key)).update(":");
			if (key !== "units") {
				hash.update(canonical(header[key]!));
				continue;
			}
			hash.update("[");
			let after = -1,
				count = 0;
			while (true) {
				const rows = this.db
					.prepare(
						"SELECT rank,raw FROM row_data WHERE kind='unit' AND rank>? ORDER BY rank LIMIT 250"
					)
					.all(after);
				if (!rows.length) break;
				for (const value of this.records.read(rows.map((row) => Number(row.raw)))) {
					if (count++) hash.update(",");
					hash.update(canonical(value));
				}
				after = Number(rows.at(-1)!.rank);
				if (count % 25000 === 0) progress?.(count);
			}
			hash.update("]");
		}
		return hash.update("}").digest("hex");
	}
	readLines(): Json {
		return this.records.read(
			this.db
				.prepare("SELECT value FROM raw_line ORDER BY rank")
				.all()
				.map((row) => Number(row.value))
		);
	}
	select(request: Request, fields: readonly string[]): Json {
		const withProblems = fields.includes("problems");
		const rows = this.db
			.prepare(
				`SELECT r.view${withProblems ? `,${this.problem(request)} AS pm` : ""} FROM query_row r WHERE ${this.selection(request)} ORDER BY rank`
			)
			.all();
		const answer: Json[] = [];
		for (let offset = 0; offset < rows.length; offset += 1000) {
			const part = rows.slice(offset, offset + 1000);
			const values = this.records.project(
				part.map((row) => Number(row.view)),
				["id", ...fields]
			);
			answer.push(
				...values.map((value, i) =>
					withProblems
						? { ...obj(value), problems: problems(Number(part[i]!.pm)) }
						: value
				)
			);
		}
		return answer;
	}

	aggregate(request: TextAggregateRequest): Json {
		const search: Request = { ...request, pageSize: 1 };
		const selected = this.matched(search);
		const joins: string[] = ["JOIN row_measure measure ON measure.owner=r.id"];
		const keys: string[] = [];
		const predicates: string[] = [];
		if (request.by.includes("culture"))
			joins.push(`JOIN culture_mark m ON m.owner=r.id AND ${scoped(search)}`);
		for (const [i, dimension] of request.by.entries()) {
			switch (dimension) {
				case "culture":
					keys.push("m.culture");
					break;
				case "state":
					keys.push("m.state");
					break;
				case "review_status":
					keys.push("m.review");
					predicates.push("m.review IS NOT NULL");
					break;
				case "fact":
				case "unknown_reason":
				case "review":
				case "review_flag":
					joins.push(
						`JOIN mark_value v${i} ON v${i}.owner=r.id AND v${i}.culture=m.culture AND v${i}.dimension=${q(dimension)}`
					);
					keys.push(`v${i}.value`);
					break;
				case "namespace":
					keys.push("coalesce(r.namespace,'')");
					break;
				case "audience":
					keys.push("r.audience");
					break;
				case "gathered":
					keys.push("CASE WHEN measure.gathered THEN 'true' ELSE 'false' END");
					break;
				case "source":
					joins.push(
						`JOIN row_group v${i} ON v${i}.owner=r.id AND v${i}.dimension='source'`
					);
					keys.push(`v${i}.key`);
					break;
				case "translation_key":
					keys.push(
						"coalesce((SELECT value FROM feature f WHERE f.owner=r.id AND f.field='translationKey' LIMIT 1),'')"
					);
					break;
				case "problem":
					joins.push(
						`JOIN (${TEXT_PROBLEMS.map((problem, bit) => `SELECT ${q(problem)} AS value,${1 << bit} AS bit`).join(" UNION ALL ")}) v${i} ON (r.pm & v${i}.bit)<>0`
					);
					keys.push(`v${i}.value`);
					break;
				default: {
					const field = {
						origin: "origins",
						finding: "findings",
						review_signal: "facts",
						asset: "files"
					}[dimension];
					joins.push(
						`JOIN feature v${i} ON v${i}.owner=r.id AND v${i}.field=${q(field)}`
					);
					keys.push(`v${i}.value`);
				}
			}
		}
		const sql = `WITH selected AS (${selected}) SELECT ${keys.map((key, i) => `${key} AS k${i}`).join(",")},count(*) AS lines,sum(r.words) AS sourceWords,coalesce(sum(measure.line_break_words),0) AS lineBreakWords,sum(measure.line_break_words IS NULL) AS unknownWords FROM selected r ${joins.join(" ")} ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""} GROUP BY ${keys.map((_, i) => `k${i}`).join(",")}`;
		const rows = this.db
			.prepare(sql)
			.all()
			.map((row) => ({
				key: keys.map((_, i) => hostText(String(row[`k${i}`]))),
				lines: Number(row.lines),
				...(request.measures?.includes("sourceWords") && {
					sourceWords: Number(row.sourceWords)
				}),
				...(request.measures?.includes("lineBreakWords") && {
					lineBreakWords: Number(row.lineBreakWords),
					unknownWords: Number(row.unknownWords)
				})
			}));
		const rank = (value: string, dimension: TextAggregateRequest["by"][number]) => {
			const order = {
				culture: this.input.cultures,
				state: states,
				fact: states,
				unknown_reason: reasons,
				review: reviewLenses,
				review_status: ["not_reviewed", "current", "changed"],
				origin: TEXT_ORIGIN_KINDS,
				problem: TEXT_PROBLEMS,
				audience: ["player", "editor", "unknown"],
				review_signal: [
					"unresolved",
					"conflicting",
					"evidence_only",
					"compiled_copy_differs"
				]
			};
			if (dimension in order) {
				const values = Object.entries(order).find(([key]) => key === dimension)![1];
				return String(values.findIndex((candidate) => candidate === value)).padStart(
					8,
					"0"
				);
			}
			if (dimension === "translation_key" && value) {
				const pair = JSON.parse(value);
				return `${pair[0]}\0${pair[1]}`;
			}
			return value;
		};
		rows.sort((a, b) => {
			for (const [i, dimension] of request.by.entries()) {
				const left = rank(a.key[i]!, dimension),
					right = rank(b.key[i]!, dimension);
				if (left !== right) return left < right ? -1 : 1;
			}
			return 0;
		});
		return {
			lines: Number(
				this.db
					.prepare(`WITH selected AS (${selected}) SELECT count(*) AS n FROM selected`)
					.all()[0]!.n
			),
			groups: rows
		};
	}
	export(request: Request): Json {
		if (request.localization) throw new Error("Localized corpus export is not implemented");
		const rows = this.db
			.prepare(`SELECT r.raw FROM query_row r WHERE ${this.selection(request)} ORDER BY rank`)
			.all();
		return {
			...obj(json(this.input.corpus)),
			units: this.records.read(rows.map((row) => Number(row.raw)))
		};
	}
	line(id: string): Json | undefined {
		const row = this.db.prepare("SELECT value FROM raw_line WHERE key=?").all(sqlText(id))[0];
		return row ? this.records.read([Number(row.value)])[0] : undefined;
	}
	detail(request: LocalizationFocusRequest): Json | undefined {
		const id =
			request.selection.kind === "line"
				? request.selection.id
				: hostText(
						String(
							this.db
								.prepare(
									"SELECT l.key FROM row_data l JOIN row_unit u ON u.line=l.id JOIN row_data r ON r.id=u.unit WHERE r.key=? ORDER BY l.rank LIMIT 1"
								)
								.all(sqlText(request.selection.id))[0]?.key ?? ""
						)
					);
		const line = this.line(id);
		if (!line) return undefined;
		// SAFETY: full LocalizationLine was decoded before storage; records preserve its exact shape.
		// Verified by: full line and detail native parity, including nested evidence/Unicode.
		const typedLine = Schema.decodeUnknownSync(LocalizationLine)(line);
		const search = {
			query: "",
			capability: "all",
			pageSize: 1,
			localization: {
				target: request.target,
				...(request.culture && { culture: request.culture }),
				...(request.cultures && { cultures: request.cultures })
			}
		} satisfies Request;
		const row = this.db
			.prepare(
				`SELECT ${this.problem(search)} AS pm FROM query_row r WHERE r.key=? AND kind='line'`
			)
			.all(sqlText(id))[0];
		return json({
			...localizationFocusPage(
				{
					target: request.target,
					nativeCulture:
						this.input.nativeCulture === null
							? null
							: CultureCode.make(this.input.nativeCulture),
					cultures: typedLine.cultures.map((mark) => mark.culture)
				},
				typedLine,
				request
			),
			problems: problems(Number(row?.pm ?? 128))
		});
	}
}
