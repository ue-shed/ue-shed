export function materializeQualityRead(read, items) {
    let next = read.next();
    while (!next.done)
        next = read.next(items(next.value));
    return next.value;
}
