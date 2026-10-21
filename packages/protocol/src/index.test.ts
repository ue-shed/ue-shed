import { Effect } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
	IdentifierValidationError,
	decodeActorId,
	createActorId,
	createCapabilityId,
	type ActorId,
	type CapabilityId
} from "./index.js";

describe("protocol identifiers", () => {
	it("normalizes external identifiers at creation", () => {
		expect(createActorId("  fixture.actor.1  ")).toBe("fixture.actor.1");
		expect(createCapabilityId("observatory.actors.live")).toBe("observatory.actors.live");
	});

	it("rejects empty external identifiers", () => {
		expect(() => createActorId("   ")).toThrow(IdentifierValidationError);
	});

	it("reports malformed unknown input through the typed error channel", async () => {
		const error = await Effect.runPromise(decodeActorId("   ").pipe(Effect.flip));
		expect(error._tag).toBe("IdentifierValidationError");
		expect(error.kind).toBe("actor");
	});

	it("keeps identifier brands distinct", () => {
		expectTypeOf<ActorId>().not.toEqualTypeOf<CapabilityId>();
	});
});
