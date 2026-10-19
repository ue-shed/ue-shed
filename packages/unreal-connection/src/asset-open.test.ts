import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	makeRemoteControlClientTestLayer,
	openUnrealAsset,
	UnrealCapabilityError,
	UnrealConnectionError,
	type RemoteControlRequest
} from "./index.js";

const objectPath = "/Game/Fixture/ST_Text.ST_Text";
const navigationObjectPath = "/Script/UEShedCoreEditor.Default__UEShedEditorAssetNavigationLibrary";
const contract = { name: "unreal-editor-asset-open", version: { major: 1, minor: 0 } };

function runOpen(options: {
	readonly capabilities?: readonly string[];
	readonly navigationPath?: string | null;
	readonly reply?: Schema.Json;
	readonly bringToFront?: boolean;
}) {
	const calls: RemoteControlRequest[] = [];
	const manifest = {
		capabilities: [...(options.capabilities ?? ["editor.asset-open.v1"])],
		producerKind: "unreal_editor",
		schemaVersion: 1
	};
	const advertisedManifest =
		options.navigationPath === null
			? manifest
			: {
					...manifest,
					assetNavigationObjectPath: options.navigationPath ?? navigationObjectPath
				};
	const layer = makeRemoteControlClientTestLayer((request) => {
		calls.push(request);
		return Effect.succeed(
			request.functionName === "GetCapabilityManifest"
				? advertisedManifest
				: (options.reply ?? { contract, objectPath, status: "ok" })
		);
	});
	return {
		calls,
		result: openUnrealAsset({
			endpoint: "http://127.0.0.1:30010/",
			objectPath,
			bringToFront: options.bringToFront ?? false
		}).pipe(Effect.provide(layer))
	};
}

describe("asset-open capability adapter", () => {
	for (const bringToFront of [false, true]) {
		it(`negotiates and opens with bringToFront=${bringToFront}`, async () => {
			const { calls, result } = runOpen({ bringToFront });
			expect(await Effect.runPromise(result)).toEqual({ contract, objectPath, status: "ok" });
			expect(calls.map((call) => call.functionName)).toEqual([
				"GetCapabilityManifest",
				"OpenAsset"
			]);
			expect(calls[1]).toMatchObject({
				endpoint: "http://127.0.0.1:30010",
				objectPath: navigationObjectPath,
				parameters: { BringToFront: bringToFront, ObjectPath: objectPath },
				idempotent: false
			});
		});
	}

	for (const capabilities of [[], ["editor.asset-navigation.v1"]]) {
		it(`rejects missing open capability even with locate: ${capabilities}`, async () => {
			const { calls, result } = runOpen({ capabilities });
			const error = await Effect.runPromise(Effect.flip(result));
			expect(error).toBeInstanceOf(UnrealCapabilityError);
			expect(error).toMatchObject({ capability: "editor.asset-open.v1" });
			expect(calls).toHaveLength(1);
		});
	}

	it("rejects an open capability without its advertised endpoint", async () => {
		const { calls, result } = runOpen({ navigationPath: null });
		expect(await Effect.runPromise(Effect.flip(result))).toMatchObject({
			_tag: "UnrealCapabilityError",
			capability: "editor.asset-open.endpoint.v1"
		});
		expect(calls).toHaveLength(1);
	});

	for (const reason of ["asset_not_found", "asset_load_failed", "editor_refused"]) {
		it(`returns ${reason} as unavailable rather than a typed failure`, async () => {
			const reply = {
				contract,
				objectPath,
				status: "unavailable",
				reason,
				message: "Unreal could not open the asset.",
				recovery: "Inspect the asset in the connected project.",
				retrySafe: reason !== "editor_refused"
			};
			expect(await Effect.runPromise(runOpen({ reply }).result)).toEqual(reply);
		});
	}

	it("reports a locate reply as a typed result-contract failure", async () => {
		const { result } = runOpen({
			reply: {
				contract: { ...contract, name: "unreal-editor-asset-navigation" },
				objectPath,
				status: "located"
			}
		});
		const error = await Effect.runPromise(Effect.flip(result));
		expect(error).toBeInstanceOf(UnrealConnectionError);
		expect(error).toMatchObject({ operation: "asset opening", retrySafe: false });
	});
});
