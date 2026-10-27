import { makeGameTextWorkspaceLocalization } from "@ue-shed/game-text/workspace";
import { LocalizationFileAccessLive } from "@ue-shed/localization";

type Inputs = Parameters<typeof makeGameTextWorkspaceLocalization>;

/** Workbench's localization half of the Game Text workspace, writing as `workbench`. */
export const makeGameTextLocalization = (
	currentCorpus: Inputs[0],
	currentProject: Inputs[1],
	currentRules?: Inputs[2],
	currentIndex?: Inputs[3],
	prepareWrites?: NonNullable<Inputs[4]>["prepareWrites"]
) =>
	makeGameTextWorkspaceLocalization(currentCorpus, currentProject, currentRules, currentIndex, {
		author: "workbench",
		localizationFiles: LocalizationFileAccessLive,
		...(prepareWrites ? { prepareWrites } : undefined)
	});
