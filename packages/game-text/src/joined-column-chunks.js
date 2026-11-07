/** Physical section names must fit the format's 31-byte ASCII directory field. */
export function joinedPhysicalChunkName(name, column, part) {
    const descriptive = `${name}.chunk${part}`;
    return descriptive.length <= 31 ? descriptive : `join.chunk${column}.${part}`;
}
