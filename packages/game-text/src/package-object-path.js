import { relative, resolve } from "node:path";
// The reader scans only the project's Content folder, which Unreal mounts at /Game.
const CONTENT_PACKAGE = /^Content\/(.+)\.(?:uasset|umap)$/iu;
/** Unreal's package name for a saved package file, or undefined outside the project's Content. */
export function mountedPackageName(projectRoot, path) {
    const packageFile = relative(projectRoot, resolve(projectRoot, path)).replaceAll("\\", "/");
    const name = packageFile.match(CONTENT_PACKAGE)?.[1];
    return name === undefined ? undefined : `/Game/${name}`;
}
/**
 * Completes a package-relative path and moves a path inside the serialized package to the file's
 * package, as Unreal resolves it. UE 4.27 usually saves `None` as a package's own name, so objects
 * are named relative to it (`DT_Items:Sub`). Paths into other packages, such as a World Partition
 * actor's level, and empty paths are left as saved.
 */
function remount(path, mount) {
    if (path === "")
        return path;
    if (!path.startsWith("/"))
        return `${mount.packageName}.${path}`;
    const from = mount.serializedName;
    return from !== undefined &&
        (path === from || path.startsWith(`${from}.`) || path.startsWith(`${from}:`))
        ? mount.packageName + path.slice(from.length)
        : path;
}
function mountOccurrence(occurrence, mount) {
    const location = occurrence.location;
    const objectPath = remount(location.object_path, mount);
    if (location.kind !== "asset_property")
        return objectPath === location.object_path
            ? occurrence
            : { ...occurrence, location: { ...location, object_path: objectPath } };
    // A class saved in the same package, such as a Blueprint's generated class.
    const classPath = remount(location.class_path, mount);
    return objectPath === location.object_path && classPath === location.class_path
        ? occurrence
        : {
            ...occurrence,
            location: { ...location, object_path: objectPath, class_path: classPath }
        };
}
function mountBlueprintClasses(classes, mount) {
    const optional = ["classDefault", "skeletonClass", "skeletonClassDefault"];
    const moves = (path) => path !== undefined && remount(path, mount) !== path;
    if (!moves(classes.blueprint) &&
        !moves(classes.generatedClass) &&
        !optional.some((field) => moves(classes[field])))
        return classes;
    const at = (path) => remount(path, mount);
    return {
        blueprint: at(classes.blueprint),
        generatedClass: at(classes.generatedClass),
        ...(classes.classDefault === undefined
            ? undefined
            : { classDefault: at(classes.classDefault) }),
        ...(classes.skeletonClass === undefined
            ? undefined
            : { skeletonClass: at(classes.skeletonClass) }),
        ...(classes.skeletonClassDefault === undefined
            ? undefined
            : { skeletonClassDefault: at(classes.skeletonClassDefault) })
    };
}
function mountGap(gap, mount) {
    const objectPath = remount(gap.object_path, mount);
    return objectPath === gap.object_path ? gap : { ...gap, object_path: objectPath };
}
export function mountPackageTextEvent(projectRoot, event) {
    if (event.event !== "text_package_record" &&
        event.event !== "text_occurrence" &&
        event.event !== "text_coverage_gap")
        return event;
    const packageName = mountedPackageName(projectRoot, event.path);
    if (packageName === undefined)
        return event;
    // Only package records carry the summary's name; single events can only be completed.
    if (event.event === "text_occurrence") {
        const occurrence = mountOccurrence(event.occurrence, { packageName });
        return occurrence === event.occurrence ? event : { ...event, occurrence };
    }
    if (event.event === "text_coverage_gap") {
        const gap = mountGap(event.coverage_gap, { packageName });
        return gap === event.coverage_gap ? event : { ...event, coverage_gap: gap };
    }
    // UE 4.27 may save `None`, which leaves the paths package-relative instead.
    const serialized = event.packageName;
    const mount = serialized !== undefined && serialized.startsWith("/") && serialized !== packageName
        ? { packageName, serializedName: serialized }
        : { packageName };
    let changed = false;
    const occurrences = event.occurrences.map((occurrence) => {
        const mounted = mountOccurrence(occurrence, mount);
        changed ||= mounted !== occurrence;
        return mounted;
    });
    const gapSamples = event.gapSamples.map((gap) => {
        const mounted = mountGap(gap, mount);
        changed ||= mounted !== gap;
        return mounted;
    });
    const blueprintClasses = event.blueprintClasses?.map((classes) => {
        const mounted = mountBlueprintClasses(classes, mount);
        changed ||= mounted !== classes;
        return mounted;
    });
    return changed
        ? {
            ...event,
            occurrences,
            gapSamples,
            ...(blueprintClasses === undefined ? undefined : { blueprintClasses })
        }
        : event;
}
