/**
 * Actor focus and changelist focus are independent, coordinated local selections. An actor can
 * narrow the evidence while a selected submitted changelist remains stable for its full-map diff.
 */
export type WorldLogChangelistSelection =
	| { readonly kind: "changelist"; readonly revision: number }
	| { readonly changeIndex: number; readonly kind: "change"; readonly revision: number };

export type WorldLogChangeSelection = Extract<
	WorldLogChangelistSelection,
	{ readonly kind: "change" }
>;

export interface WorldLogSelection {
	readonly actorKey: string | undefined;
	readonly changelist: WorldLogChangelistSelection | undefined;
}

export type WorldLogEvent =
	| { readonly actorKey: string | undefined; readonly type: "actor_selected" }
	| {
			readonly actorKey: string | undefined;
			readonly changeIndex: number;
			readonly revision: number;
			readonly type: "actor_event_selected";
	  }
	| { readonly revision: number; readonly type: "changelist_selected" }
	| { readonly revisionIndex: number | undefined; readonly type: "frame_selected" };

export const noWorldLogSelection: WorldLogSelection = {
	actorKey: undefined,
	changelist: undefined
};

export function actorKeyOfSelection(selection: WorldLogSelection): string | undefined {
	return selection.actorKey;
}

export function changelistSelectionOf(
	selection: WorldLogSelection
): WorldLogChangelistSelection | undefined {
	return selection.changelist;
}

export function changeSelectionOf(
	selection: WorldLogSelection
): WorldLogChangeSelection | undefined {
	return selection.changelist?.kind === "change" ? selection.changelist : undefined;
}

export function selectWorldLogActor(
	selection: WorldLogSelection,
	actorKey: string | undefined
): WorldLogSelection {
	return {
		actorKey: actorKey === selection.actorKey ? undefined : actorKey,
		changelist: selection.changelist
	};
}

export function selectWorldLogChangelist(
	selection: WorldLogSelection,
	revision: number
): WorldLogSelection {
	return {
		actorKey: selection.actorKey,
		changelist:
			selection.changelist?.kind === "changelist" &&
			selection.changelist.revision === revision
				? undefined
				: { kind: "changelist", revision }
	};
}

export function selectWorldLogChange(
	selection: WorldLogSelection,
	input: {
		readonly actorKey: string | undefined;
		readonly changeIndex: number;
		readonly revision: number;
	}
): WorldLogSelection {
	return {
		actorKey: input.actorKey,
		changelist: { changeIndex: input.changeIndex, kind: "change", revision: input.revision }
	};
}

export function reduceWorldLogEvent(
	selection: WorldLogSelection,
	event: WorldLogEvent
): WorldLogSelection {
	switch (event.type) {
		case "actor_selected":
			return selectWorldLogActor(selection, event.actorKey);
		case "actor_event_selected":
			return selectWorldLogChange(selection, event);
		case "changelist_selected":
			return selectWorldLogChangelist(selection, event.revision);
		case "frame_selected":
			return selection;
	}
}
