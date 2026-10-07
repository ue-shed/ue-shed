import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeLocalizationChangeSet, LocalizationChangeSet } from "./change-sets.js";

const document = Schema.decodeUnknownSync(LocalizationChangeSet)({
	schemaVersion: 1,
	provenance: {
		producer: "test",
		files: [
			{
				relativePath: "Content/Localization/Test/de/Test.po",
				size: 20,
				modifiedTime: "2026-10-07T00:00:00Z",
				contentHash: "hash"
			}
		]
	},
	changes: [
		{
			target: "Test",
			culture: "de",
			namespace: "",
			key: "K",
			source: "Hi {Name}",
			previousTranslation: null,
			translation: "Hallo {Name}"
		}
	]
});

describe("localization change sets", () => {
	it("round-trips version 1 JSON, including absent and empty previous translations", () => {
		for (const previousTranslation of [null, "", "Hallo"]) {
			const value = {
				...document,
				changes: document.changes.map((change) => ({ ...change, previousTranslation }))
			};
			const json = Schema.encodeSync(Schema.fromJsonString(LocalizationChangeSet))(value);
			const decoded = decodeLocalizationChangeSet(json);
			expect(Result.isSuccess(decoded)).toBe(true);
			if (Result.isSuccess(decoded)) expect(decoded.success).toEqual(value);
		}
	});
	it("returns safe typed failures for malformed, unsupported and duplicate proposals", () => {
		for (const json of [
			"{",
			JSON.stringify({ ...document, schemaVersion: 2 }),
			JSON.stringify({ ...document, changes: [{ target: "../private" }] })
		]) {
			const result = decodeLocalizationChangeSet(json);
			expect(Result.isFailure(result)).toBe(true);
			if (Result.isFailure(result)) {
				expect(result.failure.code).toBe("invalid_change_set");
				expect(result.failure.message).not.toContain("private");
			}
		}
		const duplicate = decodeLocalizationChangeSet(
			JSON.stringify({ ...document, changes: [...document.changes, ...document.changes] })
		);
		if (Result.isFailure(duplicate)) expect(duplicate.failure.code).toBe("duplicate_change");
		else throw new Error("Duplicate changes must fail.");
	});
});
