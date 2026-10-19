import { Schema } from "effect";
import { assertJsonSchemaEquivalent as deepStrictEqual } from "../../../scripts/canonical-json-schema.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AutomationCsvRequest,
	AutomationCsvResult,
	AutomationInputRequest,
	AutomationInputResult,
	AutomationPlayersRequest,
	AutomationPlayersResult
} from "../src/automation.js";
import {
	AuthoringActorReferencesRequest,
	AuthoringActorReferencesResult
} from "../src/authoring-actor-references.js";
import { makeAuthoringJsonSchema } from "../src/authoring.js";
import { EditorAssetOpenResult } from "../src/editor-asset-open.js";
import {
	GameTextActionsRequest,
	GameTextActionsResult,
	StringTableRedirectRequest,
	StringTableRedirectResult
} from "../src/game-text-actions.js";

const contracts = [
	["editor-asset-open", "result", EditorAssetOpenResult],
	["automation", "players-request", AutomationPlayersRequest],
	["automation", "players-result", AutomationPlayersResult],
	["automation", "input-request", AutomationInputRequest],
	["automation", "input-result", AutomationInputResult],
	["automation", "csv-request", AutomationCsvRequest],
	["automation", "csv-result", AutomationCsvResult],
	["authoring", "actor-references-request", AuthoringActorReferencesRequest],
	["authoring", "actor-references-result", AuthoringActorReferencesResult],
	["game-text", "actions-request", GameTextActionsRequest],
	["game-text", "actions-result", GameTextActionsResult],
	["game-text", "redirect-request", StringTableRedirectRequest],
	["game-text", "redirect-result", StringTableRedirectResult]
] as const;

for (const [domain, name, contract] of contracts) {
	const path = fileURLToPath(
		new URL(`../contracts/${domain}/v1/${name}.schema.json`, import.meta.url)
	);
	const runtime = makeAuthoringJsonSchema(contract);
	if (process.argv.includes("--write")) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(runtime, null, 2) + "\n", "utf8");
	} else {
		const authoritative = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
			JSON.parse(await readFile(path, "utf8"))
		);
		deepStrictEqual(authoritative, runtime, `${domain}/${name} contract drifted`);
	}
}
