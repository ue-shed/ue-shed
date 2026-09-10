import { deepStrictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { CameraBridgeRequest, CameraBridgeResponse } from "../src/camera-authoring-bridge.js";
import { CameraArrangement, CameraArrangementCommand } from "../src/camera-arrangement.js";
import { CameraAuthoringDocument } from "../src/camera-authoring-store.js";

const contracts = {
	"bridge-request": CameraBridgeRequest,
	"bridge-response": CameraBridgeResponse,
	arrangement: CameraArrangement,
	command: CameraArrangementCommand,
	document: CameraAuthoringDocument
};
for (const [name, schema] of Object.entries(contracts)) {
	const document = Schema.toJsonSchemaDocument(schema);
	deepStrictEqual(
		JSON.parse(
			readFileSync(
				new URL(
					`../../protocol/contracts/cameras/authoring/v1/${name}.schema.json`,
					import.meta.url
				),
				"utf8"
			)
		),
		{
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$id: `https://ue-shed.dev/contracts/cameras/authoring/v1/${name}.schema.json`,
			...document.schema,
			$defs: document.definitions
		},
		`${name} differs from the checked-in authoring contract`
	);
}
