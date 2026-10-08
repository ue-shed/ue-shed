import { readFile, writeFile } from "node:fs/promises";
import { deepStrictEqual } from "node:assert";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import {
	AuthoringApplyRequest,
	AuthoringApplyResult,
	AuthoringEndpointError,
	AuthoringSaveRequest,
	AuthoringSaveResult,
	AuthoringTableList,
	AuthoringTableSnapshotV1,
	AuthoringTableSnapshotV2,
	makeAuthoringJsonSchema
} from "../src/authoring.js";

const contracts = [
	["v1", "table-snapshot", AuthoringTableSnapshotV1],
	["v2", "table-snapshot", AuthoringTableSnapshotV2],
	["v1", "table-list", AuthoringTableList],
	["v1", "apply-request", AuthoringApplyRequest],
	["v1", "apply-result", AuthoringApplyResult],
	["v1", "save-request", AuthoringSaveRequest],
	["v1", "save-result", AuthoringSaveResult],
	["v1", "endpoint-error", AuthoringEndpointError]
] as const satisfies readonly (readonly ["v1" | "v2", string, Schema.Top])[];

// `--write` regenerates the authoritative documents after an intentional contract change.
const write = process.argv.includes("--write");

const isJsonArray = Schema.is(Schema.Array(Schema.Json));
const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));
const decodeJson = Schema.decodeUnknownSync(Schema.Json);

/** Keep the existing document's key order so regenerated diffs show only contract changes. */
function inExistingOrder(generated: Schema.Json, existing: Schema.Json | undefined): Schema.Json {
	if (isJsonArray(generated)) {
		const previous = isJsonArray(existing) ? existing : [];
		return generated.map((item, index) => inExistingOrder(item, previous[index]));
	}
	if (!isJsonObject(generated)) return generated;
	const previous = isJsonObject(existing) ? existing : {};
	const keys = [
		...Object.keys(previous).filter((key) => key in generated),
		...Object.keys(generated).filter((key) => !(key in previous))
	];
	return Object.fromEntries(
		keys.flatMap((key) => {
			const value = generated[key];
			return value === undefined ? [] : [[key, inExistingOrder(value, previous[key])]];
		})
	);
}

for (const [version, name, contract] of contracts) {
	const path = fileURLToPath(
		new URL(`../contracts/authoring/${version}/${name}.schema.json`, import.meta.url)
	);
	const runtime = makeAuthoringJsonSchema(contract);
	if (write) {
		const existing = await readFile(path, "utf8").then(
			(text) => decodeJson(JSON.parse(text)),
			() => undefined
		);
		const ordered = inExistingOrder(decodeJson(runtime), existing);
		await writeFile(path, `${JSON.stringify(ordered, null, "\t")}\n`);
		continue;
	}
	const authoritative: unknown = JSON.parse(await readFile(path, "utf8"));
	try {
		deepStrictEqual(authoritative, runtime);
	} catch {
		throw new Error(
			`${version}/${name} runtime schema does not match the authoritative JSON Schema`
		);
	}
}
