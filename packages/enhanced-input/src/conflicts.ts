// Classifies contested keys against co-activation sets. "Contested" (two contexts name one key)
// stays the base evidence. A class is only claimed when a co-activation source says the two
// contexts can be active together, and priorities only come from that source.

import { buildInputAtlas, type AtlasClaim, type AtlasDevice } from "./atlas.js";
import { contextIdentity, type CoActivationSet } from "./coactivation.js";
import type { EnhancedInputReport, InputActionRecord } from "./schema.js";

export const INPUT_CONFLICT_CLASSES = [
	"shadowed",
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
	/** For `shadowed`, the higher-priority claim comes first. */
	readonly claims: readonly [AtlasClaim, AtlasClaim];
	readonly priorities: readonly [number | null, number | null];
	/** Present for `shadowed`. A higher action that passes input through does not hide the lower. */
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

/** Trigger classes whose saved reference ties a mapping to another action. */
function isChordLike(classPath: string | null): boolean {
	if (classPath === null) return false;
	const name = classPath.split(".").at(-1) ?? classPath;
	return name.includes("Chord") || name.includes("Combo");
}

function triggerClasses(claim: AtlasClaim, action: InputActionRecord | undefined): string[] {
	return [
		...claim.triggerDetails.map((detail) => detail.classPath ?? detail.label),
		...(action?.triggers ?? []).map((trigger) => trigger.classPath ?? trigger.objectPath)
	].sort((left, right) => left.localeCompare(right));
}

function qualification(
	left: AtlasClaim,
	right: AtlasClaim,
	actions: ReadonlyMap<string, InputActionRecord>
): string | undefined {
	const leftAction = left.actionPath === null ? undefined : actions.get(left.actionPath);
	const rightAction = right.actionPath === null ? undefined : actions.get(right.actionPath);
	const chord = [left, right].some(
		(claim) =>
			claim.triggerDetails.some((detail) => isChordLike(detail.classPath)) ||
			((claim === left ? leftAction : rightAction)?.triggers ?? []).some((trigger) =>
				isChordLike(trigger.classPath ?? null)
			)
	);
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
		if (leftPriority !== null && rightPriority !== null && leftPriority !== rightPriority) {
			const [higher, lower, higherPriority, lowerPriority] =
				leftPriority > rightPriority
					? [left, right, leftPriority, rightPriority]
					: [right, left, rightPriority, leftPriority];
			const consumption = consumptionOf(
				higher.actionPath === null ? undefined : actions.get(higher.actionPath)
			);
			return {
				key,
				classification: "shadowed",
				setId: set.id,
				claims: [higher, lower],
				priorities: [higherPriority, lowerPriority],
				consumption,
				reason:
					consumption === "passes_through"
						? `${higher.contextName} has the higher priority but its action passes input through, so both fire.`
						: `${higher.contextName} has the higher priority and hides ${lower.contextName}.`
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
		ambiguous_priority: 0,
		qualified: 0,
		cross_context: 0
	};
	for (const entry of keys) for (const name of entry.classes) counts[name] += 1;
	return { classified, coActivationSets: sets, keys, counts };
}
