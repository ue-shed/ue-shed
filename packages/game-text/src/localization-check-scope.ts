import { textLocationPath } from "./text-origin.js";
import { Schema } from "effect";
import { CultureCode } from "@ue-shed/localization/browser";
import { TextRoleId, type TextRole } from "./quality-schema.js";
import { matchesTextRole } from "./quality.js";
import type { TextOccurrence } from "./schema.js";

/**
 * Where a check applies. Each listed dimension must match: a finding's culture is one of
 * `cultures`, and one of its saved places is at a place of one of `roles` and under one of
 * `pathPrefixes` (object paths, compared as written). A finding with no saved place, such as
 * gathered-only text, matches no `roles` or `pathPrefixes` scope.
 */
export const LocalizationCheckScope = Schema.Struct({
	roles: Schema.optionalKey(
		Schema.Array(TextRoleId).check(Schema.isMinLength(1), Schema.isMaxLength(64))
	),
	cultures: Schema.optionalKey(
		Schema.Array(CultureCode).check(Schema.isMinLength(1), Schema.isMaxLength(256))
	),
	pathPrefixes: Schema.optionalKey(
		Schema.Array(Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(1024))).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(64)
		)
	)
});
export type LocalizationCheckScope = typeof LocalizationCheckScope.Type;

/**
 * Whether a check's scope holds for a finding in `culture` with these saved places: its culture is
 * listed, and one saved place is at a place of a listed role and under a listed path prefix. A
 * finding without saved places is outside any role or path scope. No scope holds everywhere.
 * `occurrences` is called only when the scope names roles or path prefixes.
 */
export function localizationCheckInScope(
	scope: LocalizationCheckScope | undefined,
	culture: CultureCode,
	occurrences: () => ReadonlyArray<Pick<TextOccurrence, "location">>,
	roles: ReadonlyMap<string, TextRole>
): boolean {
	if (!scope) return true;
	if (scope.cultures && !scope.cultures.includes(culture)) return false;
	if (!scope.roles && !scope.pathPrefixes) return true;
	const scopeRoles = scope.roles?.flatMap((id) => {
		const role = roles.get(id);
		return role ? [role] : [];
	});
	return occurrences().some(
		(occurrence) =>
			(!scopeRoles || scopeRoles.some((role) => matchesTextRole(occurrence, role))) &&
			(!scope.pathPrefixes ||
				scope.pathPrefixes.some((prefix) =>
					textLocationPath(occurrence.location).startsWith(prefix)
				))
	);
}
