import { DateTime } from "effect";
import type { MapChange, PerforceMapRevision } from "@ue-shed/map-history/contract";

export type WorldLogChangeTone = "added" | "removed" | "changed" | "warning";

export function changeTitle(change: MapChange): string {
	switch (change.kind) {
		case "actor_added":
			return change.after.label ?? shortActorPath(change.after.actorPath);
		case "actor_removed":
			return change.before.label ?? shortActorPath(change.before.actorPath);
		case "snapshot_coverage_changed":
			return "Snapshot coverage";
		default:
			return (
				change.after.label ?? change.before.label ?? shortActorPath(change.after.actorPath)
			);
	}
}

export function changeDetail(change: MapChange): string {
	switch (change.kind) {
		case "actor_added":
			return "New saved actor";
		case "actor_removed":
			return "Removed from saved map";
		case "actor_moved":
			return `${point(change.beforeLocation)} → ${point(change.afterLocation)}`;
		case "actor_label_changed":
			return `${change.before.label ?? "No label"} → ${change.after.label ?? "No label"}`;
		case "actor_class_changed":
			return `${shortClass(change.before.classPath)} → ${shortClass(change.after.classPath)}`;
		case "actor_package_changed":
			return `${change.before.packageName} → ${change.after.packageName}`;
		case "actor_position_resolution_changed":
			return `${change.beforePosition.status} → ${change.afterPosition.status}`;
		case "snapshot_coverage_changed":
			return `${change.before.completeness} → ${change.after.completeness}`;
	}
}

export function changeTone(kind: MapChange["kind"]): WorldLogChangeTone {
	if (kind === "actor_added") return "added";
	if (kind === "actor_removed") return "removed";
	if (kind === "snapshot_coverage_changed") return "warning";
	return "changed";
}

export function formatSubmittedAt(revision: PerforceMapRevision): string {
	return new Date(DateTime.toEpochMillis(revision.submittedAt)).toLocaleString();
}

export function humanize(value: string): string {
	return value.replaceAll("_", " ");
}

export function point(value: {
	readonly x: number;
	readonly y: number;
	readonly z: number;
}): string {
	return `${value.x.toFixed(0)}, ${value.y.toFixed(0)}, ${value.z.toFixed(0)}`;
}

export function shortActorPath(path: string): string {
	return path.split(".").at(-1) ?? path;
}

export function shortClass(path: string): string {
	return path.split(".").at(-1) ?? path;
}
