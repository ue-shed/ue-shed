import type { MapChange, PerforceMapRevision } from "@ue-shed/map-history/contract";
import type { SavedWorldActor } from "@ue-shed/protocol";
import type { PointMapConnection, PointMapPoint } from "@ue-shed/ui/point-map-core";
import { actorKeyFromChange } from "./world-log-actors.js";

export type WorldLogChangelistTone = "added" | "changed" | "moved" | "removed";

export interface WorldLogChangelistSummary {
	readonly added: number;
	readonly changed: number;
	readonly moved: number;
	readonly removed: number;
	readonly semanticChanges: number;
	readonly unclassified: number;
	readonly unresolvedActorChanges: number;
}

export interface WorldLogChangelistMapOverlay {
	readonly connections: ReadonlyArray<PointMapConnection>;
	readonly points: ReadonlyArray<PointMapPoint>;
	readonly summary: WorldLogChangelistSummary;
}

const toneColors: Readonly<Record<WorldLogChangelistTone, string>> = {
	added: "#6ebd88",
	changed: "#e1b85e",
	moved: "#73c7d0",
	removed: "#d77d6a"
};

export function worldLogChangelistToneColor(tone: WorldLogChangelistTone): string {
	return toneColors[tone];
}

export function worldLogChangelistTone(change: MapChange): WorldLogChangelistTone | undefined {
	switch (change.kind) {
		case "actor_added":
			return "added";
		case "actor_removed":
			return "removed";
		case "actor_moved":
			return "moved";
		case "snapshot_coverage_changed":
			return undefined;
		default:
			return "changed";
	}
}

function pointForActor(input: {
	readonly actor: SavedWorldActor;
	readonly color: string;
	readonly key: string;
	readonly opacity?: number;
	readonly selectionKey: string;
}): PointMapPoint | undefined {
	if (input.actor.position.status !== "resolved") return undefined;
	return {
		className: input.actor.classPath,
		color: input.color,
		key: input.key,
		...(input.opacity === undefined ? {} : { opacity: input.opacity }),
		selectionKey: input.selectionKey,
		x: input.actor.position.location.x,
		y: input.actor.position.location.y
	};
}

function actorEvidence(
	change: MapChange
): { readonly after: SavedWorldActor; readonly before?: SavedWorldActor } | undefined {
	switch (change.kind) {
		case "actor_added":
			return { after: change.after };
		case "actor_removed":
			return { after: change.before };
		case "actor_moved":
		case "actor_label_changed":
		case "actor_class_changed":
		case "actor_package_changed":
		case "actor_position_resolution_changed":
			return { after: change.after, before: change.before };
		case "snapshot_coverage_changed":
			return undefined;
	}
}

function initialSummary(revision: PerforceMapRevision): WorldLogChangelistSummary {
	return {
		added: 0,
		changed: 0,
		moved: 0,
		removed: 0,
		semanticChanges: revision.changes.length,
		unclassified: revision.unclassifiedPackageChanges.length,
		unresolvedActorChanges: 0
	};
}

/**
 * Turns the selected submitted revision's semantic evidence into a static shared point-map layer.
 * Map History has already done all acquisition; this only derives visual evidence locally.
 */
export function worldLogChangelistMapOverlay(
	revision: PerforceMapRevision
): WorldLogChangelistMapOverlay {
	const points: PointMapPoint[] = [];
	const connections: PointMapConnection[] = [];
	let summary = initialSummary(revision);
	for (const [changeIndex, change] of revision.changes.entries()) {
		const tone = worldLogChangelistTone(change);
		const actorKey = actorKeyFromChange(change);
		const evidence = actorEvidence(change);
		if (tone === undefined || actorKey === undefined || evidence === undefined) continue;
		summary = { ...summary, [tone]: summary[tone] + 1 };
		const keyPrefix = `${actorKey}:${changeIndex}`;
		const after = pointForActor({
			actor: evidence.after,
			color: worldLogChangelistToneColor(tone),
			key: `${keyPrefix}:after`,
			opacity: tone === "removed" ? 0.42 : 1,
			selectionKey: actorKey
		});
		if (after === undefined) {
			summary = { ...summary, unresolvedActorChanges: summary.unresolvedActorChanges + 1 };
			continue;
		}
		points.push(after);
		if (tone !== "moved" || evidence.before?.position.status !== "resolved") continue;
		const before = pointForActor({
			actor: evidence.before,
			color: worldLogChangelistToneColor(tone),
			key: `${keyPrefix}:before`,
			opacity: 0.38,
			selectionKey: actorKey
		});
		if (before === undefined) continue;
		points.push(before);
		connections.push({
			color: worldLogChangelistToneColor(tone),
			fromX: before.x,
			fromY: before.y,
			key: `${keyPrefix}:movement`,
			opacity: 0.85,
			toX: after.x,
			toY: after.y
		});
	}
	return { connections, points, summary };
}
