import { deepStrictEqual } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Schema } from "effect";
import { WorldRequest, WorldResponse } from "../src/schema.js";

const directory = fileURLToPath(
	new URL("../../protocol/contracts/world/preparation/v1/", import.meta.url)
);
for (const [name, schema] of Object.entries({ request: WorldRequest, response: WorldResponse })) {
	const document = Schema.toJsonSchemaDocument(schema);
	deepStrictEqual(JSON.parse(readFileSync(join(directory, `${name}.schema.json`), "utf8")), {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: `https://ue-shed.dev/contracts/world/preparation/v1/${name}.schema.json`,
		...document.schema,
		$defs: document.definitions
	});
}
for (const file of readdirSync(join(directory, "fixtures"))) {
	const input: unknown = JSON.parse(readFileSync(join(directory, "fixtures", file), "utf8"));
	const result = Schema.decodeUnknownResult(WorldRequest)(input, { onExcessProperty: "error" });
	deepStrictEqual(result._tag, file.startsWith("invalid-") ? "Failure" : "Success", file);
}
