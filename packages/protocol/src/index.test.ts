import { describe, expect, it } from "vitest";

import {
	CURRENT_PROTOCOL_VERSION,
	IdentifierValidationError,
	createActorId,
	createCapabilityId
} from "./index.js";

describe("protocol identifiers", () => {
	it("normalizes external identifiers at creation", () => {
		expect(createActorId("  fixture.actor.1  ")).toBe("fixture.actor.1");
		expect(createCapabilityId("observatory.actors.live")).toBe("observatory.actors.live");
	});

	it("rejects empty external identifiers", () => {
		expect(() => createActorId("   ")).toThrow(IdentifierValidationError);
	});
});

describe("protocol compatibility", () => {
	it("starts explicitly at a pre-release protocol version", () => {
		expect(CURRENT_PROTOCOL_VERSION).toEqual({ major: 0, minor: 1 });
	});
});
