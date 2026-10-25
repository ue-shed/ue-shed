import type { GameTextContract } from "@ue-shed/protocol";
import { MalformedFrame } from "./game-text-engine-frames.js";

/**
 * Column batches: how the Game Text engine streams rows. A body is a `u32` header length, the
 * JSON header, zero padding to 8 bytes, then 8-aligned buffers at the offsets the header gives.
 * Each batch has its own string table of WTF-8 entries. `crates/game-text-index/src/batch.rs`
 * writes them; the relations and their columns are generated from it.
 */
export type RelationName = keyof GameTextContract.Relations;
/** A column of relation `R`, by name. */
export type RelationColumn<R extends RelationName> = keyof GameTextContract.Relations[R] & string;

type CellOf<T extends GameTextContract.ColumnType> = T extends "u32" | "i32" | "f64"
	? number
	: T extends "bool"
		? boolean
		: T extends "str"
			? string
			: T extends "json"
				? GameTextContract.JsonValue
				: T extends "u32List"
					? readonly number[]
					: readonly string[];

type ColumnSpec<R extends RelationName, C extends RelationColumn<R>> =
	// Every relation column is a `{ type, missing }` record in the generated contract.
	GameTextContract.Relations[R][C] extends {
		readonly type: infer T extends GameTextContract.ColumnType;
		readonly missing: infer M;
	}
		? { readonly type: T; readonly missing: M }
		: never;

/** A cell's value: `null` or `undefined` when the row has none, as its column declares. */
export type BatchCell<R extends RelationName, C extends RelationColumn<R>> =
	| CellOf<ColumnSpec<R, C>["type"]>
	| (ColumnSpec<R, C>["missing"] extends "null"
			? null
			: ColumnSpec<R, C>["missing"] extends "omit"
				? undefined
				: never);

const alignTo8 = (value: number) => Math.ceil(value / 8) * 8;
// A leading U+FEFF is text, not a byte order mark: entries are decoded one at a time.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** WTF-8 as UTF-16 code units, keeping lone surrogates, which `TextDecoder` would replace. */
function decodeWtf8(bytes: Uint8Array): string {
	const units: number[] = [];
	for (let at = 0; at < bytes.length; ) {
		const lead = bytes[at]!;
		let point: number;
		if (lead < 0x80) {
			point = lead;
			at += 1;
		} else if (lead < 0xe0) {
			point = ((lead & 0x1f) << 6) | (bytes[at + 1]! & 0x3f);
			at += 2;
		} else if (lead < 0xf0) {
			point =
				((lead & 0x0f) << 12) | ((bytes[at + 1]! & 0x3f) << 6) | (bytes[at + 2]! & 0x3f);
			at += 3;
		} else {
			point =
				((lead & 0x07) << 18) |
				((bytes[at + 1]! & 0x3f) << 12) |
				((bytes[at + 2]! & 0x3f) << 6) |
				(bytes[at + 3]! & 0x3f);
			at += 4;
		}
		if (point > 0xffff) {
			point -= 0x10000;
			units.push(0xd800 + (point >> 10), 0xdc00 + (point & 0x3ff));
		} else units.push(point);
	}
	let text = "";
	for (let start = 0; start < units.length; start += 8192)
		text += String.fromCharCode(...units.slice(start, start + 8192));
	return text;
}

/** A row as an object: its columns by name, as the engine's encoders write them. */
export type BatchRow = { readonly [key: string]: GameTextContract.JsonValue };

interface Column {
	readonly name: string;
	readonly type: GameTextContract.ColumnType;
	readonly missing: GameTextContract.Missing;
	/** Fixed-width values, string-table indices, or a list column's offsets. */
	readonly values: Uint32Array | Int32Array | Float64Array | Uint8Array;
	/** A list column's values. */
	readonly items: Uint32Array | undefined;
	readonly validity: Uint8Array | undefined;
}

const bit = (bits: Uint8Array, index: number) => (bits[index >> 3]! & (1 << (index & 7))) !== 0;

/**
 * One batch, read through views over its frame's buffer. Cells decode when read; a string the
 * batch uses twice decodes once. A batch pins its buffer while its views are in use.
 */
export class EngineBatch<R extends RelationName = RelationName> {
	readonly part: string;
	readonly relation: R;
	readonly rows: number;
	/** The batch's columns in the order the request named them: each row object's key order. */
	readonly columns: readonly string[];
	private readonly byName = new Map<string, Column>();
	private readonly offsets: Uint32Array;
	private readonly bytes: Uint8Array;
	private readonly lone: Uint8Array | undefined;
	private readonly decoded: (string | undefined)[];

	constructor(body: ArrayBuffer) {
		const view = new DataView(body);
		const headerLength = view.getUint32(0, true);
		let header: GameTextContract.BatchHeader;
		try {
			// SAFETY: the engine serializes the header from the contract's `BatchHeader`; the
			// session's handshake checked that host and engine share that contract.
			// Verified by: batch.rs's tests and game-text-engine-batch.test.ts.
			header = JSON.parse(utf8.decode(new Uint8Array(body, 4, headerLength)));
		} catch (cause) {
			throw new MalformedFrame("A batch header is not JSON.", { cause });
		}
		const start = alignTo8(4 + headerLength);
		this.part = header.part;
		// SAFETY: a batch's relation is the one the request's part is read from.
		// Verified by: game-text-engine-batch.test.ts reads every column type back.
		this.relation = header.relation as R;
		this.rows = header.rows;
		const strings = header.strings;
		this.offsets = new Uint32Array(body, start + strings.offsets, strings.entries + 1);
		this.bytes = new Uint8Array(body, start + strings.bytes, this.offsets[strings.entries]);
		this.lone =
			strings.loneSurrogates === undefined
				? undefined
				: new Uint8Array(
						body,
						start + strings.loneSurrogates,
						Math.ceil(strings.entries / 8)
					);
		this.decoded = new Array(strings.entries);
		const rows = header.rows;
		for (const column of header.columns) {
			const at = start + column.offset;
			let values: Column["values"];
			let items: Uint32Array | undefined;
			switch (column.type) {
				case "u32":
				case "str":
				case "json":
					values = new Uint32Array(body, at, rows);
					break;
				case "i32":
					values = new Int32Array(body, at, rows);
					break;
				case "f64":
					values = new Float64Array(body, at, rows);
					break;
				case "bool":
					values = new Uint8Array(body, at, Math.ceil(rows / 8));
					break;
				case "u32List":
				case "strList": {
					const offsets = new Uint32Array(body, at, rows + 1);
					values = offsets;
					items = new Uint32Array(body, start + column.values!, offsets[rows]);
					break;
				}
			}
			this.byName.set(column.name, {
				name: column.name,
				type: column.type,
				missing: column.missing,
				values,
				items,
				validity:
					column.validity === undefined
						? undefined
						: new Uint8Array(body, start + column.validity, Math.ceil(rows / 8))
			});
		}
		this.columns = header.columns.map((column) => column.name);
	}

	/** Whether the request asked for this column. */
	has(name: RelationColumn<R>): boolean {
		return this.byName.has(name);
	}

	/** A fixed-width column as its typed array: one value per row, 0 where a row has none. */
	numbers(name: RelationColumn<R>): Uint32Array | Int32Array | Float64Array {
		const column = this.column(name);
		if (column.type !== "u32" && column.type !== "i32" && column.type !== "f64")
			throw new TypeError(`Column ${name} holds ${column.type}, not numbers.`);
		// SAFETY: number columns' values are the typed arrays their type names.
		// Verified by: game-text-engine-batch.test.ts reads every column type back.
		return column.values as Uint32Array | Int32Array | Float64Array;
	}

	/** A table entry as a string. */
	text(index: number): string {
		const cached = this.decoded[index];
		if (cached !== undefined) return cached;
		const bytes = this.bytes.subarray(this.offsets[index], this.offsets[index + 1]);
		const text =
			this.lone !== undefined && bit(this.lone, index)
				? decodeWtf8(bytes)
				: utf8.decode(bytes);
		this.decoded[index] = text;
		return text;
	}

	/** One cell, or `null` or `undefined` when the row has none, as its column declares. */
	cell<C extends RelationColumn<R>>(row: number, name: C): BatchCell<R, C> {
		// SAFETY: `read` returns the value the column's wire type and missing rule produce, which
		// is what `BatchCell` derives from the same generated declaration.
		// Verified by: game-text-engine-batch.test.ts reads every column type back.
		return this.read(row, this.column(name)) as BatchCell<R, C>;
	}

	/** One row as an object, its keys in the batch's column order; rows without a value omit it. */
	row(row: number): BatchRow {
		const cells: [string, GameTextContract.JsonValue][] = [];
		for (const column of this.byName.values()) {
			const value = this.read(row, column);
			if (value !== undefined) cells.push([column.name, value]);
		}
		return Object.fromEntries(cells);
	}

	/** Every row as an object. */
	objects(): BatchRow[] {
		const rows = new Array<BatchRow>(this.rows);
		for (let row = 0; row < this.rows; row += 1) rows[row] = this.row(row);
		return rows;
	}

	private column(name: string): Column {
		const column = this.byName.get(name);
		if (column === undefined)
			throw new TypeError(`The ${this.part} batch has no column ${name}.`);
		return column;
	}

	private read(row: number, column: Column): GameTextContract.JsonValue | undefined {
		if (column.validity !== undefined && !bit(column.validity, row))
			return column.missing === "null" ? null : undefined;
		const values = column.values;
		switch (column.type) {
			case "u32":
			case "i32":
			case "f64":
				return values[row]!;
			case "bool":
				// SAFETY: a bool column's values are its bitset.
				// Verified by: game-text-engine-batch.test.ts reads every column type back.
				return bit(values as Uint8Array, row);
			case "str":
				return this.text(values[row]!);
			case "json":
				return JSON.parse(this.text(values[row]!));
			case "u32List":
				return Array.from(column.items!.subarray(values[row], values[row + 1]));
			case "strList": {
				const items = column.items!.subarray(values[row], values[row + 1]);
				return Array.from(items, (index) => this.text(index));
			}
		}
	}
}

/** Narrows a batch to the relation its part is read from. */
export const isRelation = <R extends RelationName>(
	batch: EngineBatch,
	relation: R
): batch is EngineBatch<R> => batch.relation === relation;
