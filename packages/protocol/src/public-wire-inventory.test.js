import { describe, expectTypeOf, it } from "vitest";
/**
 * Public wire ownership: Camera*, EditorPlaySession* and ordinary authoring envelopes derive from
 * schemas; recursive authoring values and descriptors (Schema.suspend) keep manual types checked
 * by AssertExact in authoring.ts; `contracts/authoring` and `contracts/cameras/review` are JSON
 * authoritative. Map Review persistence and Workbench IPC stay Effect-schema-first in cameras.
 */
describe("public wire ownership inventory", () => {
    it("keeps recursive authoring exceptions named", () => {
        expectTypeOf().not.toBeAny();
        expectTypeOf().not.toBeAny();
        expectTypeOf().not.toBeAny();
        expectTypeOf().not.toBeAny();
    });
    it("keeps ordinary protocol camera and play-session wire types schema-derived", () => {
        expectTypeOf().not.toBeAny();
        expectTypeOf().not.toBeAny();
        expectTypeOf().not.toBeAny();
        expectTypeOf().not.toBeAny();
        expectTypeOf().not.toBeAny();
        expectTypeOf().not.toBeAny();
    });
});
