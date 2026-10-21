import { Schema } from "effect";
import { expect, it } from "vitest";
import { SavedAssetPackageTextRecord } from "./index.js";

it("preserves text-capability evidence through the public package-record decoder", () => {
	const counts = {
		unsupported_text_history: 0,
		legacy_container_element_without_type_information: 0,
		feature_unavailable_for_engine_version: 0,
		property_decoder_rejected: 2
	};
	const record = {
		event: "text_package_record",
		fileBytes: 100,
		path: "Content/Fixture.uasset",
		schema_version: 1,
		status: "partial",
		decodeErrors: 0,
		occurrences: [],
		gapCounts: counts,
		textGapCounts: { ...counts, property_decoder_rejected: 1 },
		gapSamples: [false, true].map((may_contain_text) => ({
			object_path: "Fixture.Asset",
			property_path: may_contain_text ? "Caption" : "Reference",
			reason: "property_decoder_rejected",
			may_contain_text
		}))
	};
	const decode = Schema.decodeUnknownSync(SavedAssetPackageTextRecord);
	const decoded = decode(record);
	expect(decoded.textGapCounts?.property_decoder_rejected).toBe(1);
	expect(decoded.gapCounts.property_decoder_rejected).toBe(2);
	expect(decoded.gapSamples.map((gap) => gap.may_contain_text)).toEqual([false, true]);
	const { textGapCounts: _counts, ...legacy } = record;
	const old = decode({
		...legacy,
		gapSamples: record.gapSamples.map(({ may_contain_text: _classification, ...gap }) => gap)
	});
	expect(old.textGapCounts).toBeUndefined();
	expect(old.gapSamples.every((gap) => gap.may_contain_text === undefined)).toBe(true);
});
