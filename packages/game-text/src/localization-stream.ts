import { Schema } from "effect";
import { LocalizationError, LocalizationLimits, type POLine } from "@ue-shed/localization";

const Positive = Schema.Int.check(Schema.isGreaterThan(0));
export const LocalizationImportLimits = LocalizationLimits.pipe(
	Schema.fieldsAssign({ maxRecordBytes: Positive, maxIdentityBytes: Positive })
);
export type LocalizationImportLimits = typeof LocalizationImportLimits.Type;
export const defaultLocalizationImportLimits: LocalizationImportLimits = Object.freeze({
	maxFileBytes: 16 * 1024 ** 3,
	maxEntries: 4_000_000,
	maxDepth: 64,
	maxFiles: 2560,
	maxRecordBytes: 4 * 1024 ** 2,
	maxIdentityBytes: 512 * 1024 ** 2
});
export function importFailure(
	file: string,
	code: LocalizationError["code"],
	location = ""
): LocalizationError {
	return new LocalizationError({
		code,
		message:
			code === "file_changed"
				? `${file}${location}: file changed during import; retry after writing finishes.`
				: `${file}${location}: localization import failed (${code}).`,
		recovery:
			code === "limit_exceeded"
				? "Reduce the input or explicitly increase the bounded localization import limits."
				: "Check the saved file and target configuration, then retry the import."
	});
}
interface Frame {
	readonly array: boolean;
	readonly mode: "value" | "node" | "children" | "nodes";
	readonly node: number;
	readonly value: Record<string, Schema.Json> | Schema.Json[];
	state: "key" | "colon" | "value" | "comma" | "first";
	key: string;
	bytes: number;
}
export interface ImportNamespace {
	readonly parent: number;
	name: string;
}

/** SAX-style JSON grammar. Only one Children element is materialized; tree arrays are detached. */
export function localizationJsonStream(
	file: string,
	limits: LocalizationImportLimits,
	child: (value: Schema.Json, node: number, offset: number) => void
) {
	const frames: Frame[] = [];
	const nodes: ImportNamespace[] = [];
	let rootDone = false;
	let version: Schema.Json | undefined;
	const isString = Schema.is(Schema.String);
	let offset = 0;
	let token = "";
	let quoted = false;
	let escaped = false;
	let invalidSchema = false;
	let nodeBytes = 0;
	const structural = /[{}[\]"]/gu;
	const whitespace = /[ \t\r\n]+/uy;
	let record: { raw: string; depth: number; quoted: boolean; escaped: boolean } | undefined;
	function fail(code: LocalizationError["code"] = "malformed_json"): never {
		throw importFailure(file, code, ` at character offset ${offset}`);
	}
	function charge(size: number) {
		for (let i = frames.length - 1; i >= 0; i--) {
			const frame = frames[i]!;
			if (frame.mode !== "value") break;
			frame.bytes += size;
			if (frame.bytes > limits.maxRecordBytes) fail("limit_exceeded");
		}
	}
	function accept(value: Schema.Json) {
		if (frames.length > limits.maxDepth) fail("limit_exceeded");
		const frame = frames.at(-1);
		if (!frame) {
			if (rootDone) fail();
			rootDone = true;
			return;
		}
		if (frame.state !== "value" && !(frame.array && frame.state === "first")) fail();
		if (frame.mode === "children") child(value, frame.node, offset);
		else if (frame.mode === "node") {
			if (frame.key === "Namespace") {
				if (!isString(value)) invalidSchema = true;
				else {
					nodeBytes += (value.length - nodes[frame.node]!.name.length) * 5;
					if (nodeBytes > limits.maxIdentityBytes) fail("limit_exceeded");
					nodes[frame.node]!.name = value;
				}
			} else if (frame.key === "FormatVersion" && frame.node === 0) version = value;
			else if (frame.key === "Children" || frame.key === "Subnamespaces") {
				if (!Array.isArray(value)) invalidSchema = true;
			}
		} else if (frame.mode === "nodes") {
			invalidSchema = true;
		} else if (Array.isArray(frame.value)) frame.value.push(value);
		else
			Object.defineProperty(frame.value, frame.key, {
				value,
				writable: true,
				enumerable: true,
				configurable: true
			});
		frame.state = "comma";
	}
	function emit(value: Schema.Json, punctuation = "") {
		const frame = frames.at(-1);
		if (punctuation === "{" || punctuation === "[") {
			if (frame && frame.state !== "value" && !(frame.array && frame.state === "first"))
				fail();
			if (!frame && rootDone) fail();
			if (frames.length > limits.maxDepth) fail("limit_exceeded");
			let mode: Frame["mode"] = "value";
			let node = frame?.node ?? -1;
			if (!frame || frame.mode === "nodes") {
				if (punctuation !== "{") invalidSchema = true;
				else {
					mode = "node";
					node = nodes.length;
					nodeBytes += 128;
					if (node >= limits.maxEntries || nodeBytes > limits.maxIdentityBytes)
						fail("limit_exceeded");
					nodes.push({ parent: frame?.node ?? -1, name: "" });
				}
			} else if (frame.mode === "node" && ["Children", "Subnamespaces"].includes(frame.key)) {
				if (punctuation !== "[") invalidSchema = true;
				else mode = frame.key === "Children" ? "children" : "nodes";
			}
			frames.push({
				array: punctuation === "[",
				mode,
				node,
				value: punctuation === "[" ? [] : {},
				state: "first",
				key: "",
				bytes: 0
			});
			return;
		}
		if (punctuation === "}" || punctuation === "]") {
			if (
				!frame ||
				frame.array !== (punctuation === "]") ||
				(frame.state !== "first" && frame.state !== "comma")
			)
				fail();
			if (frame.mode === "node" && !Object.hasOwn(frame.value, "namespaceSeen"))
				invalidSchema = true;
			frames.pop();
			const parent = frames.at(-1);
			if (frame.mode === "node" && parent?.mode === "nodes") parent.state = "comma";
			else accept(frame.mode === "node" ? null : frame.value);
			return;
		}
		if (punctuation === ",") {
			if (!frame || frame.state !== "comma") fail();
			frame.state = frame.array ? "value" : "key";
			return;
		}
		if (punctuation === ":") {
			if (!frame || frame.state !== "colon") fail();
			frame.state = "value";
			return;
		}
		if (frame && !frame.array && (frame.state === "key" || frame.state === "first")) {
			if (!isString(value)) fail();
			frame.key = value;
			if (frame.mode === "node" && value === "Namespace")
				Object.defineProperty(frame.value, "namespaceSeen", {
					value: true,
					configurable: true
				});
			frame.state = "colon";
			return;
		}
		accept(value);
	}
	function finishToken() {
		let value: Schema.Json;
		try {
			value = JSON.parse(token);
		} catch {
			fail();
		}
		emit(value);
		token = "";
	}
	return {
		nodes,
		feed(text: string) {
			// oxlint-disable-next-line no-control-regex -- JSON rejects raw controls inside strings.
			const stops = /["\\\u0000-\u001f]/gu;
			for (let index = 0; index < text.length; index++) {
				const character = text[index]!;
				offset++;
				if (record) {
					const current = record;
					const start = index;
					let end = index;
					while (end < text.length) {
						if (current.quoted) {
							if (current.escaped) {
								current.escaped = false;
								end++;
								continue;
							}
							stops.lastIndex = end;
							const stop = stops.exec(text);
							if (!stop) {
								end = text.length;
								break;
							}
							end = stop.index + 1;
							if (stop[0] === "\\") current.escaped = true;
							else if (stop[0] === '"') current.quoted = false;
							else fail();
						} else {
							structural.lastIndex = end;
							const stop = structural.exec(text);
							const next = stop?.index ?? text.length;
							if (
								frames.length + current.depth > limits.maxDepth &&
								/[^:, \t\r\n]/u.test(text.slice(end, next))
							)
								fail("limit_exceeded");
							if (!stop) {
								end = text.length;
								break;
							}
							end = next + 1;
							if (stop[0] === '"') {
								if (frames.length + current.depth > limits.maxDepth)
									fail("limit_exceeded");
								current.quoted = true;
							} else if (stop[0] === "{" || stop[0] === "[") {
								current.depth++;
								if (frames.length + current.depth - 1 > limits.maxDepth)
									fail("limit_exceeded");
							} else if (--current.depth === 0) break;
						}
					}
					current.raw += text.slice(start, end);
					offset += end - index - 1;
					index = end - 1;
					if (current.raw.length * 2 > limits.maxRecordBytes) fail("limit_exceeded");
					if (current.depth === 0) {
						let value: Schema.Json;
						try {
							value = JSON.parse(current.raw);
						} catch {
							fail();
						}
						record = undefined;
						accept(value);
					}
					continue;
				}
				if (!quoted && !token && /[ \t\r\n]/u.test(character)) {
					whitespace.lastIndex = index;
					const length = whitespace.exec(text)![0].length;
					charge(length * 2);
					offset += length - 1;
					index += length - 1;
					continue;
				}
				const parent = frames.at(-1);
				if (
					!quoted &&
					(character === "{" || character === "[") &&
					parent?.mode === "children"
				) {
					if (token || (parent.state !== "first" && parent.state !== "value")) fail();
					if (frames.length > limits.maxDepth) fail("limit_exceeded");
					record = { raw: character, depth: 1, quoted: false, escaped: false };
					continue;
				}
				charge(2);
				if (quoted) {
					if (escaped) {
						token += character;
						escaped = false;
					} else if (character === "\\") {
						token += character;
						escaped = true;
					} else if (character === '"') {
						token += character;
						quoted = false;
						finishToken();
					} else {
						if (character.charCodeAt(0) < 32) fail();
						stops.lastIndex = index + 1;
						const end = stops.exec(text)?.index ?? text.length;
						token += text.slice(index, end);
						charge((end - index - 1) * 2);
						offset += end - index - 1;
						index = end - 1;
					}
				} else if (character === '"') {
					if (token) fail();
					quoted = true;
					token = character;
				} else if ("{}[],: \t\r\n".includes(character)) {
					if (token) finishToken();
					if ("{}[],:".includes(character)) emit(null, character);
				} else token += character;
				if (token.length * 2 > limits.maxRecordBytes) fail("limit_exceeded");
			}
		},
		finish(expectedVersion: number) {
			if (quoted || record) fail();
			if (token) finishToken();
			if (frames.length || !rootDone) fail();
			if (!Number.isInteger(version)) fail("invalid_schema");
			if (version !== expectedVersion) fail("unsupported_version");
			if (invalidSchema) fail("invalid_schema");
			const namespaces: string[] = [];
			let resolvedBytes = 0;
			return nodes.map((node, index) => {
				// Nodes are opened in preorder, even when Namespace comes after Children.
				const parent = node.parent < 0 ? "" : namespaces[node.parent]!;
				const namespace = parent === "" ? node.name : `${parent}.${node.name}`;
				resolvedBytes += 128 + namespace.length * 5;
				if (resolvedBytes > limits.maxIdentityBytes || index >= limits.maxEntries)
					fail("limit_exceeded");
				namespaces.push(namespace);
				return namespace;
			});
		}
	};
}

/** Physical CR/LF lines only: U+2028/U+2029 are ordinary PO string content. */
export function localizationPOStream(
	file: string,
	limits: LocalizationImportLimits,
	block: (lines: readonly POLine[], firstLine: number) => void
) {
	let pending = "";
	let lines: POLine[] = [];
	let blockBytes = 0;
	let line = 1;
	let firstLine = 1;
	let finished = false;
	let blank = false;
	let blocks = 0;
	function flush() {
		if (!lines.length) return;
		if (++blocks > limits.maxEntries)
			throw importFailure(file, "limit_exceeded", ` at line ${firstLine}`);
		block(lines, firstLine);
		lines = [];
		blockBytes = 0;
		firstLine = line;
		finished = false;
	}
	function physical(value: string, ending: POLine["ending"]) {
		const trimmed = value.trim();
		if (
			trimmed !== "" &&
			(blank || (finished && (trimmed.startsWith("#") || /^msg(?:ctxt|id)\s/u.test(trimmed))))
		)
			flush();
		lines.push({ text: value, ending });
		blockBytes += (value.length + ending.length) * 2;
		blank = trimmed === "";
		if (/^msgstr(?:\[\d+\])?\s/u.test(trimmed)) finished = true;
		line++;
		if (blockBytes > limits.maxRecordBytes)
			throw importFailure(file, "limit_exceeded", ` at line ${firstLine}`);
	}
	return {
		feed(chunk: string, final = false) {
			pending += chunk;
			let start = 0;
			const endings = /[\r\n]/gu;
			for (let match = endings.exec(pending); match; match = endings.exec(pending)) {
				let end = match.index + 1;
				if (match[0] === "\r" && end === pending.length && !final) break;
				let ending: POLine["ending"] = match[0] === "\r" ? "\r" : "\n";
				if (ending === "\r" && pending[end] === "\n") {
					end++;
					ending = "\r\n";
				}
				physical(pending.slice(start, match.index), ending);
				start = end;
				endings.lastIndex = end;
			}
			pending = pending.slice(start);
			if (pending.length * 2 > limits.maxRecordBytes)
				throw importFailure(file, "limit_exceeded", ` at line ${line}`);
			if (final) {
				if (pending) physical(pending, "");
				pending = "";
				flush();
			}
		}
	};
}
