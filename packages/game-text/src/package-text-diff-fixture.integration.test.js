import { join } from "node:path";
import { assetReaderLayer, extractProjectTextPackages } from "@ue-shed/unreal-assets";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { diffPackageText } from "./package-text-diff.js";
const fixture = useSavedFixtureProject();
const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const FOLDER = "Content/Fixture/GameTextActions";
/** Reads one package's text record with the native reader. */
async function read(file) {
    const events = await Effect.runPromise(Stream.runCollect(extractProjectTextPackages({
        projectRoot: fixture.root,
        paths: [join(fixture.root, FOLDER, file)]
    })).pipe(Effect.provide(assetReaderLayer({ executable: executable }))));
    const records = [...events].filter((event) => event.event === "text_package_record");
    const [record, ...others] = records;
    if (!record || others.length)
        throw new Error(`Expected one text record for ${file}.`);
    return record;
}
/** Each change as `kind place: before -> after`, for a readable comparison. */
function describeChanges(before, after) {
    const diff = diffPackageText(before, after);
    expect(diff.complete).toBe(true);
    return diff.changes.map((change) => {
        const place = [change.place.objectPath, change.place.entry, change.place.propertyPath]
            .filter(Boolean)
            .join(" ");
        switch (change.kind) {
            case "added":
                return `added ${place}: ${change.after.source}`;
            case "removed":
                return `removed ${place}: ${change.before.source}`;
            default:
                return `${change.kind} ${place}: ${change.before.source} -> ${change.after.source}`;
        }
    });
}
// The fixture's Branched folder holds file copies of four packages, then edits made in each copy
// (UEShedGameTextActionsFixture.cpp, stages Branch and EditBranch); expected-cases.json records
// the ids Unreal gathered for both.
describe.skipIf(!executable)("package text diff over the fixture's branch copies", () => {
    const branchChanges = async (name) => describeChanges(await read(`${name}.uasset`), await read(`Branched/${name}.uasset`));
    it("reports a retyped text that kept its id as edited", async () => {
        expect(await branchChanges("DA_ActionNotes")).toEqual([
            "edited DA_ActionNotes SharedPrimary: Keep the lamp lit -> Keep the lamp lit at night"
        ]);
    });
    it("reports a retyped row that left its shared id as re-keyed", async () => {
        expect(await branchChanges("DT_ActionRows")).toEqual([
            "rekeyed DT_ActionRows Lantern DisplayName: Brass lantern -> Brass ship lantern"
        ]);
    });
    it("reports a widget edit, and the compiled class copy the edited branch no longer saves", async () => {
        expect(await branchChanges("WBP_ActionPanel")).toEqual([
            "edited WBP_ActionPanel.WidgetTree.Heading Text: Harbor master -> Harbor master's office",
            "removed WBP_ActionPanel_C.WidgetTree.Heading Text: Harbor master"
        ]);
    });
    it("finds no change in a branch copy whose text was not edited", async () => {
        expect(await branchChanges("BP_ActionSign")).toEqual([]);
    });
});
