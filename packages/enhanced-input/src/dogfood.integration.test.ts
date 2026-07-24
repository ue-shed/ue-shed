import { join } from "node:path";
import { assetReaderLayer } from "@ue-shed/unreal-assets";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	EnhancedInputService,
	EnhancedInputServiceLive,
	inputActionFromInspection,
	mappingContextFromInspection
} from "./index.js";
import { AssetReader } from "@ue-shed/unreal-assets";

const dogfoodRoot = process.env.UE_SHED_INPUT_DOGFOOD_ROOT;
const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

describe.skipIf(!dogfoodRoot || !executable)("Enhanced Input local dogfood", () => {
	it("projects the configured IA_Submit and IMC_MinigameInput packages", async () => {
		const readerLayer = assetReaderLayer({ executable: executable! });
		const report = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* EnhancedInputService;
				return {
					submit: yield* service.inspectPath(join(dogfoodRoot!, "IA_Submit.uasset")),
					mapping: yield* service.inspectPath(
						join(dogfoodRoot!, "IMC_MinigameInput.uasset")
					)
				};
			}).pipe(Effect.provide(EnhancedInputServiceLive), Effect.provide(readerLayer))
		);

		expect(report.submit.coverage.inputActions).toBe(1);
		expect(report.submit.actions[0]?.objectPath).toContain("IA_Submit");
		expect(report.submit.actions[0]?.valueType.status).toBe("unavailable");
		expect(report.submit.actions[0]?.consumeInput.status).toBe("unavailable");

		expect(report.mapping.coverage.mappingContexts).toBe(1);
		const context = report.mapping.mappingContexts[0];
		expect(context?.mappingsProperty).toBe("Mappings");
		expect((context?.mappings.length ?? 0) > 0).toBe(true);
		expect(
			context?.mappings.some(
				(mapping) =>
					mapping.keyName.status === "available" && mapping.keyName.value === "SpaceBar"
			)
		).toBe(true);
		expect(context?.exports.some((item) => item.classPath.includes("InputModifier"))).toBe(
			true
		);

		const inspections = await Effect.runPromise(
			Effect.gen(function* () {
				const assets = yield* AssetReader;
				return {
					submit: yield* assets.readAsset(join(dogfoodRoot!, "IA_Submit.uasset")),
					mapping: yield* assets.readAsset(join(dogfoodRoot!, "IMC_MinigameInput.uasset"))
				};
			}).pipe(Effect.provide(readerLayer))
		);
		expect(
			inputActionFromInspection({
				inspection: inspections.submit,
				packageFile: "IA_Submit.uasset"
			})?.classPath
		).toBe("/Script/EnhancedInput.InputAction");
		expect(
			mappingContextFromInspection({
				inspection: inspections.mapping,
				packageFile: "IMC_MinigameInput.uasset"
			})?.mappingsProperty
		).toBe("Mappings");
	});
});
