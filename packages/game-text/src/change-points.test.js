import { describe, expect, it } from "vitest";
import { gameTextChangeLabel, gameTextChangePoints } from "./change-comparison.js";
import { changeComparisonTarget, changePointReads, unreadableChangePaths } from "./change-points.js";
import { localizationGateFailures } from "./localization-gate.js";
const outcome = (point) => ({
    point,
    read: 0,
    reused: 0,
    bytes: 0,
    entries: []
});
const comparison = {
    point: "depot@1200",
    base: "before.depot@1200",
    counts: { added: 1, removed: 0, rekeyed: 1, edited: 0, unchanged: 4 },
    complete: true,
    total: 2,
    changes: [],
    stageSeconds: {},
    findings: {
        counts: {
            keyChanged: 1,
            conflictingSource: 0,
            translatedTextChanged: 0,
            textChanged: 0,
            notGathered: 1,
            unresolvedKey: 0,
            removed: 0,
            gatheredSource: 0,
            partialRead: 0
        },
        total: 2,
        built: false,
        rows: [
            {
                check: "key_changed",
                path: "Content/UI/WBP_Menu.uasset",
                namespace: "UI",
                key: "Quit2",
                source: "Quit",
                cultures: ["de", "fr"],
                earlier: { namespace: "UI", key: "Quit" }
            },
            {
                check: "not_gathered",
                path: "Content/UI/WBP_Menu.uasset",
                namespace: "UI",
                key: "Play",
                source: "Play",
                cultures: []
            }
        ]
    }
};
const points = {
    target: "Game",
    before: outcome("before.depot@1200"),
    after: outcome("depot@1200"),
    comparison,
    localized: true
};
describe("a change's comparison for a host", () => {
    it("gives each finding its severity and way forward", () => {
        const target = changeComparisonTarget(points, localizationGateFailures());
        expect(target.status).toBe("failed");
        expect(target.findings?.rows.map((row) => [row.check, row.severity])).toEqual([
            ["key_changed", "fail"],
            ["not_gathered", "warn"]
        ]);
        expect(target.findings?.rows[0]?.guidance).toContain("de, fr");
    });
    it("keeps the engine's order, which put failing checks first before it paged them", () => {
        // The engine read the points with `not_gathered` failing; ordering this page again would
        // only order one page, so a failure on the next page would still follow these warnings.
        const failing = localizationGateFailures(["not_gathered"], ["key_changed"]);
        const findings = comparison.findings;
        if (findings === undefined)
            throw new Error("The comparison has findings.");
        const engineOrder = { ...findings, rows: [...findings.rows].reverse() };
        const target = changeComparisonTarget({ ...points, comparison: { ...comparison, findings: engineOrder } }, failing);
        expect(target.findings?.rows.map((row) => [row.check, row.severity])).toEqual([
            ["not_gathered", "fail"],
            ["key_changed", "warn"]
        ]);
        const reordered = changeComparisonTarget(points, failing);
        expect(reordered.findings?.rows.map((row) => row.check)).toEqual([
            "key_changed",
            "not_gathered"
        ]);
    });
    it("follows the policy: a check that only warns passes the change", () => {
        const target = changeComparisonTarget(points, localizationGateFailures([], ["key_changed"]));
        expect(target.status).toBe("passed");
        expect(target.findings?.rows[0]?.severity).toBe("warn");
    });
    it("gives no verdict when the base had no manifest", () => {
        const target = changeComparisonTarget({
            ...points,
            localized: false,
            comparison: {
                point: comparison.point,
                base: comparison.base,
                counts: comparison.counts,
                complete: comparison.complete,
                total: comparison.total,
                changes: comparison.changes,
                stageSeconds: comparison.stageSeconds
            }
        }, localizationGateFailures());
        expect(target.status).toBeUndefined();
        expect(target.findings).toBeUndefined();
    });
});
describe("a change's points", () => {
    it("names each kind of change", () => {
        expect(gameTextChangePoints({ kind: "range", from: 1100, to: 1200 })).toEqual({
            point: "range:1100..1200",
            base: "before.range:1100..1200"
        });
        expect(gameTextChangeLabel({ kind: "shelved", change: 1200 })).toBe("shelved changelist 1200");
        expect(gameTextChangeLabel({ kind: "local", files: ["A.uasset"] })).toBe("1 working-copy file");
    });
});
describe("what a change's points could not read", () => {
    it("lists each failed file once, from either side and every target", () => {
        const read = (entries) => ({ ...outcome("p"), entries });
        const failed = { path: "Content/Broken.uasset", status: "failed" };
        expect(unreadableChangePaths([
            { ...points, before: read([failed]), after: read([failed]) },
            {
                ...points,
                target: "Other",
                after: read([
                    { path: "Source/Labels.hxx", status: "failed" },
                    { path: "Content/Fine.uasset", status: "partial" }
                ])
            }
        ])).toEqual(["Content/Broken.uasset", "Source/Labels.hxx"]);
        expect(unreadableChangePaths([points])).toEqual([]);
    });
    it("reads every C++ extension a gather scans", () => {
        for (const path of ["A.h", "A.hh", "A.hpp", "A.hxx", "A.inl", "A.cpp", "A.cxx", "A.ini"])
            expect(changePointReads(`Source/${path}`), path).toBe(true);
        expect(changePointReads("Content/Strings.csv")).toBe(false);
    });
});
