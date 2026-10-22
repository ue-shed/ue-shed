// Classifies contested keys against co-activation sets. "Contested" (two contexts name one key)
// stays the base evidence. A class is only claimed when a co-activation source says the two
// contexts can be active together, and priorities only come from that source.

import { buildInputAtlas, type AtlasClaim, type AtlasDevice } from "./atlas.js";
import { contextIdentity, type CoActivationSet } from "./coactivation.js";
import type { EnhancedInputReport, InputActionRecord } from "./schema.js";

export const INPUT_CONFLICT_CLASSES = [
	"shadowed",
	"may_shadow",
	"both_fire",
	"ambiguous_priority",
	"qualified",
	"cross_context"
] as const;
export type InputConflictClass = (typeof INPUT_CONFLICT_CLASSES)[number];

/** Whether the higher-priority action consumes the key, as saved on the action. */
export type InputConsumption = "consumes" | "passes_through" | "not_serialized";

export interface InputConflict {
	readonly key: string;
	readonly classification: InputConflictClass;
	/** The co-activation set that makes the pair co-active; null for `cross_context`. */
	readonly setId: string | null;
	/** When the set states two different priorities, the higher-priority claim comes first. */
	readonly claims: readonly [AtlasClaim, AtlasClaim];
	readonly priorities: readonly [number | null, number | null];
	/** Present when the priorities differ: what the higher action's saved `bConsumeInput` says. */
	readonly consumption?: InputConsumption;
	readonly reason: string;
}

export interface InputConflictKey {
	readonly key: string;
	readonly device: AtlasDevice;
	readonly contested: boolean;
	readonly classes: readonly InputConflictClass[];
	readonly conflicts: readonly InputConflict[];
}

export interface InputConflictAnalysis {
	/** False when no co-activation set was supplied, so only `contested` is claimed. */
	readonly classified: boolean;
	readonly coActivationSets: readonly CoActivationSet[];
	readonly keys: readonly InputConflictKey[];
	/** Keys per class, plus `contested` keys. */
	readonly counts: Readonly<Record<InputConflictClass | "contested", number>>;
}

function className(classPath: string | null): string | undefined {
	return classPath === null ? undefined : (classPath.split(".").at(-1) ?? classPath);
}

/**
 * Unreal's own chord test is `Cast<UInputTriggerChordAction>` on the mapping's and its action's
 * triggers, so any subclass counts, and a chorded mapping never consumes its key (UE 5.7 and 5.8
 * `IEnhancedInputSubsystemInterface::RebuildControlMappings`). The engine's chord classes are
 * known by name. `ChordAction` is declared on `UInputTriggerChordAction`, so a saved one proves a
 * project class derives from it. Any other class outside the plugin may still derive from it
 * without saving that property, so its ancestry is unknown.
 */
function chordEvidence(
	classPath: string | null,
	parameters: readonly { readonly name: string }[] | null | undefined
): "chord" | "not_chord" | "unknown" {
	const name = className(classPath);
	if (name === "InputTriggerChordAction" || name === "InputTriggerChordBlocker") return "chord";
	if (parameters?.some((parameter) => parameter.name === "ChordAction")) return "chord";
	return classPath?.startsWith("/Script/EnhancedInput.") ? "not_chord" : "unknown";
}

function claimChordEvidence(claim: AtlasClaim, action: InputActionRecord | undefined) {
	return [
		...claim.triggerDetails.map((detail) => chordEvidence(detail.classPath, detail.parameters)),
		...(action?.triggers ?? []).map((trigger) =>
			chordEvidence(trigger.classPath ?? null, trigger.parameters)
		)
	];
}

/** Trigger classes whose saved reference ties a mapping to another action. */
function isChordLike(classPath: string | null): boolean {
	const name = className(classPath);
	return name !== undefined && (name.includes("Chord") || name.includes("Combo"));
}

function claimTriggerClasses(
	claim: AtlasClaim,
	action: InputActionRecord | undefined
): readonly (string | null)[] {
	return [
		...claim.triggerDetails.map((detail) => detail.classPath),
		...(action?.triggers ?? []).map((trigger) => trigger.classPath ?? null)
	];
}

function triggerClasses(claim: AtlasClaim, action: InputActionRecord | undefined): string[] {
	return [
		...claim.triggerDetails.map((detail) => detail.classPath ?? detail.label),
		...(action?.triggers ?? []).map((trigger) => trigger.classPath ?? trigger.objectPath)
	].sort((left, right) => left.localeCompare(right));
}

function actionOf(
	claim: AtlasClaim,
	actions: ReadonlyMap<string, InputActionRecord>
): InputActionRecord | undefined {
	return claim.actionPath === null ? undefined : actions.get(claim.actionPath);
}

function qualification(
	left: AtlasClaim,
	right: AtlasClaim,
	actions: ReadonlyMap<string, InputActionRecord>
): string | undefined {
	const leftAction = actionOf(left, actions);
	const rightAction = actionOf(right, actions);
	const chord =
		claimTriggerClasses(left, leftAction).some(isChordLike) ||
		claimTriggerClasses(right, rightAction).some(isChordLike);
	if (chord) return "A chord or combo trigger qualifies one of the claims.";
	const leftTriggers = triggerClasses(left, leftAction);
	const rightTriggers = triggerClasses(right, rightAction);
	if (leftTriggers.join("\n") !== rightTriggers.join("\n")) {
		return "The claims fire on different triggers.";
	}
	return undefined;
}

function consumptionOf(action: InputActionRecord | undefined): InputConsumption {
	if (action === undefined || action.consumeInput.status !== "available") return "not_serialized";
	return action.consumeInput.value ? "consumes" : "passes_through";
}

/**
 * Two stated, different priorities. Unreal applies the higher context first and, unless that
 * mapping is chorded, a higher action with `bConsumeInput` keeps the key from every lower context,
 * whatever either mapping's triggers are.
 */
function classifyOrdered(options: {
	readonly key: string;
	readonly setId: string;
	readonly higher: AtlasClaim;
	readonly lower: AtlasClaim;
	readonly priorities: readonly [number, number];
	readonly actions: ReadonlyMap<string, InputActionRecord>;
}): InputConflict {
	const { key, setId, higher, lower, priorities, actions } = options;
	const higherAction = actionOf(higher, actions);
	const consumption = consumptionOf(higherAction);
	const claims: readonly [AtlasClaim, AtlasClaim] = [higher, lower];
	const base = { key, setId, claims, priorities, consumption };
	const chords = claimChordEvidence(higher, higherAction);
	if (chords.includes("chord")) {
		return {
			...base,
			classification: "qualified",
			reason: `The ${higher.contextName} mapping is chorded, so it never consumes the key, and Unreal blocks same-key mappings while the chord holds.`
		};
	}
	if (consumption === "consumes" && chords.includes("unknown")) {
		return {
			...base,
			classification: "may_shadow",
			reason: `${higher.contextName} has the higher priority and its action consumes input, so it hides ${lower.contextName} unless one of its project trigger classes derives from Unreal's chord trigger, which the saved data does not show.`
		};
	}
	if (consumption === "consumes") {
		return {
			...base,
			classification: "shadowed",
			reason: `${higher.contextName} has the higher priority and its action consumes input, so the ${lower.contextName} mapping never receives the key, whatever its triggers.`
		};
	}
	if (consumption === "not_serialized") {
		return {
			...base,
			classification: "may_shadow",
			reason: `${higher.contextName} has the higher priority. It hides ${lower.contextName} only if its action consumes input, and bConsumeInput is not saved for it.`
		};
	}
	const qualified = qualification(higher, lower, actions);
	return qualified === undefined
		? {
				...base,
				classification: "both_fire",
				reason: `${higher.contextName} has the higher priority but its action passes input through, so both actions fire.`
			}
		: {
				...base,
				classification: "qualified",
				reason: `The ${higher.contextName} action passes input through. ${qualified}`
			};
}

function priorityIn(set: CoActivationSet, contextPath: string): number | null | undefined {
	const identity = contextIdentity(contextPath);
	const member = set.contexts.find(
		(candidate) => contextIdentity(candidate.context) === identity
	);
	return member === undefined ? undefined : member.priority;
}

function classifyPair(
	key: string,
	left: AtlasClaim,
	right: AtlasClaim,
	sets: readonly CoActivationSet[],
	actions: ReadonlyMap<string, InputActionRecord>
): InputConflict[] {
	const shared = sets.flatMap((set) => {
		const leftPriority = priorityIn(set, left.contextPath);
		const rightPriority = priorityIn(set, right.contextPath);
		return leftPriority === undefined || rightPriority === undefined
			? []
			: [{ set, leftPriority, rightPriority }];
	});
	if (shared.length === 0) {
		return [
			{
				key,
				classification: "cross_context",
				setId: null,
				claims: [left, right],
				priorities: [null, null],
				reason: "No co-activation set holds both contexts."
			}
		];
	}
	return shared.map(({ set, leftPriority, rightPriority }): InputConflict => {
		if (leftPriority !== null && rightPriority !== null && leftPriority !== rightPriority) {
			const leftHigher = leftPriority > rightPriority;
			return classifyOrdered({
				key,
				setId: set.id,
				higher: leftHigher ? left : right,
				lower: leftHigher ? right : left,
				priorities: leftHigher
					? [leftPriority, rightPriority]
					: [rightPriority, leftPriority],
				actions
			});
		}
		const qualified = qualification(left, right, actions);
		if (qualified !== undefined) {
			return {
				key,
				classification: "qualified",
				setId: set.id,
				claims: [left, right],
				priorities: [leftPriority, rightPriority],
				reason: qualified
			};
		}
		return {
			key,
			classification: "ambiguous_priority",
			setId: set.id,
			claims: [left, right],
			priorities: [leftPriority, rightPriority],
			reason:
				leftPriority === null || rightPriority === null
					? "The set does not state a priority for both contexts."
					: "Both contexts share one priority."
		};
	});
}

/**
 * Classifies every contested key. Pass no sets to get the honest base: contested keys, no classes.
 * Sets are matched to contexts by package path, so object and package paths both work.
 */
export function classifyInputConflicts(
	report: EnhancedInputReport,
	sets: readonly CoActivationSet[],
	options?: { readonly contexts?: readonly string[] }
): InputConflictAnalysis {
	const atlas = buildInputAtlas(report, options);
	const actions = new Map(report.actions.map((action) => [String(action.objectPath), action]));
	const classified = sets.length > 0;
	const keys = atlas.keys
		.filter((entry) => entry.contested)
		.map((entry): InputConflictKey => {
			const conflicts: InputConflict[] = [];
			if (classified) {
				for (let left = 0; left < entry.claims.length; left += 1) {
					for (let right = left + 1; right < entry.claims.length; right += 1) {
						const leftClaim = entry.claims[left]!;
						const rightClaim = entry.claims[right]!;
						if (leftClaim.contextPath === rightClaim.contextPath) continue;
						conflicts.push(
							...classifyPair(entry.key, leftClaim, rightClaim, sets, actions)
						);
					}
				}
			}
			const classes = INPUT_CONFLICT_CLASSES.filter((name) =>
				conflicts.some((conflict) => conflict.classification === name)
			);
			return { key: entry.key, device: entry.device, contested: true, classes, conflicts };
		});
	const counts = {
		contested: keys.length,
		shadowed: 0,
		may_shadow: 0,
		both_fire: 0,
		ambiguous_priority: 0,
		qualified: 0,
		cross_context: 0
	};
	for (const entry of keys) for (const name of entry.classes) counts[name] += 1;
	return { classified, coActivationSets: sets, keys, counts };
}
