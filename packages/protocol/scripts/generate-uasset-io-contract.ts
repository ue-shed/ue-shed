import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { UAssetIoEvent, UAssetIoRequest, makeUAssetIoJsonSchema } from "../src/uasset-io.js";

for (const [name, contract] of [
	["request", UAssetIoRequest],
	["event", UAssetIoEvent]
] as const) {
	const path = fileURLToPath(
		new URL("../contracts/uasset-io/v1/" + name + ".schema.json", import.meta.url)
	);
	await writeFile(path, JSON.stringify(makeUAssetIoJsonSchema(contract), null, 2) + "\n", "utf8");
}
