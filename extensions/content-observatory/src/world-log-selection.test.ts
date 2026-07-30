import { describe, expect, it } from "vitest";
import {
	actorKeyOfSelection,
	changeSelectionOf,
	changelistSelectionOf,
	noWorldLogSelection,
	selectWorldLogActor,
	selectWorldLogChangelist,
	selectWorldLogChange
} from "./world-log-selection.js";

describe("World Log selection", () => {
	it("keeps actor attribution and the selected semantic change together", () => {
		const selection = selectWorldLogChange(noWorldLogSelection, {
			actorKey: "guid:arrival",
			changeIndex: 3,
			revision: 4
		});

		expect(actorKeyOfSelection(selection)).toBe("guid:arrival");
		expect(changeSelectionOf(selection)).toEqual({
			changeIndex: 3,
			kind: "change",
			revision: 4
		});
	});

	it("retains a submitted changelist when its map diff selects an actor", () => {
		const changelist = selectWorldLogChangelist(noWorldLogSelection, 1);
		const selection = selectWorldLogActor(changelist, "guid:east");

		expect(actorKeyOfSelection(selection)).toBe("guid:east");
		expect(changelistSelectionOf(selection)).toEqual({ kind: "changelist", revision: 1 });
	});

	it("allows a selected changelist to be cleared without dropping an actor filter", () => {
		const actor = selectWorldLogActor(noWorldLogSelection, "guid:north");
		const selected = selectWorldLogChangelist(actor, 2);

		expect(selectWorldLogChangelist(selected, 2)).toEqual({
			actorKey: "guid:north",
			changelist: undefined
		});
	});
});
