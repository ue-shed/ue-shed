import { describe, expect, it } from "vitest";
import type { AssetInspectionReadResult } from "@ue-shed/extension-asset-inspector/contract";
import {
	lastInspection,
	offerBlueprint,
	offerSequence,
	offerInspectionFile,
	rememberInspection,
	takeBlueprint,
	takeSequence,
	takeInspectionFile,
	offerAuthoring,
	takeAuthoring
} from "./asset-handoff.js";

describe("site asset handoffs", () => {
	it("consumes DataTable evidence once", () => {
		const read = {
			status: "failed" as const,
			reason: "unsupported_asset" as const,
			message: "No table",
			recovery: "Choose a DataTable"
		};
		offerAuthoring(read, "DT.uasset");
		expect(takeAuthoring()).toEqual({ read, fileName: "DT.uasset" });
		expect(takeAuthoring()).toBeUndefined();
	});

	it("consumes sequence evidence once", () => {
		offerSequence({ status: "cancelled" }, "LS.uasset");
		expect(takeSequence()).toEqual({ read: { status: "cancelled" }, fileName: "LS.uasset" });
		expect(takeSequence()).toBeUndefined();
	});

	it("consumes Blueprint evidence once", () => {
		const read = { status: "cancelled" };
		offerBlueprint({ status: "cancelled" }, "Test.uasset");
		expect(takeBlueprint()).toEqual({ read, fileName: "Test.uasset" });
		expect(takeBlueprint()).toBeUndefined();
	});

	it("consumes an inspection file once while retaining the last decoded inspection for Back", () => {
		const file = new File(["saved bytes"], "Test.uasset");
		offerInspectionFile(file);
		expect(takeInspectionFile()).toBe(file);
		expect(takeInspectionFile()).toBeUndefined();
		const read: AssetInspectionReadResult = {
			status: "failed",
			fileName: "Test.uasset",
			reason: "reader_failure",
			message: "Invalid",
			recovery: "Retry"
		};
		rememberInspection({
			read,
			blueprint: { status: "cancelled" },
			sequence: { status: "cancelled" },
			authoring: {
				status: "failed",
				reason: "unsupported_asset",
				message: "No table",
				recovery: "Choose a DataTable"
			}
		});
		expect(lastInspection()?.read).toBe(read);
		expect(lastInspection()?.read).toBe(read);
	});
});
