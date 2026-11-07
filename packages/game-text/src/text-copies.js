/**
 * Copies the game runs: the generated class (and the animation instances in it) and the class
 * default object. A skeleton class only serves the editor while the Blueprint compiles.
 */
export const RUNTIME_COPY_KINDS = [
    "generated_class",
    "instance",
    "class_default"
];
/**
 * The first copy the game runs whose text differs from its place: the Blueprint was edited since
 * it compiled, and the game shows the copy's text. A skeleton copy with other text is not this.
 */
export function staleRuntimeCopy(occurrence) {
    return occurrence.copies?.find((copy) => copy.source !== occurrence.source && RUNTIME_COPY_KINDS.includes(copy.kind));
}
/** True when the game shows other text than the place's: see `staleRuntimeCopy`. */
export function hasDifferingCopy(occurrence) {
    return staleRuntimeCopy(occurrence) !== undefined;
}
