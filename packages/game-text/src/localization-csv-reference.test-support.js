import { textLocationPath } from "./text-origin.js";
import { spreadsheetCsv } from "./csv.js";
import { localizationLineUnits } from "./gathered-text.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import { TEXT_ORIGIN_LABELS, manifestOrigins, textLocationOrigin } from "./text-origin.js";
import { TEXT_AUDIENCE_LABELS } from "./text-audience-schema.js";
import { lineTextAudience, occurrenceTextAudience } from "./text-audience.js";
import { hasSearchableSource } from "./search.js";
import { LOCALIZATION_STATE_LABELS } from "./localization-export.js";
const byCodeUnit = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
/** Independent all-languages CSV oracle for native-writer conformance tests. */
export function referenceLocalizationLinesCsv(input) {
    const { join, lines } = input;
    const units = new Map(input.corpus?.units.map((unit) => [unit.id, unit]));
    const wholeLine = (line) => !("places" in line);
    const picked = input.cultures === undefined || input.cultures.length === 0
        ? undefined
        : new Set(input.cultures);
    const cultures = [
        ...join.cultures.filter((culture) => culture === join.nativeCulture),
        ...join.cultures.filter((culture) => culture !== join.nativeCulture && (picked === undefined || picked.has(culture)))
    ];
    const placesOf = (line) => line.manifest.length > 0
        ? line.manifest.map((entry) => entry.path)
        : wholeLine(line)
            ? localizationLineUnits(line, units).flatMap((unit) => unit.occurrences.map((occurrence) => textLocationPath(occurrence.location)))
            : line.places.map((place) => place.objectPath);
    const kindsOf = (line) => line.origin.kind === "corpus" && !wholeLine(line)
        ? [...new Set(line.places.map((place) => place.origin))]
        : line.origin.kind === "corpus" && wholeLine(line) && units.size > 0
            ? [
                ...new Set(localizationLineUnits(line, units).flatMap((unit) => unit.occurrences.map((occurrence) => textLocationOrigin(occurrence.location))))
            ]
            : manifestOrigins(line.manifest.map((entry) => entry.path));
    // Joins record the audience; recompute it for lines from older joins when the corpus is here.
    const audienceOf = (line) => line.audience ??
        lineTextAudience(localizationLineUnits(line, units)
            .filter(hasSearchableSource)
            .flatMap((unit) => unit.occurrences.map((occurrence) => occurrenceTextAudience(occurrence).audience)));
    const shipped = (line, culture) => {
        if (!wholeLine(line)) {
            const mark = line.marks.find((item) => item.culture === culture);
            return mark === undefined ? undefined : { value: mark.translation, state: mark.state };
        }
        const mark = line.cultures.find((item) => item.culture === culture);
        return mark === undefined
            ? undefined
            : { value: localizationShippedTranslation(mark).value, state: mark.state };
    };
    const sorted = [...lines].sort((left, right) => byCodeUnit(left.identity?.namespace ?? "￿", right.identity?.namespace ?? "￿") ||
        byCodeUnit(left.identity?.key ?? "", right.identity?.key ?? "") ||
        byCodeUnit(left.source, right.source));
    const header = [
        "Namespace",
        "Key",
        "Source",
        "Where",
        "Kind",
        "Audience",
        ...cultures.flatMap((culture) => [culture, `${culture} state`])
    ];
    const rows = sorted.map((line) => {
        const places = [...new Set(placesOf(line))];
        const where = places.length > 1 ? `${places[0]} (+${places.length - 1})` : (places[0] ?? "");
        return [
            line.identity?.namespace ?? "",
            line.identity?.key ?? "",
            line.manifest[0]?.source.Text ?? line.source,
            where,
            kindsOf(line)
                .map((kind) => TEXT_ORIGIN_LABELS[kind])
                .join(", "),
            TEXT_AUDIENCE_LABELS[audienceOf(line)],
            ...cultures.flatMap((culture) => {
                const mark = shipped(line, culture);
                return mark === undefined
                    ? ["", ""]
                    : [mark.value ?? "", LOCALIZATION_STATE_LABELS[mark.state]];
            })
        ];
    });
    return { csv: spreadsheetCsv([header, ...rows]), rows: rows.length };
}
