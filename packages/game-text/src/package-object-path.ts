import { relative, resolve } from "node:path";
import type {
	SavedAssetBlueprintClasses,
	SavedAssetPackageTextEvent,
	SavedAssetTextCoverageGap,
	SavedAssetTextExtractionEvent,
	SavedAssetTextOccurrence
} from "@ue-shed/unreal-assets";

// The reader scans only the project's Content folder, which Unreal mounts at /Game.
const CONTENT_PACKAGE = /^Content\/(.+)\.(?:uasset|umap)$/iu;

/** Unreal's package name for a saved package file, or undefined outside the project's Content. */
export function mountedPackageName(projectRoot: string, path: string): string | undefined {
	const packageFile = relative(projectRoot, resolve(projectRoot, path)).replaceAll("\\", "/");
	const name = packageFile.match(CONTENT_PACKAGE)?.[1];
	return name === undefined ? undefined : `/Game/${name}`;
}

/**
 * Where a package's saved paths belong. `packageName` is the name Unreal gives the file from its
 * location; `serializedName` is the different name its summary still records after the file was
 * moved or copied outside Unreal, if any.
 */
interface PackageMount {
	readonly packageName: string;
	readonly serializedName?: string;
}

/**
 * Completes a package-relative path and moves a path inside the serialized package to the file's
 * package, as Unreal resolves it. UE 4.27 usually saves `None` as a package's own name, so the
 * reader names its objects relative to it: `DT_Items` or `DT_Items:Sub` rather than
 * `/Game/Data/DT_Items.DT_Items`. Paths into other packages, such as a World Partition actor's
 * level or a referenced String Table, and empty paths are left as saved.
 */
function remount(path: string, mount: PackageMount): string {
	if (path === "") return path;
	if (!path.startsWith("/")) return `${mount.packageName}.${path}`;
	const from = mount.serializedName;
	return from !== undefined &&
		(path === from || path.startsWith(`${from}.`) || path.startsWith(`${from}:`))
		? mount.packageName + path.slice(from.length)
		: path;
}

function mountOccurrence(
	occurrence: SavedAssetTextOccurrence,
	mount: PackageMount
): SavedAssetTextOccurrence {
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

function mountBlueprintClasses(
	classes: SavedAssetBlueprintClasses,
	mount: PackageMount
): SavedAssetBlueprintClasses {
	const optional = ["classDefault", "skeletonClass", "skeletonClassDefault"] as const;
	const moves = (path: string | undefined) => path !== undefined && remount(path, mount) !== path;
	if (
		!moves(classes.blueprint) &&
		!moves(classes.generatedClass) &&
		!optional.some((field) => moves(classes[field]))
	)
		return classes;
	const at = (path: string) => remount(path, mount);
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

function mountGap(gap: SavedAssetTextCoverageGap, mount: PackageMount): SavedAssetTextCoverageGap {
	const objectPath = remount(gap.object_path, mount);
	return objectPath === gap.object_path ? gap : { ...gap, object_path: objectPath };
}

/**
 * The reader's evidence with every package-relative object path completed, so the corpus and the
 * index store the paths Unreal uses, which rules, exports, key changes and String Table references
 * compare against. A package record whose summary names another package, because the file was
 * moved or copied outside Unreal, has its own paths moved to the file's package; the record keeps
 * the serialized `packageName` as evidence. Events whose paths are already Unreal's are returned
 * as they are.
 */
export function mountPackageTextEvent(
	projectRoot: string,
	event: SavedAssetPackageTextEvent
): SavedAssetPackageTextEvent;
export function mountPackageTextEvent(
	projectRoot: string,
	event: SavedAssetPackageTextEvent | SavedAssetTextExtractionEvent
): SavedAssetPackageTextEvent | SavedAssetTextExtractionEvent;
export function mountPackageTextEvent(
	projectRoot: string,
	event: SavedAssetPackageTextEvent | SavedAssetTextExtractionEvent
): SavedAssetPackageTextEvent | SavedAssetTextExtractionEvent {
	if (
		event.event !== "text_package_record" &&
		event.event !== "text_occurrence" &&
		event.event !== "text_coverage_gap"
	)
		return event;
	const packageName = mountedPackageName(projectRoot, event.path);
	if (packageName === undefined) return event;
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
	const mount: PackageMount =
		serialized !== undefined && serialized.startsWith("/") && serialized !== packageName
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
