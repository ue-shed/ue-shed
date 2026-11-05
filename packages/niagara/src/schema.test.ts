import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	NiagaraPreviewProducerReceipt,
	NiagaraPreviewProducerRequest,
	NiagaraPreviewRunManifest
} from "./schema.js";

const decodeJson = Schema.decodeUnknownSync(Schema.Json);
const decodeNiagaraPreviewProducerRequest = Schema.decodeUnknownSync(NiagaraPreviewProducerRequest);
const decodeNiagaraPreviewProducerRequestResult = Schema.decodeUnknownResult(
	NiagaraPreviewProducerRequest
);
const decodeNiagaraPreviewProducerReceipt = Schema.decodeUnknownSync(NiagaraPreviewProducerReceipt);
const decodeNiagaraPreviewRunManifest = Schema.decodeUnknownSync(NiagaraPreviewRunManifest);
const fixtures = fileURLToPath(
	new URL("../../protocol/contracts/niagara/preview/v1/fixtures/", import.meta.url)
);

async function fixture(name: string): Promise<Schema.Json> {
	return decodeJson(JSON.parse(await readFile(`${fixtures}/${name}`, "utf8")));
}

describe("Niagara preview wire contracts", () => {
	it("decodes the authoritative fixtures", async () => {
		expect(decodeNiagaraPreviewProducerRequest(await fixture("request.json"))).toMatchObject({
			systemObjectPath: "/Game/Fixture/Niagara/NS_Preview.NS_Preview"
		});
		expect(decodeNiagaraPreviewProducerReceipt(await fixture("receipt.json"))).toMatchObject({
			status: "complete"
		});
		expect(decodeNiagaraPreviewRunManifest(await fixture("manifest.json"))).toMatchObject({
			status: "complete"
		});
	});

	it("rejects a request whose total shape has invalid bounds", async () => {
		const request = decodeNiagaraPreviewProducerRequest(await fixture("request.json"));
		const invalid = { ...request, settings: { width: 16_384 } };
		expect(decodeNiagaraPreviewProducerRequestResult(invalid)._tag).toBe("Failure");
	});

	it("accepts hyphenated Unreal object names in the system object path", async () => {
		const request = decodeNiagaraPreviewProducerRequest(await fixture("request.json"));
		const hyphenated = {
			...request,
			systemObjectPath: "/Game/VFX/Combat/Blockout_Element.NS_GrassHit_Lv2-3"
		};
		expect(decodeNiagaraPreviewProducerRequest(hyphenated).systemObjectPath).toBe(
			"/Game/VFX/Combat/Blockout_Element.NS_GrassHit_Lv2-3"
		);
		const missingObject = {
			...request,
			systemObjectPath: "/Game/VFX/Combat/Blockout_Element"
		};
		expect(decodeNiagaraPreviewProducerRequestResult(missingObject)._tag).toBe("Failure");
	});
});
