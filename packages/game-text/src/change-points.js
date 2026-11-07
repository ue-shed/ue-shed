import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { LocalizationEvidence } from "@ue-shed/localization";
import { gameTextChangePoints } from "./change-comparison.js";
import { GameTextIndexSteps } from "./index-steps.js";
import { LocalizationGateCheck, comparisonGuidance, localizationGateComparison } from "./localization-gate.js";
/**
 * Files a point reads: saved packages, and the source and config files a gather step may scan.
 * String Table CSVs are not among them: the scan reads those from the project on disk.
 */
const READ = /\.(?:uasset|umap|h|hh|hpp|hxx|inl|c|cc|cpp|cxx|mm|ini)$/iu;
/** Whether a point reads a project file, by its path. */
export const changePointReads = (path) => READ.test(path);
/**
 * Changed packages, or code and config files, a point could not read at all, by path. A verdict
 * over a change with any of them could pass what it never saw.
 */
export function unreadableChangePaths(targets) {
    return [
        ...new Set(targets.flatMap((target) => [...target.before.entries, ...target.after.entries].flatMap((entry) => entry.status === "failed" ? [entry.path] : [])))
    ];
}
/** Each named target's outputs; a target with no manifest has none. */
const targetOutputs = Effect.fnUntraced(function* (projectRoot, targetNames) {
    if (targetNames.length === 0)
        return new Map();
    const discovery = yield* (yield* LocalizationEvidence).discover({ projectRoot });
    return new Map(targetNames.flatMap((name) => {
        const found = discovery.targets.find((item) => item.name === name);
        const manifest = found?.outputPaths.manifest;
        if (found === undefined || manifest === null || manifest === undefined)
            return [];
        const outputs = {
            nativeCulture: found.nativeCulture ?? "",
            manifest,
            archives: found.cultures.flatMap((culture) => {
                const path = found.outputPaths.archives[culture];
                return path === null || path === undefined ? [] : [{ culture, path }];
            })
        };
        return [[name, outputs]];
    }));
});
const outputPaths = (outputs) => [
    ...new Set([...outputs].flatMap((target) => [
        target.manifest,
        ...target.archives.map((archive) => archive.path)
    ]))
];
/**
 * The target's localization at a base, from the files fetched there; a revision is named by its
 * depot path and number, which never change on one server, and the server (or, from a host that
 * does not name it, the file it was read from). Undefined without the manifest. A culture whose
 * archive the base lacks has nothing translated.
 */
function baseLocalization(outputs, files) {
    const byPath = new Map(files.map((file) => [file.path, file]));
    const revision = (path) => {
        const file = byPath.get(path);
        return file === undefined
            ? undefined
            : {
                path,
                file: file.file,
                revision: `${file.depotPath}#${file.revision} ${file.server ?? file.file}`
            };
    };
    const manifest = outputs === undefined ? undefined : revision(outputs.manifest);
    if (outputs === undefined || manifest === undefined)
        return undefined;
    return {
        nativeCulture: outputs.nativeCulture,
        manifest,
        archives: outputs.archives.flatMap(({ culture, path }) => {
            const archive = revision(path);
            return archive === undefined ? [] : [{ culture, archive }];
        })
    };
}
/** The engine's largest page. */
const WHOLE = { offset: 0, limit: 1000 };
/**
 * Reads a change's two points for each named target (or once without one) and compares them,
 * judging each target's localization by the gate's checks. Targets are read one at a time
 * because a point's id names the change, not the target: a host must not read two changes with
 * the same id at once.
 */
export const readGameTextChangePoints = Effect.fn("GameText.change_points")(function* (input) {
    const targetNames = input.targetNames ?? [];
    const outputs = yield* targetOutputs(input.projectRoot, targetNames);
    const before = outputs.size === 0 ? undefined : outputPaths(outputs.values());
    const sides = yield* readSides(input, before);
    const { point, base } = gameTextChangePoints(input.change);
    const steps = yield* GameTextIndexSteps;
    const names = targetNames.length === 0 ? [undefined] : targetNames;
    const targets = yield* Effect.forEach(names, (targetName) => Effect.gen(function* () {
        const target = {
            ...(targetName === undefined ? undefined : { targetName }),
            ...(input.code === undefined ? undefined : { code: input.code })
        };
        const beforePoint = yield* steps.readPoint({
            projectRoot: input.projectRoot,
            point: base,
            files: sides.before,
            ...target
        });
        const afterPoint = yield* steps.readPoint({
            projectRoot: input.projectRoot,
            point,
            base,
            files: sides.after,
            ...target
        });
        const localization = targetName === undefined
            ? undefined
            : baseLocalization(outputs.get(targetName), sides.localization);
        const comparison = yield* steps.comparePoints({
            projectRoot: input.projectRoot,
            point,
            base,
            changes: input.changes ?? WHOLE,
            findings: input.findings ?? WHOLE,
            ...(input.failOn === undefined ? undefined : { failOn: input.failOn }),
            ...(targetName === undefined ? undefined : { targetName }),
            ...(localization === undefined ? undefined : { localization })
        });
        return {
            ...(targetName === undefined ? undefined : { target: targetName }),
            before: beforePoint,
            after: afterPoint,
            comparison,
            localized: localization !== undefined
        };
    }));
    return {
        targets,
        change: {
            point,
            base,
            files: sides.files,
            read: sides.read,
            outside: sides.outside,
            code: input.code !== undefined
        },
        skipped: sides.skipped
    };
});
/** The change's files at both sides, and the targets' localization as the change found it. */
const readSides = Effect.fn("GameText.change_points.read_sides")(function* (input, before) {
    const { change, projectRoot, revisions } = input;
    if (change.kind === "local") {
        const read = change.files.filter(changePointReads);
        const had = yield* revisions.have({
            projectRoot,
            paths: [...read, ...(before ?? [])]
        });
        const byPath = new Map(had.files.map((file) => [file.path, file.file]));
        const onDisk = yield* Effect.forEach(read, (path) => Effect.promise(() => stat(join(projectRoot, path)).then(() => ({ path, file: join(projectRoot, path) }), () => ({ path }))));
        return {
            before: read.map((path) => {
                const file = byPath.get(path);
                return file === undefined ? { path } : { path, file };
            }),
            after: onDisk,
            localization: had.files,
            files: change.files.length,
            read: read.length,
            outside: 0,
            skipped: change.files.filter((path) => !changePointReads(path))
        };
    }
    const common = {
        projectRoot,
        reads: changePointReads,
        ...(before === undefined ? undefined : { before })
    };
    const fetched = change.kind === "range"
        ? yield* revisions.range({ ...common, from: change.from, to: change.to })
        : yield* revisions.changelist({
            ...common,
            change: change.change,
            shelved: change.kind === "shelved"
        });
    const side = (pick) => fetched.files.map((file) => {
        const bytes = file[pick];
        return bytes === undefined ? { path: file.path } : { path: file.path, file: bytes };
    });
    return {
        before: side("base"),
        after: side("head"),
        localization: fetched.before?.files ?? [],
        files: fetched.files.length + fetched.skipped.length,
        read: fetched.files.length,
        outside: fetched.outside,
        skipped: fetched.skipped
    };
});
/**
 * A target's comparison as `compareChange` answers it, judged by `failing`: each finding's
 * severity and way forward, and the verdict when the change was judged. The findings keep the
 * engine's order, which lists failing checks first when the points were read with the same
 * `failOn`; ordering here would only order one page.
 */
export function changeComparisonTarget(points, failing) {
    const { comparison } = points;
    const fails = new Set(failing);
    const findings = comparison.findings;
    // The verdict counts every finding, not only the page's, as `loc gate` does.
    const status = points.localized && findings !== undefined
        ? localizationGateComparison({
            target: points.target ?? "",
            comparison,
            failOn: failing
        }).status
        : undefined;
    return {
        ...(points.target === undefined ? undefined : { target: points.target }),
        localized: points.localized,
        ...(status === undefined ? undefined : { status }),
        counts: comparison.counts,
        complete: comparison.complete,
        total: comparison.total,
        changes: comparison.changes,
        ...(findings === undefined
            ? undefined
            : {
                findings: {
                    counts: findings.counts,
                    total: findings.total,
                    rows: findings.rows.map((finding) => ({
                        ...finding,
                        severity: fails.has(finding.check)
                            ? "fail"
                            : "warn",
                        guidance: comparisonGuidance(finding)
                    }))
                }
            })
    };
}
