import { BuiltInCheckId } from "./localization-check-ids.js";
import { GameTextLocalizationError } from "./localization-schema.js";
import { resolveLocalizationChecks } from "./game-text-rules.js";
export { localizationShippedTranslation, LocalizationShippedTranslation } from "./localization-shipped-translation.js";
/** Rejects a selection outside the target and lists the built-in checks that run. */
export function enabledLocalizationChecks(join, evidence, options = {}, ruleDocument) {
    if (join.target !== evidence.target.name ||
        (options.culture !== undefined && !join.cultures.includes(options.culture)))
        throw new GameTextLocalizationError({
            retrySafe: false,
            nextStep: "fix_input",
            code: "invalid_selection",
            message: "The localization check selection is invalid.",
            recovery: "Choose a loaded target and one of its listed cultures."
        });
    const disabled = new Set(options.disabledChecks ?? []);
    const checks = resolveLocalizationChecks(ruleDocument);
    return BuiltInCheckId.literals.filter((id) => checks[id].enabled &&
        !disabled.has(id) &&
        (!options.checks || options.checks.includes(id)));
}
/** Built-in finding order: line, culture, check, then the observed value. */
export function compareLocalizationFindings(a, b) {
    return (a.lineId.localeCompare(b.lineId) ||
        a.culture.localeCompare(b.culture) ||
        a.kind.localeCompare(b.kind) ||
        JSON.stringify(a.actual).localeCompare(JSON.stringify(b.actual)));
}
/** Report order once policy findings join the built-ins. */
export function compareReportedLocalizationFindings(a, b) {
    return (a.lineId.localeCompare(b.lineId) ||
        a.culture.localeCompare(b.culture) ||
        a.kind.localeCompare(b.kind) ||
        a.ruleId.localeCompare(b.ruleId) ||
        JSON.stringify(a.actual).localeCompare(JSON.stringify(b.actual)));
}
