function sourceValues(unit) {
    return unit.source.status === "consistent" ? [unit.source.value] : unit.source.values;
}
/** Empty FText values are implementation noise, not searchable game text. */
export function hasSearchableSource(unit) {
    return sourceValues(unit).some((source) => source.trim().length > 0);
}
