import { LocalizationError } from "@ue-shed/localization/browser";
import { describe, expect, it } from "vitest";
import { corpus, cultureCode, evidence, unit } from "./localization.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { localizationProgressReport } from "./localization-reports.js";
import { localizationManifestFailure } from "./localization-schema.js";
import { explainLocalizationFile, localizationEvidenceFolder, localizationFileProblems, localizationTargetFiles } from "./localization-status.js";
import { localizationReportPage } from "./localization-workspace.js";
const missing = new LocalizationError({
    code: "file_missing",
    message: "Localization evidence could not be read (file_missing).",
    recovery: "Restore the expected file.",
    retrySafe: true,
    nextStep: "fix_input"
});
const malformed = new LocalizationError({
    code: "malformed_po",
    message: "Line 4 is not a PO entry.",
    recovery: "Export the PO file again.",
    retrySafe: true,
    nextStep: "fix_input"
});
const poPath = "Content/Localization/Game/de/Game.po";
const explain = (file) => explainLocalizationFile(localizationFileProblems([file])[0]);
function failed(kind, relativePath, error, culture) {
    return {
        kind,
        status: "failed",
        relativePath,
        error,
        ...(culture === undefined ? undefined : { culture: cultureCode(culture) })
    };
}
describe("localization evidence file wording", () => {
    it("says a file is not in the working copy instead of unreadable", () => {
        expect(explain(failed("po", poPath, missing, "de"))).toEqual({
            message: `Not in this working copy: ${poPath}`,
            recovery: "Run the target's Export step, or get the localization folder from source control."
        });
        expect(explain(failed("manifest", "Content/Localization/Game/Game.manifest", missing)).recovery).toBe("Run the target's Gather step, or get the localization folder from source control.");
    });
    it("explains a target with no configured file path", () => {
        expect(explain(failed("archive", null, missing, "de"))).toMatchObject({
            message: "This target has no translation archive (de) configured."
        });
    });
    it("keeps real read failures with their error code and recovery", () => {
        expect(explain(failed("po", poPath, malformed, "de"))).toEqual({
            message: `The PO file (de) could not be read (malformed_po): ${poPath}`,
            recovery: "Export the PO file again."
        });
    });
    it("finds the folder that holds every evidence file", () => {
        expect(localizationEvidenceFolder([
            failed("manifest", "Content/Localization/Game/Game.manifest", missing),
            failed("po", poPath, missing, "de"),
            failed("locmeta", null, missing)
        ])).toBe("Content/Localization/Game");
        expect(localizationEvidenceFolder([failed("locmeta", null, missing)])).toBeUndefined();
        expect(localizationTargetFiles([
            failed("manifest", "Content/Localization/Game/Game.manifest", missing)
        ])).toEqual({
            fileProblems: [
                {
                    kind: "manifest",
                    path: "Content/Localization/Game/Game.manifest",
                    state: "missing",
                    code: "file_missing",
                    recovery: "Restore the expected file."
                }
            ],
            localizationFolder: "Content/Localization/Game"
        });
    });
    it("names the missing manifest path and keeps unreadable manifests distinct", () => {
        const absent = localizationManifestFailure(missing, "Content/Localization/Game/Game.manifest");
        expect(absent.code).toBe("missing_manifest");
        expect(absent.message).toBe("Not in this working copy: Content/Localization/Game/Game.manifest");
        const unreadable = localizationManifestFailure(new LocalizationError({
            code: "malformed_manifest",
            message: "Not a manifest.",
            recovery: "Gather again.",
            retrySafe: true,
            nextStep: "fix_input"
        }));
        expect(unreadable.code).toBe("unreadable_manifest");
        expect(unreadable.message).toContain("could not be read (malformed_manifest)");
    });
    it("separates missing from unreadable files in the workspace report", () => {
        const base = evidence();
        const files = {
            ...base,
            cultures: base.cultures.map((culture) => culture.culture === cultureCode("de")
                ? {
                    ...culture,
                    po: { status: "failed", relativePath: poPath, error: missing },
                    archive: {
                        status: "failed",
                        relativePath: "Content/Localization/Game/de/Game.archive",
                        error: new LocalizationError({
                            code: "malformed_archive",
                            message: "Not an archive.",
                            recovery: "Gather again.",
                            retrySafe: true,
                            nextStep: "fix_input"
                        })
                    }
                }
                : culture)
        };
        const text = corpus([unit()]);
        const report = localizationProgressReport(text, joinLocalizationTarget(text, files, files.target), files);
        const page = localizationReportPage(report, null, { target: files.target.name });
        // The fixture's locmeta and word-count files have no configured path.
        expect(page.gatherFilesFailed).toBe(4);
        expect(page.gatherFilesMissing).toBe(3);
        expect(page.gatherFileProblems?.map((problem) => problem.state)).toEqual([
            "unreadable",
            "missing",
            "missing",
            "missing"
        ]);
    });
});
