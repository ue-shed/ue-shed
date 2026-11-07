export function emptyPackageTextRecord(path) {
    return {
        event: "text_package_record",
        path,
        fileBytes: 0,
        schema_version: 1,
        status: "complete",
        decodeErrors: 0,
        occurrences: [],
        gapCounts: {
            unsupported_text_history: 0,
            legacy_container_element_without_type_information: 0,
            feature_unavailable_for_engine_version: 0,
            property_decoder_rejected: 0
        },
        gapSamples: []
    };
}
/** Mutable package-local fold; counts are complete and sample memory stays bounded. */
export function retainPackageTextGap(counts, samples, gap) {
    counts[gap.reason] += 1;
    if (samples.length < 3)
        samples.push(gap);
    else if (gap.reason === "unsupported_text_history") {
        const index = samples.findIndex((sample, index) => index > 0 && sample.reason !== "unsupported_text_history");
        if (index > 0)
            samples[index] = gap;
    }
}
/** Small-input migration/oracle adapter. Production native extraction aggregates before transport. */
export function* packageTextRecordsFromEvents(events) {
    const pending = new Map();
    for (const event of events) {
        if (event.event === "text_summary" || event.event === "error") {
            yield event;
            continue;
        }
        let current = pending.get(event.path);
        if (!current) {
            const occurrences = [];
            const samples = [];
            current = {
                record: { ...emptyPackageTextRecord(event.path), occurrences, gapSamples: samples },
                occurrences,
                samples
            };
            pending.set(event.path, current);
        }
        if (event.event === "text_occurrence")
            current.occurrences.push(event.occurrence);
        else if (event.event === "text_coverage_gap") {
            retainPackageTextGap(current.record.gapCounts, current.samples, event.coverage_gap);
        }
        else {
            yield {
                ...current.record,
                fileBytes: event.fileBytes,
                status: event.status,
                decodeErrors: event.diagnostics.length
            };
            pending.delete(event.path);
        }
    }
    if (pending.size)
        throw new Error("Text extraction ended with unfinished packages.");
}
