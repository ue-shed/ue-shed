// Which actions have a known use. C++ `BindAction` is invisible to saved packages, so the absence
// of every use this module can see is reported as "no known use", never as "unused".

import type { SavedAssetScan } from "@ue-shed/unreal-assets";
import { inputActionEdges, objectName, savedMappings, type InputActionEdge } from "./atlas.js";
import { contextIdentity } from "./coactivation.js";
import type { EnhancedInputReport } from "./schema.js";

export const ENHANCED_INPUT_ACTION_EVENT_NODE = "K2Node_EnhancedInputAction";
export const GET_INPUT_ACTION_VALUE_NODE = "K2Node_GetInputActionValue";

/** One saved reference from a Blueprint to an action. */
export interface BlueprintInputActionUse {
	readonly action: string;
	readonly blueprint: string;
	readonly ownerPath: string;
	readonly propertyPath: string;
	/** An action event node, a get-value node, or any other saved reference. */
	readonly kind: "event_node" | "value_node" | "reference";
}

/** A saved reference as `blueprintReferences` produces it. */
export interface SavedReferenceLike {
	readonly ownerPath: string;
	readonly propertyPath: string;
	readonly targetPath: string;
}

function nodeKind(classPath: string | undefined): BlueprintInputActionUse["kind"] {
	const name = classPath?.split(".").at(-1);
	if (name === ENHANCED_INPUT_ACTION_EVENT_NODE) return "event_node";
	if (name === GET_INPUT_ACTION_VALUE_NODE) return "value_node";
	return "reference";
}

/**
 * Keeps the references of one decoded Blueprint that point to a known action. Node classes come
 * from the same reference list, where each graph node records its own `class`.
 */
export function blueprintInputActionUses(
	blueprint: string,
	references: readonly SavedReferenceLike[],
	actions: ReadonlySet<string>
): readonly BlueprintInputActionUse[] {
	const byIdentity = new Map([...actions].map((action) => [contextIdentity(action), action]));
	const ownerClass = new Map(
		references
			.filter((reference) => reference.propertyPath === "class")
			.map((reference) => [reference.ownerPath, reference.targetPath])
	);
	return references.flatMap((reference) => {
		if (reference.propertyPath === "class") return [];
		const action = actions.has(reference.targetPath)
			? reference.targetPath
			: byIdentity.get(contextIdentity(reference.targetPath));
		if (action === undefined) return [];
		return [
			{
				action,
				blueprint,
				ownerPath: reference.ownerPath,
				propertyPath: reference.propertyPath,
				kind: nodeKind(ownerClass.get(reference.ownerPath))
			}
		];
	});
}

/** Package names of the scanned actions: the names a referencing Blueprint saves in its name map. */
export function inputActionPackageNames(report: EnhancedInputReport): readonly string[] {
	return [...new Set(report.actions.map((action) => contextIdentity(action.objectPath)))].sort(
		(left, right) => left.localeCompare(right)
	);
}

/** A package the search could not read or classify. */
export interface BlueprintSearchFailure {
	readonly path: string;
	readonly message: string;
}

export interface BlueprintCandidateSelection {
	/** Package paths to decode, at most `maximumBlueprints`, in path order. */
	readonly paths: readonly string[];
	/** Blueprint packages the header scan listed. */
	readonly blueprints: number;
	/** Blueprints left after the name-map probe; equal to `blueprints` without one. */
	readonly matched: number;
	/** Matches beyond the decode bound, which were not decoded. */
	readonly skipped: number;
	/** Packages whose header could not be read, so whether they are Blueprints is unknown. */
	readonly headerFailures: readonly BlueprintSearchFailure[];
}

/**
 * Chooses which Blueprint packages to decode from a header scan. The base is every package with a
 * `...Blueprint` export, the same set the Blueprint search catalog lists. When the header scan also
 * asked for the action package names, a package whose name map holds none of them cannot
 * reference an action and is dropped. The bound is explicit; what it cuts is reported, and so are
 * the headers the scan could not read.
 */
export function blueprintInputCandidatePaths(
	index: SavedAssetScan,
	options: { readonly maximumBlueprints: number; readonly nameProbe: boolean }
): BlueprintCandidateSelection {
	const blueprints = index.assets.flatMap((entry) =>
		entry.depth === "header" &&
		entry.header.exports.some((exported) => exported.class_name?.endsWith("Blueprint") === true)
			? [entry.header]
			: []
	);
	const matched = blueprints
		.filter((header) => !options.nameProbe || (header.matched_names?.length ?? 0) > 0)
		.map((header) => header.path)
		.sort((left, right) => left.localeCompare(right));
	return {
		paths: matched.slice(0, options.maximumBlueprints),
		blueprints: blueprints.length,
		matched: matched.length,
		skipped: Math.max(0, matched.length - options.maximumBlueprints),
		headerFailures: index.failures.map((failure) => ({
			path: failure.path,
			message: failure.message
		}))
	};
}

/** A Blueprint that decoded only in part; its uses are kept, but more may be unseen. */
export interface BlueprintPartialRead {
	readonly path: string;
	readonly blueprint: string;
	readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
	readonly coverageGaps: readonly {
		readonly objectPath: string;
		readonly reason: string;
		readonly detail: string;
	}[];
}

/**
 * What a Blueprint scan covered, so "no known use" is read against its real coverage. `complete`
 * is true only when every matched Blueprint decoded fully and no header failed.
 */
export type BlueprintUseCoverage =
	| { readonly status: "not_scanned" }
	| {
			readonly status: "scanned";
			readonly complete: boolean;
			readonly blueprints: number;
			readonly matched: number;
			/** Blueprints read, fully or in part. */
			readonly decoded: number;
			readonly skipped: number;
			readonly failed: readonly BlueprintSearchFailure[];
			readonly partial: readonly BlueprintPartialRead[];
			readonly headerFailures: readonly BlueprintSearchFailure[];
	  };

/** Whether nothing a scan saw prevents a use from having been missed. */
export function blueprintCoverageComplete(
	coverage: Omit<Extract<BlueprintUseCoverage, { status: "scanned" }>, "status" | "complete">
): boolean {
	return (
		coverage.skipped === 0 &&
		coverage.failed.length === 0 &&
		coverage.partial.length === 0 &&
		coverage.headerFailures.length === 0
	);
}

/** Where an action is mapped: a context's defaults (`profileId` null) or one key profile. */
export interface InputActionMappingPlace {
	readonly context: string;
	readonly profileId: string | null;
}

export interface InputActionUsage {
	readonly action: string;
	readonly name: string;
	readonly status: "used" | "no_known_use";
	/** Mapping contexts whose default mappings map this action. */
	readonly contexts: readonly string[];
	/** Key-profile override mappings that map this action, by context and profile. */
	readonly profiles: readonly InputActionMappingPlace[];
	/** Config assets that hold one of those contexts. */
	readonly configs: readonly string[];
	/** Trigger edges that name this action, such as a chord on another action's mapping. */
	readonly referencedBy: readonly InputActionEdge[];
	readonly blueprints: readonly BlueprintInputActionUse[];
}

export interface InputUnboundMapping {
	readonly context: string;
	/** The key profile whose override holds the mapping; null for default mappings. */
	readonly profileId: string | null;
	readonly index: number;
	readonly action: string | null;
	readonly reason: "no_action" | "key_not_serialized";
}

export interface InputUsageReport {
	readonly actions: readonly InputActionUsage[];
	readonly noKnownUse: readonly string[];
	readonly unboundMappings: readonly InputUnboundMapping[];
	/** Mapping targets that are not among the scanned actions, such as plugin content. */
	readonly unresolvedActionTargets: readonly {
		readonly context: string;
		readonly profileId: string | null;
		readonly action: string;
	}[];
	readonly blueprintCoverage: BlueprintUseCoverage;
}

/**
 * Joins contexts (default and key-profile mappings), config assets, trigger edges and Blueprint
 * uses onto each action.
 */
export function inputActionUsage(
	report: EnhancedInputReport,
	options?: {
		readonly blueprintUses?: readonly BlueprintInputActionUse[];
		readonly blueprintCoverage?: BlueprintUseCoverage;
	}
): InputUsageReport {
	const actionPaths = new Set(report.actions.map((action) => String(action.objectPath)));
	const placesByAction = new Map<string, Map<string, InputActionMappingPlace>>();
	const unboundMappings: InputUnboundMapping[] = [];
	const unresolved = new Map<
		string,
		{ context: string; profileId: string | null; action: string }
	>();
	for (const { context, profileId, index, mapping } of savedMappings(report)) {
		const where = { context: context.objectPath, profileId };
		if (mapping.action === null) {
			unboundMappings.push({ ...where, index, action: null, reason: "no_action" });
			continue;
		}
		if (mapping.keyName.status !== "available") {
			unboundMappings.push({
				...where,
				index,
				action: mapping.action,
				reason: "key_not_serialized"
			});
		}
		const placeKey = `${context.objectPath}\n${profileId ?? ""}`;
		if (!actionPaths.has(mapping.action)) {
			unresolved.set(`${placeKey}\n${mapping.action}`, { ...where, action: mapping.action });
		}
		const places = placesByAction.get(mapping.action) ?? new Map();
		places.set(placeKey, where);
		placesByAction.set(mapping.action, places);
	}
	const configsByContext = new Map<string, Set<string>>();
	for (const config of report.playerMappableConfigs ?? []) {
		if (config.contexts.status !== "available") continue;
		for (const entry of config.contexts.value) {
			if (entry.context === null) continue;
			const identity = contextIdentity(entry.context);
			const configs = configsByContext.get(identity) ?? new Set<string>();
			configs.add(config.objectPath);
			configsByContext.set(identity, configs);
		}
	}
	const edges = inputActionEdges(report);
	const blueprintUses = options?.blueprintUses ?? [];
	const actions = report.actions.map((record): InputActionUsage => {
		const action = String(record.objectPath);
		const places = [...(placesByAction.get(action)?.values() ?? [])];
		const contexts = places
			.filter((place) => place.profileId === null)
			.map((place) => place.context)
			.sort();
		const profiles = places
			.filter((place) => place.profileId !== null)
			.sort(
				(left, right) =>
					left.context.localeCompare(right.context) ||
					(left.profileId ?? "").localeCompare(right.profileId ?? "")
			);
		const configs = [
			...new Set(
				places.flatMap((place) => [
					...(configsByContext.get(contextIdentity(place.context)) ?? [])
				])
			)
		].sort();
		const referencedBy = edges.filter((edge) => edge.to === action && edge.from !== action);
		const blueprints = blueprintUses.filter((use) => use.action === action);
		return {
			action,
			name: objectName(action),
			status:
				places.length > 0 || referencedBy.length > 0 || blueprints.length > 0
					? "used"
					: "no_known_use",
			contexts,
			profiles,
			configs,
			referencedBy,
			blueprints
		};
	});
	return {
		actions,
		noKnownUse: actions
			.filter((action) => action.status === "no_known_use")
			.map((action) => action.action),
		unboundMappings,
		unresolvedActionTargets: [...unresolved.values()],
		blueprintCoverage: options?.blueprintCoverage ?? { status: "not_scanned" }
	};
}
