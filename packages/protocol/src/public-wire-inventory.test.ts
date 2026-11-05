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
 * Public wire ownership: Camera*, EditorPlaySession* and ordinary authoring envelopes derive from
 * schemas; recursive authoring values and descriptors (Schema.suspend) keep manual types checked
 * by AssertExact in authoring.ts; `contracts/authoring` and `contracts/cameras/review` are JSON
 * authoritative. Map Review persistence and Workbench IPC stay Effect-schema-first in cameras.
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
