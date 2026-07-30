import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PerforceMapRevision } from "@ue-shed/map-history/contract";
import { worldLogChangelistMapOverlay } from "./world-log-changelist.js";

const decodeRevision = Schema.decodeUnknownSync(PerforceMapRevision);

function actor(input: {
	readonly guid: string;
	readonly label: string;
	readonly x: number;
	readonly y: number;
}) {
	return {
		actorGuid: input.guid,
		actorPath: `/Game/Maps/L_Example.L_Example:PersistentLevel.${input.label}`,
		classPath: "/Script/Game.Npc",
		label: input.label,
		packageName: `/Game/Actors/${input.label}`,
		position: { location: { x: input.x, y: input.y, z: 0 }, status: "resolved" as const }
	};
}

describe("World Log changelist map overlay", () => {
	it("derives added, removed, changed, and movement evidence without another history read", () => {
		const revision = decodeRevision({
			change: 42,
			changes: [
				{
					after: actor({ guid: "added", label: "Added", x: 10, y: 20 }),
					identity: { actorGuid: "added", kind: "actor_guid" },
					kind: "actor_added"
				},
				{
					before: actor({ guid: "removed", label: "Removed", x: 30, y: 40 }),
					identity: { actorGuid: "removed", kind: "actor_guid" },
					kind: "actor_removed"
				},
				{
					after: actor({ guid: "moved", label: "Moved", x: 80, y: 90 }),
					afterLocation: { x: 80, y: 90, z: 0 },
					before: actor({ guid: "moved", label: "Moved", x: 50, y: 60 }),
					beforeLocation: { x: 50, y: 60, z: 0 },
					identity: { actorGuid: "moved", kind: "actor_guid" },
					kind: "actor_moved"
				},
				{
					after: actor({ guid: "changed", label: "Changed", x: 100, y: 110 }),
					before: actor({ guid: "changed", label: "Former", x: 100, y: 110 }),
					identity: { actorGuid: "changed", kind: "actor_guid" },
					kind: "actor_label_changed"
				}
			],
			completeness: "complete",
			diagnostics: [],
			files: [],
			submittedAt: "2026-07-30T00:00:00.000Z",
			unclassifiedPackageChanges: [
				{
					action: "edit",
					afterRevision: 2,
					actorIdentities: [],
					beforeRevision: 1,
					depotPath: "//Project/Main/Content/Maps/L_Example.umap",
					packageName: "/Game/Maps/L_Example",
					reason: "projection_unchanged"
				}
			],
			user: "mapper"
		});

		const overlay = worldLogChangelistMapOverlay(revision);

		expect(overlay.summary).toMatchObject({
			added: 1,
			changed: 1,
			moved: 1,
			removed: 1,
			semanticChanges: 4,
			unclassified: 1,
			unresolvedActorChanges: 0
		});
		expect(overlay.connections).toHaveLength(1);
		expect(overlay.connections[0]).toMatchObject({
			fromX: 50,
			fromY: 60,
			toX: 80,
			toY: 90
		});
		expect(overlay.points).toHaveLength(5);
		expect(overlay.points.find((point) => point.selectionKey === "guid:removed")).toMatchObject(
			{
				opacity: 0.42,
				x: 30,
				y: 40
			}
		);
	});
});
