import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { textOccurrenceFromExtraction } from "./corpus.js";
import { makeTextUnitId } from "./identifiers.js";
import { RelatedUnit } from "./related-lines.js";
import { MAX_TEXT_SECTION_ROWS } from "./schema.js";
const place = (index) => textOccurrenceFromExtraction({
    packageFile: "Content/Notes.uasset",
    occurrence: {
        source: "Keep the lamp lit",
        dev_notes: "",
        identity: { status: "resolved", namespace: "Notes", key: "Lamp" },
        location: {
            kind: "asset_property",
            object_path: "/Game/Notes.Notes",
            class_path: "/Script/Fixture.Notes",
            property_path: `Text${index}`
        },
        edit_capability: "read_only"
    }
});
const unit = (places) => ({
    kind: "unit",
    unit: {
        id: makeTextUnitId("unit:lamp"),
        source: { status: "consistent", value: "Keep the lamp lit" },
        identity: { status: "resolved", namespace: "Notes", key: "Lamp" },
        contexts: [],
        locationKinds: ["asset_property"],
        characterCount: 17,
        wordCount: 4,
        occurrenceCount: places,
        remainingContextCount: 0,
        reviewSignals: []
    },
    occurrences: Array.from({ length: places }, (_, index) => place(index)),
    totalOccurrences: places,
    complete: true
});
describe("a related unit", () => {
    it("holds as many places as the largest page a request may ask for", () => {
        const decode = Schema.decodeUnknownExit(RelatedUnit);
        expect(decode(unit(MAX_TEXT_SECTION_ROWS))._tag).toBe("Success");
        expect(decode(unit(MAX_TEXT_SECTION_ROWS + 1))._tag).toBe("Failure");
    });
});
