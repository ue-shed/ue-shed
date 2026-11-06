/* oxlint-disable anti-slop/no-runtime-typeof -- This lossless codec switches over the already parsed JSON scalar kinds. */
/**
 * Lossless relational records. Each object layout has a typed reference column for every field;
 * arrays have ordered child rows; UTF-16 strings are BLOBs. No stored JSON text or opaque payload.
 * Query facts use dedicated indexed relations; this graph retains arbitrary nested UE evidence.
 */
import type { Json } from "./model.ts";
import type { Database, Parameter, Row, Statement } from "./database.ts";

export class Records {
	readonly #layouts = new Map<string, { id: number; keys: string[]; insert: Statement }>();
	readonly #layoutKeys = new Map<number, string[]>();
	readonly #atoms = new Map<string, number>();
	readonly #objects = new Map<string, number>();
	readonly #cache = new Map<number, Json>();
	#next = 0;
	#insert?: Statement;
	#item?: Statement;
	readonly db: Database;
	constructor(db: Database, write = false) {
		this.db = db;
		if (write) {
			db.exec(`CREATE TABLE IF NOT EXISTS value_node(id INTEGER PRIMARY KEY,kind INTEGER NOT NULL,layout INTEGER,text BLOB,number REAL);
CREATE TABLE IF NOT EXISTS layout_field(layout INTEGER,position INTEGER,key BLOB,PRIMARY KEY(layout,position)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS record_layout(id INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS array_item(owner INTEGER,position INTEGER,value INTEGER,PRIMARY KEY(owner,position)) WITHOUT ROWID;`);
			this.#next = Number(
				db.prepare("SELECT coalesce(max(id),0) AS id FROM value_node").all()[0]!.id
			);
			this.#insert = db.prepare("INSERT INTO value_node VALUES (?,?,?,?,?)");
			this.#item = db.prepare("INSERT INTO array_item VALUES (?,?,?)");
		}
		for (const row of db.prepare("SELECT id FROM record_layout").all())
			this.#layoutKeys.set(Number(row.id), []);
		for (const row of db.prepare("SELECT * FROM layout_field ORDER BY layout,position").all()) {
			const layout = Number(row.layout);
			const keys = this.#layoutKeys.get(layout) ?? [];
			keys.push(Buffer.from(bytes(row.key)).toString("utf16le"));
			this.#layoutKeys.set(layout, keys);
		}
		if (write) for (const [id, keys] of this.#layoutKeys) this.#registerLayout(id, keys);
	}
	#registerLayout(id: number, keys: string[]) {
		const insert = this.db.prepare(
			`INSERT INTO record_${id} VALUES (${Array(keys.length + 1)
				.fill("?")
				.join(",")})`
		);
		const signature = keys.map((key) => `${key.length}:${key}`).join("");
		const layout = { id, keys, insert };
		this.#layouts.set(signature, layout);
		this.#layoutKeys.set(id, keys);
		return layout;
	}
	put(value: Json): number {
		if (!this.#insert || !this.#item) throw new Error("Records are read-only");
		const atom = value === null || typeof value !== "object";
		const atomKey = atom ? `${typeof value}:${String(value)}` : "";
		if (atom) {
			const cached = this.#atoms.get(atomKey);
			if (cached !== undefined) return cached;
			const id = ++this.#next;
			const kind =
				value === null
					? 0
					: typeof value === "string"
						? 1
						: typeof value === "number"
							? 2
							: 3;
			this.#insert.run(
				id,
				kind,
				null,
				typeof value === "string" ? Buffer.from(value, "utf16le") : null,
				typeof value === "number"
					? value
					: typeof value === "boolean"
						? Number(value)
						: null
			);
			this.#atoms.set(atomKey, id);
			return id;
		}
		if (isArray(value)) {
			const children = value.map((child) => this.put(child));
			const signature = `a:${children.join(",")}`;
			const cached = this.#objects.get(signature);
			if (cached !== undefined) return cached;
			const id = ++this.#next;
			this.#insert.run(id, 4, null, null, null);
			children.forEach((child, index) => this.#item!.run(id, index, child));
			this.#remember(signature, id);
			return id;
		}
		const keys = Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort();
		const signature = keys.map((key) => `${key.length}:${key}`).join("");
		let layout = this.#layouts.get(signature);
		if (!layout) {
			const id = this.#layouts.size + 1;
			this.db.prepare("INSERT INTO record_layout VALUES (?)").run(id);
			this.db.exec(
				`CREATE TABLE record_${id}(id INTEGER PRIMARY KEY${keys.map((_, i) => `,f${i} INTEGER NOT NULL`).join("")})`
			);
			const field = this.db.prepare("INSERT INTO layout_field VALUES (?,?,?)");
			keys.forEach((key, index) => field.run(id, index, Buffer.from(key, "utf16le")));
			layout = this.#registerLayout(id, keys);
		}
		const children = keys.map((key) => this.put(value[key]!));
		const structural = `o:${layout.id}:${children.join(",")}`;
		const cached = this.#objects.get(structural);
		if (cached !== undefined) return cached;
		const id = ++this.#next;
		this.#insert.run(id, 5, layout.id, null, null);
		layout.insert.run(id, ...children);
		this.#remember(structural, id);
		return id;
	}
	#remember(key: string, id: number) {
		if (this.#objects.size > 200000) this.#objects.clear();
		this.#objects.set(key, id);
	}
	read(ids: readonly number[]): Json[] {
		const pending = new Map<number, { kind: number; keys?: string[]; children: number[] }>();
		let frontier = [...new Set(ids)].filter((id) => !this.#cache.has(id));
		while (frontier.length > 0) {
			const next = new Set<number>();
			for (let offset = 0; offset < frontier.length; offset += 500) {
				const part = frontier.slice(offset, offset + 500);
				const nodes = this.#rows("value_node", "id", part);
				if (nodes.length !== part.length) throw new Error("Missing retained value node");
				const layouts = new Map<number, number[]>();
				const arrays: number[] = [];
				for (const row of nodes) {
					const id = Number(row.id),
						kind = Number(row.kind);
					if (kind === 0) this.#cache.set(id, null);
					else if (kind === 1)
						this.#cache.set(id, Buffer.from(bytes(row.text)).toString("utf16le"));
					else if (kind === 2) this.#cache.set(id, Number(row.number));
					else if (kind === 3) this.#cache.set(id, Boolean(row.number));
					else if (kind === 4) {
						arrays.push(id);
						pending.set(id, { kind, children: [] });
					} else if (kind === 5) {
						const layout = Number(row.layout),
							listed = layouts.get(layout) ?? [];
						listed.push(id);
						layouts.set(layout, listed);
					} else throw new Error("Unknown retained value kind");
				}
				for (const [layout, children] of layouts) {
					const keys = this.#layoutKeys.get(layout);
					if (!keys) throw new Error("Missing retained layout");
					for (const row of this.#rows(`record_${layout}`, "id", children)) {
						const values = keys.map((_, i) => Number(row[`f${i}`]));
						pending.set(Number(row.id), { kind: 5, keys, children: values });
						values.forEach((id) => next.add(id));
					}
				}
				if (arrays.length)
					for (const row of this.#rows(
						"array_item",
						"owner",
						arrays,
						" ORDER BY owner,position"
					)) {
						const id = Number(row.value);
						pending.get(Number(row.owner))!.children.push(id);
						next.add(id);
					}
			}
			frontier = [...next].filter((id) => !this.#cache.has(id) && !pending.has(id));
		}
		const inflate = (id: number): Json => {
			if (this.#cache.has(id)) return this.#cache.get(id)!;
			const node = pending.get(id);
			if (!node) throw new Error("Broken retained reference");
			const children = node.children.map(inflate);
			const value: Json =
				node.kind === 4
					? children
					: Object.fromEntries(node.keys!.map((key, i) => [key, children[i]!]));
			this.#cache.set(id, value);
			return value;
		};
		const answer = ids.map(inflate);
		// A query does not retain the entire corpus as a hidden JavaScript query cache.
		this.#cache.clear();
		return answer;
	}
	/** Read only named object columns; an export of two fields never hydrates culture evidence. */
	project(ids: readonly number[], fields: readonly string[]): Json[] {
		const projected = new Map<number, { keys: string[]; refs: number[] }>();
		for (let offset = 0; offset < ids.length; offset += 500) {
			const nodes = this.#rows("value_node", "id", ids.slice(offset, offset + 500));
			const layouts = new Map<number, number[]>();
			for (const node of nodes) {
				if (node.kind !== 5) throw new Error("Projection requires a retained object");
				const layout = Number(node.layout),
					members = layouts.get(layout) ?? [];
				members.push(Number(node.id));
				layouts.set(layout, members);
			}
			for (const [layout, members] of layouts) {
				const all = this.#layoutKeys.get(layout);
				if (!all) throw new Error("Missing retained layout");
				const keys = fields.filter((field) => all.includes(field));
				const columns = keys.map((key) => `f${all.indexOf(key)}`);
				const rows = this.db
					.prepare(
						`SELECT id${columns.map((column) => `,${column}`).join("")} FROM record_${layout} WHERE id IN (${members.map(() => "?").join(",")})`
					)
					.all(...members);
				for (const row of rows)
					projected.set(Number(row.id), {
						keys,
						refs: columns.map((column) => Number(row[column]))
					});
			}
		}
		const refs = [...new Set([...projected.values()].flatMap((record) => record.refs))];
		const decoded = this.read(refs),
			values = new Map(refs.map((ref, i) => [ref, decoded[i]!]));
		return ids.map((id) => {
			const record = projected.get(id);
			if (!record) throw new Error("Missing projected object");
			return Object.fromEntries(
				record.keys.map((key, i) => [key, values.get(record.refs[i]!)!])
			);
		});
	}
	#rows(table: string, column: string, ids: readonly number[], suffix = ""): Row[] {
		return this.db
			.prepare(
				`SELECT * FROM ${table} WHERE ${column} IN (${ids.map(() => "?").join(",")})${suffix}`
			)
			.all(...ids);
	}
}
function isArray(value: Json): value is readonly Json[] {
	return Array.isArray(value);
}
function bytes(value: Parameter | undefined): Uint8Array {
	if (!(value instanceof Uint8Array)) throw new Error("Expected a retained UTF-16 BLOB");
	return value;
}
