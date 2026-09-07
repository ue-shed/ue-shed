import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	actorCopyDetails,
	readActorFilterPresets,
	writeActorFilterPreset
} from "./actor-explorer-utilities.js";

describe("actor filter persistence", () => {
	it("preserves all versus no classes, updates by name, and deletes only the requested preset", async () => {
		let value: string | null = null;
		const storage = {
			getItem: () => value,
			setItem: (_key: string, text: string) => {
				value = text;
			}
		};
		await Effect.runPromise(
			writeActorFilterPreset(storage, " All ", { query: "light", classPaths: undefined })
		);
		await Effect.runPromise(
			writeActorFilterPreset(storage, "None", { query: "", classPaths: [] })
		);
		expect(await Effect.runPromise(readActorFilterPresets(storage))).toEqual([
			{ name: "All", query: "light" },
			{ name: "None", query: "", classPaths: [] }
		]);
		await Effect.runPromise(
			writeActorFilterPreset(storage, "All", {
				query: "label:sun",
				classPaths: ["Light", "Sky"]
			})
		);
		await Effect.runPromise(writeActorFilterPreset(storage, "None", undefined));
		expect(await Effect.runPromise(readActorFilterPresets(storage))).toEqual([
			{ name: "All", query: "label:sun", classPaths: ["Light", "Sky"] }
		]);
	});
	it("preserves corrupt storage and reports unavailable storage", async () => {
		let writes = 0;
		const storage = {
			getItem: () => "corrupted",
			setItem: () => {
				writes++;
			}
		};
		await expect(
			Effect.runPromise(
				writeActorFilterPreset(storage, "New", { query: "", classPaths: undefined })
			)
		).rejects.toThrow("preserved");
		expect(writes).toBe(0);
		await expect(
			Effect.runPromise(
				writeActorFilterPreset(
					{
						getItem: () => null,
						setItem: () => {
							throw new Error("quota");
						}
					},
					"New",
					{ query: "", classPaths: undefined }
				)
			)
		).rejects.toThrow("Could not save");
	});
	it("copies only available identity and finite coordinates", () => {
		const item = {
			key: "runtime-key",
			classPath: "Light",
			label: "Sun",
			path: "/Game/Map.Sun",
			packageName: undefined
		};
		expect(actorCopyDetails(item)).toEqual([{ label: "path", value: item.path }]);
		expect(
			actorCopyDetails({
				...item,
				actorGuid: "authored-guid",
				location: { x: 1, y: -2, z: 3 }
			})
		).toContainEqual({ label: "coordinates", value: "X=1 Y=-2 Z=3" });
		expect(actorCopyDetails({ ...item, location: { x: NaN, y: 0, z: 0 } })).toHaveLength(1);
	});
});
