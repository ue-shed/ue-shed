import { performance } from "node:perf_hooks";
import { Result } from "effect";
import { expect, it } from "vitest";
import { parseArchive } from "./json-formats.js";
import { parsePO } from "./po.js";

it("parses 50,000 generated PO and archive entries within a generous regression budget", () => {
	const count = 50_000;
	const entries = Array.from({ length: count }, (_, index) => ({
		key: `Key${String(index).padStart(6, "0")}`,
		source: `Source ${index}\u2028: ${"Continue along the road. ".repeat(10)}`,
		translation: `Translation ${index}: ${"Follow the path. ".repeat(6)}`
	}));
	const po = new TextEncoder().encode(
		"\uFEFF" +
			entries
				.map(
					(entry) =>
						`#. Key: ${entry.key}\r\n#: /Game/Generated/Table.Table\r\nmsgctxt "Generated,${entry.key}"\r\nmsgid ""\r\n"${entry.source.slice(0, 120)}"\r\n"${entry.source.slice(120)}"\r\nmsgstr "${entry.translation}"\r\n\r\n`
				)
				.join("")
	);
	const archive = new TextEncoder().encode(
		JSON.stringify({
			FormatVersion: 2,
			Namespace: "Generated",
			Children: entries.map((entry) => ({
				Key: entry.key,
				Source: { Text: entry.source },
				Translation: { Text: entry.translation }
			}))
		})
	);
	const start = performance.now();
	const document = parsePO(po);
	const translations = parseArchive(archive);
	expect(Result.isSuccess(document)).toBe(true);
	expect(Result.isSuccess(translations)).toBe(true);
	if (Result.isSuccess(document) && Result.isSuccess(translations)) {
		expect(document.success.blocks).toHaveLength(count);
		expect(translations.success.entries).toHaveLength(count);
		expect(document.success.blocks[0]?.entry?.msgid).toBe(entries[0]?.source);
		expect(translations.success.entries.at(-1)?.translation.Text).toBe(
			entries.at(-1)?.translation
		);
	}
	expect(performance.now() - start).toBeLessThan(10_000);
}, 20_000);
