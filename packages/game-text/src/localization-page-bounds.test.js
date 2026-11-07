import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { LocalizationQueryPage } from "./localization-schema.js";
import { TextCorpusSearchRequest, MAX_TEXT_QUERY_PAGE_SIZE } from "./schema.js";
const isSearchRequest = Schema.is(TextCorpusSearchRequest);
const isPageLines = Schema.is(LocalizationQueryPage.fields.lines);
describe("localization row bounds", () => {
    it("accepts the rows of admitted bulk and open-group requests", () => {
        const line = {
            id: 'Review:["UI","K"]',
            origin: { kind: "corpus", unitIds: [] },
            identity: { namespace: "UI", key: "K" },
            source: "Source",
            manifestLocations: [],
            remainingLocationCount: 0,
            cultures: []
        };
        expect(isSearchRequest({ query: "", capability: "all", pageSize: 500 })).toBe(true);
        expect(isPageLines(Array(500).fill(line))).toBe(true);
        expect(isPageLines(Array(MAX_TEXT_QUERY_PAGE_SIZE + 1).fill(line))).toBe(false);
    });
});
