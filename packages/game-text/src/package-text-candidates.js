import { HostSliceClock, runHostStepsSync } from "./host-slices.js";
export const REQUIRES_LOCALIZATION_GATHER = 0x00040000;
/**
 * Header evidence is mandatory: older workers must be upgraded before candidate pruning. External
 * actor and object packages follow their own header: Unreal loads one only when it is flagged
 * without a current gather table (`CalculatePackageLocCacheState`, UE 5.7 and 5.8), and neither
 * the outer world nor its other actors are read for an actor whose header claims no text.
 */
export function isPackageTextCandidate(header) {
    return ((header.packageFlags & REQUIRES_LOCALIZATION_GATHER) !== 0 ||
        (header.gatherableTextDataCount > 0 && header.gatherableTextDataOffset > 0));
}
/** Complete covers inspected candidates. Exclusion never proves the absence of FText. */
export function textCorpusWithExcludedPackages(corpus, packageFiles) {
    return runHostStepsSync(textCorpusWithExcludedPackagesSteps(corpus, packageFiles, new HostSliceClock(Infinity)));
}
/** Host steps for `textCorpusWithExcludedPackages`, for inventories of many excluded packages. */
export function* textCorpusWithExcludedPackagesSteps(corpus, packageFiles, clock) {
    const excluded = new Set();
    for (const packageFile of packageFiles) {
        excluded.add(packageFile);
        if (clock.step())
            yield;
    }
    for (const unit of corpus.units) {
        if (unit.occurrences.some((occurrence) => excluded.has(occurrence.packageFile)))
            throw new Error("STOP: excluded package contains decoded text.");
        if (clock.step())
            yield;
    }
    const coverage = corpus.packageCoverage ?? [];
    if (coverage.some((item) => excluded.has(item.packageFile)))
        throw new Error("An excluded package must not also be inspected.");
    const packageCoverage = [...coverage];
    const diagnostics = [...corpus.diagnostics];
    for (const packageFile of excluded) {
        packageCoverage.push({ packageFile, status: "not_gatherable" });
        if (clock.step())
            yield;
    }
    for (const packageFile of excluded) {
        diagnostics.push({
            code: "package_not_gatherable",
            packageFile,
            message: "Excluded because Unreal does not gather this package. Its text payload was not inspected."
        });
        if (clock.step())
            yield;
    }
    return { ...corpus, packageCoverage, diagnostics };
}
