/** Differential oracle for the native parser: authored input stays in test-owned files. */
import { readFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { localizationColumnsBuilder } from "../packages/game-text/src/localization-columns.ts";
import { defaultLocalizationImportLimits } from "../packages/game-text/src/localization-stream.ts";
import type { LocalizationImportOptions } from "../packages/game-text/src/localization-columns.ts";

let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const cases: { path: string; options: LocalizationImportOptions }[] = JSON.parse(input);
const output = [];
const root = resolve("target/localization-oracle", String(process.pid));
await mkdir(root, { recursive: true });
try {
	for (const [index, item] of cases.entries()) {
		const builder = localizationColumnsBuilder(
			"input",
			resolve(root, String(index)),
			item.options,
			defaultLocalizationImportLimits
		);
		try {
			const bytes = await readFile(item.path);
			const utf16 = item.options.format !== "po" && bytes[0] === 255 && bytes[1] === 254;
			const bom = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
			let text: string;
			try {
				text = new TextDecoder(utf16 ? "utf-16le" : "utf-8", {
					fatal: true,
					ignoreBOM: true
				}).decode(bytes.subarray(utf16 ? 2 : bom ? 3 : 0));
			} catch {
				const { importFailure } = await import("../packages/game-text/src/localization-stream.ts");
				throw importFailure("input", "invalid_encoding", ` at byte offset ${Math.min(bytes.length, 256 * 1024)}`);
			}
			builder.feed(text);
			const source = await builder.finish();
			const columns = [];
			for (const column of source.columns) {
				const data = await column.load();
				columns.push({
					name: column.name,
					kind: column.kind,
					domain: column.domain ?? "",
					strings: column.stringCount ?? 0,
					bytes: Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
				});
			}
			output.push({ columns });
		} catch (cause) {
			// The reference parser owns the authored diagnostics; strip only the Effect tag.
			const { code, message, recovery, retrySafe, nextStep } = cause as {
				code: string; message: string; recovery: string; retrySafe: boolean; nextStep: string;
			};
			output.push({ error: { code, message, recovery, retrySafe, nextStep } });
		} finally {
			builder.close();
		}
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(output));
