import { deepStrictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import {
	NiagaraPreviewProducerReceipt,
	NiagaraPreviewProducerRequest,
	NiagaraPreviewRunManifest
} from "../src/schema.js";

const fixtureRoot = fileURLToPath(
	new URL("../../protocol/contracts/niagara/preview/v1/fixtures/", import.meta.url)
);

const contracts = [
	{ file: "request.json", schema: NiagaraPreviewProducerRequest },
	{ file: "receipt.json", schema: NiagaraPreviewProducerReceipt },
	{ file: "manifest.json", schema: NiagaraPreviewRunManifest }
] as const;

for (const contract of contracts) {
	const input: unknown = JSON.parse(readFileSync(join(fixtureRoot, contract.file), "utf8"));
	const decoded = Schema.decodeUnknownSync(contract.schema)(input);
	const encoded = Schema.encodeUnknownSync(contract.schema)(decoded);
	deepStrictEqual(encoded, input, `${contract.file} must round trip through Effect Schema`);
}

console.log(`Niagara preview contract parity: ${contracts.length} authoritative fixtures`);
