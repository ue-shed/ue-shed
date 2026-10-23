import type { CustomLocalizationCheck, GameTextRuleDocument } from "./game-text-rules.js";

/** The custom checks of a rule file, in the file's order; none before version 3. */
export function customLocalizationChecks(
	document: GameTextRuleDocument | undefined
): readonly CustomLocalizationCheck[] {
	return document?.schemaVersion === 3 ? (document.customChecks ?? []) : [];
}
