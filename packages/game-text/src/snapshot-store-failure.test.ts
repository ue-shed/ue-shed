import { snapshotStoreGuidance } from "./snapshot-store.js";
import { describe, expect, it } from "vitest";
import { SnapshotFormatError } from "./snapshot-format.js";
import { SnapshotStoreError, snapshotStoreFailure } from "./snapshot-store.js";

const errno = (code: string) => Object.assign(new Error(`${code}: raw os text`), { code });

describe("snapshotStoreFailure", () => {
	it("classifies filesystem failures by code and keeps the cause", () => {
		const missing = snapshotStoreFailure("open", errno("ENOENT"), "fallback");
		expect(missing).toBeInstanceOf(SnapshotStoreError);
		expect(missing).toMatchObject({ code: "missing", operation: "open" });
		expect(missing.message).not.toContain("raw os text");
		expect(missing).toHaveProperty("cause");

		expect(snapshotStoreFailure("write", errno("EACCES"), "fallback")).toMatchObject({
			code: "unavailable"
		});
		expect(snapshotStoreFailure("write", errno("EBUSY"), "fallback")).toMatchObject({
			code: "busy"
		});
		expect(snapshotStoreFailure("write", errno("ENOSPC"), "fallback").message).toContain(
			"disk is full"
		);
	});

	it("uses the caller's recovery for unclassified failures", () => {
		const unknown = snapshotStoreFailure("compact", new Error("boom"), "Rebuild the layer.");
		expect(unknown).toMatchObject({ code: "unavailable", recovery: "Rebuild the layer." });
		expect(unknown.message).toBe("Game Text cache compact failed.");
	});

	it("passes typed snapshot failures through unchanged", () => {
		const typed = new SnapshotStoreError({
			retrySafe: snapshotStoreGuidance("busy").retrySafe,
			nextStep: snapshotStoreGuidance("busy").nextStep,
			operation: "writer",
			code: "busy",
			message: "Another writer owns this target.",
			recovery: "Retry later."
		});
		expect(snapshotStoreFailure("open", typed, "fallback")).toBe(typed);
		const format = new SnapshotFormatError({
			retrySafe: false,
			nextStep: "reconcile",
			code: "invalid_snapshot",
			section: "header",
			message: "bad",
			recovery: "Rebuild."
		});
		expect(snapshotStoreFailure("open", format, "fallback")).toBe(format);
	});
});
