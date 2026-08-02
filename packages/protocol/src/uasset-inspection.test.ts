import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeSavedAssetInspection } from "./uasset-inspection.js";

describe("saved asset inspection wire contract", () => {
	it("decodes a complete empty inspection", async () => {
		const inspection = await Effect.runPromise(
			decodeSavedAssetInspection({
				assets: [],
				decode_errors: [],
				package: {
					name: "/Game/Example",
					package_flags: 0,
					summary_size: 64,
					total_header_size: 128,
					version: {
						legacy_file: 0,
						legacy_ue3: 0,
						ue4: 1,
						ue5: 0,
						licensee: 0
					}
				},
				path: "Content/Example.uasset",
				schema_version: 8,
				status: "ok"
			})
		);
		expect(inspection.status).toBe("ok");
		expect(inspection.assets).toHaveLength(0);
	});

	it("rejects an inspection with an unknown asset kind", async () => {
		const result = await Effect.runPromise(
			Effect.result(
				decodeSavedAssetInspection({
					assets: [{ kind: "Unknown", object_path: "/Game/Example" }],
					decode_errors: [],
					package: {
						name: "/Game/Example",
						package_flags: 0,
						summary_size: 64,
						total_header_size: 128,
						version: {
							legacy_file: 0,
							legacy_ue3: 0,
							ue4: 1,
							ue5: 0,
							licensee: 0
						}
					},
					path: "Content/Example.uasset",
					schema_version: 8,
					status: "ok"
				})
			)
		);
		expect(result._tag).toBe("Failure");
	});
});
