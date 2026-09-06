import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
	WorkbenchUnrealConnection,
	makeWorkbenchUnrealConnectionLayer
} from "./unreal-connection.js";

it.effect("changes the selected Remote Control port without replacing the endpoint host", () =>
	Effect.gen(function* () {
		const connection = yield* WorkbenchUnrealConnection;
		expect(yield* connection.settings()).toEqual({
			endpoint: "http://127.0.0.1:30001",
			port: 30001
		});

		expect(yield* connection.setPort(31001)).toEqual({
			endpoint: "http://127.0.0.1:31001/",
			port: 31001
		});
		expect(yield* connection.endpoint()).toBe("http://127.0.0.1:31001/");
	}).pipe(Effect.provide(makeWorkbenchUnrealConnectionLayer("http://127.0.0.1:30001")))
);
