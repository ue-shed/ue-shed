import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { connectUnrealAuthoring, RemoteControlClientLive } from "./index.js";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;

describe.skipIf(!endpoint)("real Unreal Remote Control authoring", () => {
	it("negotiates capabilities and reads the fixture table", async () => {
		const connection = await Effect.runPromise(
			connectUnrealAuthoring(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
		);
		const snapshot = await Effect.runPromise(
			connection.getTableSnapshot("/Game/Fixture/Authoring/DT_Scalars.DT_Scalars")
		);
		expect(snapshot.table.rows.length).toBeGreaterThan(0);
		expect(snapshot.authority.kind).toBe("live_editor");
	});
});
