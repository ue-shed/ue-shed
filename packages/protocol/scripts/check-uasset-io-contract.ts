import { deepStrictEqual } from "node:assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { UAssetIoEvent, UAssetIoRequest, makeUAssetIoJsonSchema } from "../src/uasset-io.js";

for (const [name, contract] of [
	["request", UAssetIoRequest],
	["event", UAssetIoEvent]
] as const) {
	const path = fileURLToPath(
		new URL("../contracts/uasset-io/v1/" + name + ".schema.json", import.meta.url)
	);
	const authoritative: unknown = JSON.parse(await readFile(path, "utf8"));
	try {
		deepStrictEqual(authoritative, makeUAssetIoJsonSchema(contract));
	} catch {
		throw new Error("uasset-io/v1 " + name + " runtime schema does not match the JSON Schema");
	}
}
