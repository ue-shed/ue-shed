import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	NiagaraPreviewProducerReceipt,
	NiagaraPreviewProducerRequest,
	NiagaraPreviewRunManifest
} from "./schema.js";

const fixtures = fileURLToPath(
	new URL("../../protocol/contracts/niagara/preview/v1/fixtures/", import.meta.url)
);

async function fixture(name: string): Promise<Schema.Json> {
	return Schema.decodeUnknownSync(Schema.Json)(
		JSON.parse(await readFile(`${fixtures}/${name}`, "utf8"))
	);
}

describe("Niagara preview wire contracts", () => {
	it("decodes the authoritative fixtures", async () => {
		expect(
			Schema.decodeUnknownSync(NiagaraPreviewProducerRequest)(await fixture("request.json"))
		).toMatchObject({ systemObjectPath: "/Game/Fixture/Niagara/NS_Preview.NS_Preview" });
		expect(
			Schema.decodeUnknownSync(NiagaraPreviewProducerReceipt)(await fixture("receipt.json"))
		).toMatchObject({ status: "complete" });
		expect(
			Schema.decodeUnknownSync(NiagaraPreviewRunManifest)(await fixture("manifest.json"))
		).toMatchObject({ status: "complete" });
	});

	it("rejects a request whose total shape has invalid bounds", async () => {
		const request = Schema.decodeUnknownSync(NiagaraPreviewProducerRequest)(
			await fixture("request.json")
		);
		const invalid = { ...request, settings: { width: 16_384 } };
		expect(Schema.decodeUnknownResult(NiagaraPreviewProducerRequest)(invalid)._tag).toBe(
			"Failure"
		);
	});

	it("accepts hyphenated Unreal object names in the system object path", async () => {
		const request = Schema.decodeUnknownSync(NiagaraPreviewProducerRequest)(
			await fixture("request.json")
		);
		const hyphenated = {
			...request,
			systemObjectPath: "/Game/VFX/Combat/Blockout_Element.NS_GrassHit_Lv2-3"
		};
		expect(
			Schema.decodeUnknownSync(NiagaraPreviewProducerRequest)(hyphenated).systemObjectPath
		).toBe("/Game/VFX/Combat/Blockout_Element.NS_GrassHit_Lv2-3");
		const missingObject = {
			...request,
			systemObjectPath: "/Game/VFX/Combat/Blockout_Element"
		};
		expect(Schema.decodeUnknownResult(NiagaraPreviewProducerRequest)(missingObject)._tag).toBe(
			"Failure"
		);
	});
});
