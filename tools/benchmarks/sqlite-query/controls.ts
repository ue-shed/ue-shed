import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fact } from "./sqlite.ts";

/** Planted semantic controls, independently authored rather than exported from the native engine. */
export const controlFacts: Fact[] = [
	["a", "", "Taluma é 中文 🙂"],
	["b", "UI", "Taluma é 中文 🙂"],
	["c", "UI", "taluma"],
	["d", "UI", "No matching word"],
	["e", "UI", "\ud800"],
	["f", "UI", "\udfff"],
	["g", "UI", "\u{f0001}"],
	["h", "UI", "\u{f0000}"],
	["i", "\ue000", "\ue000"],
	["j", "𐀀", "𐀀"],
	["k", "", "x".repeat(141)],
	["l", "", "🙂".repeat(71)],
	["m", "", "alpha\0beta"]
].map(([id, namespace, source], index) => ({
	id: id!,
	identity: { namespace: namespace!, key: id! },
	source: source!,
	audience: index % 2 ? "player" : "unknown",
	marks: [
		{
			culture: "de",
			state: index % 2 ? "not_translated" : "translated",
			translation: index % 2 ? "" : `de ${source}`
		}
	],
	places: [
		{
			packageFile: `Content/Text/Package${index}.uasset`,
			objectPath: `Object${index}`,
			origin: "data_table"
		}
	]
}));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (!process.argv[2]) throw new Error("controls.ts NEW_DIRECTORY");
	const root = resolve(process.argv[2]);
	await mkdir(root, { recursive: false });
	await writeFile(resolve(root, "facts.json"), JSON.stringify(controlFacts));
}
