import { decodeTextCorpusRunResult, type TextCorpusRunResult } from "@ue-shed/game-text/browser";
import type { GameTextClient } from "@ue-shed/extension-game-text";

function decodeResult(value: unknown): TextCorpusRunResult {
	try {
		return decodeTextCorpusRunResult(value);
	} catch (cause) {
		return {
			status: "failed",
			error: {
				code: "contract_failure",
				message: `Workbench received an invalid game text result: ${String(cause)}`,
				recovery: "Restart Workbench. If the problem persists, verify package versions.",
				retrySafe: true
			}
		};
	}
}

export const gameTextClient: GameTextClient = {
	loadConfiguredProject: async () =>
		decodeResult(await window.ueShed.gameText.loadConfiguredProject()),
	chooseProjectAndScan: async () =>
		decodeResult(await window.ueShed.gameText.chooseProjectAndScan())
};
