import { describe, expect, it } from "vitest";
import { actorExplorerMatches, actorExplorerMatchesQuery } from "./actor-explorer-core.js";

const actor = {
	classPath: "/Script/Game.Npc",
	key: "npc-1",
	label: "North guard",
	packageName: "/Game/Actors/NorthGuard",
	path: "/Game/Maps/L_Test.PersistentLevel.NorthGuard",
	searchFields: {
		class: "/Script/Game.Npc",
		guid: "npc-1",
		label: "North guard",
		package: "/Game/Actors/NorthGuard",
		path: "/Game/Maps/L_Test.PersistentLevel.NorthGuard"
	}
} as const;

describe("actor explorer matching", () => {
	it("supports plain and field-qualified terms", () => {
		expect(actorExplorerMatchesQuery(actor, "north guard")).toBe(true);
		expect(actorExplorerMatchesQuery(actor, "class:npc")).toBe(true);
		expect(actorExplorerMatchesQuery(actor, "guid:npc-1")).toBe(true);
		expect(actorExplorerMatchesQuery(actor, "class:light")).toBe(false);
	});

	it("distinguishes all classes from an explicit empty class selection", () => {
		expect(actorExplorerMatches(actor, { classPaths: undefined, query: "" })).toBe(true);
		expect(actorExplorerMatches(actor, { classPaths: [], query: "" })).toBe(false);
		expect(actorExplorerMatches(actor, { classPaths: ["/Script/Game.Npc"], query: "" })).toBe(
			true
		);
	});
});
