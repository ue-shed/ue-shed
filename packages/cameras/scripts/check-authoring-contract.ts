import { CameraVisibilityPreset } from "../src/camera-visibility.js";
import { deepStrictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { Schema } from "effect";
import { CameraBridgeRequest, CameraBridgeResponse } from "../src/camera-authoring-bridge.js";
import { CameraArrangement, CameraArrangementCommand } from "../src/camera-arrangement.js";
import { CameraArrangementRecipe } from "../src/camera-arrangement.js";
import { CameraPanelState, CameraPanelEvent } from "../src/camera-authoring-panel-schema.js";
import { CameraApproval, CameraAuthoringDocument } from "../src/camera-authoring-store.js";

const contracts = {
	"visibility-preset": CameraVisibilityPreset,
	"bridge-request": CameraBridgeRequest,
	"bridge-response": CameraBridgeResponse,
	arrangement: CameraArrangement,
	command: CameraArrangementCommand,
	recipe: CameraArrangementRecipe,
	"panel-event": CameraPanelEvent,
	"panel-state": CameraPanelState,
	approval: CameraApproval,
	document: CameraAuthoringDocument
};
for (const [name, schema] of Object.entries(contracts)) {
	const document = Schema.toJsonSchemaDocument(schema);
	const generated = {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: `https://ue-shed.dev/contracts/cameras/authoring/v1/${name}.schema.json`,
		...document.schema,
		$defs: document.definitions
	};
	if (process.argv.includes("--write"))
		writeFileSync(
			new URL(
				`../../protocol/contracts/cameras/authoring/v1/${name}.schema.json`,
				import.meta.url
			),
			`${JSON.stringify(generated, null, "\t")}\n`
		);
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
