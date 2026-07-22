import { describe, expectTypeOf, it } from "vitest";
import type {
	AuthoringFieldDescriptor,
	AuthoringFieldValue,
	AuthoringTypeDescriptor,
	AuthoringValue
} from "./authoring.js";
import type {
	CameraDescriptor,
	CameraScheduleConfig,
	CameraStatus,
	CameraStreamStats
} from "./cameras.js";
import type {
	EditorPlaySessionCommandResponse,
	EditorPlaySessionStateResponse
} from "./editor-play-session.js";

/**
 * Public wire ownership inventory (Plan 022).
 *
 * - Derived schema types: Camera* and EditorPlaySession* wire values, plus ordinary authoring
 *   envelopes that use `Schema.Schema.Type`.
 * - Recursive Schema.suspend exceptions (manual type + bidirectional AssertExact in authoring.ts):
 *   AuthoringValue, AuthoringFieldValue, AuthoringTypeDescriptor, AuthoringFieldDescriptor.
 * - JSON-authoritative cross-language contracts: `contracts/authoring` and
 *   `contracts/cameras/review` (capture request/response + selection / subject-inspection response).
 *
 * TypeScript-owned Map Review persistence and Workbench IPC (ReviewSet, authoring session, live
 * preview DTOs) remain Effect-schema-first in `@ue-shed/cameras` and are not frozen into
 * language-neutral JSON while Plans 017–019 remain active.
 */
describe("public wire ownership inventory", () => {
	it("keeps recursive authoring exceptions named", () => {
		expectTypeOf<AuthoringValue>().not.toBeAny();
		expectTypeOf<AuthoringFieldValue>().not.toBeAny();
		expectTypeOf<AuthoringTypeDescriptor>().not.toBeAny();
		expectTypeOf<AuthoringFieldDescriptor>().not.toBeAny();
	});

	it("keeps ordinary protocol camera and play-session wire types schema-derived", () => {
		expectTypeOf<CameraScheduleConfig>().not.toBeAny();
		expectTypeOf<CameraStreamStats>().not.toBeAny();
		expectTypeOf<CameraDescriptor>().not.toBeAny();
		expectTypeOf<CameraStatus>().not.toBeAny();
		expectTypeOf<EditorPlaySessionStateResponse>().not.toBeAny();
		expectTypeOf<EditorPlaySessionCommandResponse>().not.toBeAny();
	});
});
