import { Clock, Context, Effect, Exit, Option } from "effect";
import { completeRulesOf, ruleProblemError } from "./game-text-rules.js";
import { effectiveRuleDocument } from "./rules/effective.js";
/** Profiles contain only bounded operation names and numbers from this call. */
export const annotateFindingsProfile = Effect.fnUntraced(function* (profile, requestStart) {
    const prefix = "game_text.findings.";
    if (!("cached" in profile)) {
        yield* Effect.annotateCurrentSpan({
            [`${prefix}rows_requested`]: profile.rowsRequested,
            [`${prefix}findings`]: profile.findingsReturned
        });
        return;
    }
    yield* Effect.annotateCurrentSpan(`${prefix}cached`, profile.cached);
    if (profile.cached)
        return;
    yield* Effect.annotateCurrentSpan({
        [`${prefix}rules`]: profile.rules,
        [`${prefix}findings`]: profile.findings,
        [`${prefix}diagnostics`]: profile.diagnostics,
        [`${prefix}wall_ms`]: profile.wallMs,
        // Steps inside a stage, such as a closure's groups and an aggregate's parts.
        ...Object.fromEntries(Object.entries(profile.subStages).map(([name, sample]) => [
            `${prefix}stage_ms.${name}`,
            sample.wallMs
        ]))
    });
    const parent = yield* Effect.option(Effect.currentSpan);
    if (Option.isNone(parent))
        return;
    const tracer = yield* Effect.tracer;
    const origin = requestStart ??
        (yield* Clock.currentTimeNanos) - BigInt(Math.round(profile.wallMs * 1_000_000));
    for (const [name, sample] of Object.entries(profile.stages)) {
        const span = tracer.span({
            name: `GameText.native.findingsEvaluate.${name}`,
            parent,
            annotations: Context.empty(),
            links: [],
            startTime: origin + BigInt(Math.round(sample.startOffsetMs * 1_000_000)),
            kind: "internal",
            root: false,
            sampled: parent.value.sampled
        });
        span.attribute(`${prefix}stage.wall_ms`, sample.wallMs);
        span.attribute(`${prefix}stage.busy_ms`, sample.busyMs);
        span.attribute(`${prefix}stage.rows`, sample.rows);
        for (const [field, value] of Object.entries(sample.memory)) {
            if (value !== null && value !== undefined)
                span.attribute(`${prefix}memory.${field}`, value);
        }
        const kernels = Object.entries(sample.kernels)
            .sort((a, b) => b[1].busyMs - a[1].busyMs)
            .slice(0, 24);
        for (const [op, kernel] of kernels) {
            span.attribute(`${prefix}kernel.${op}.wall_ms`, kernel.wallMs);
            span.attribute(`${prefix}kernel.${op}.busy_ms`, kernel.busyMs);
            span.attribute(`${prefix}kernel.${op}.rows`, kernel.rows);
            span.attribute(`${prefix}kernel.${op}.inputs`, kernel.inputs);
        }
        span.end(origin + BigInt(Math.round(sample.endOffsetMs * 1_000_000)), Exit.void);
    }
});
export const inflateFindingsPage = ({ page, findings, sets }) => Effect.sync(() => {
    const { profile: _profile, ...rest } = page;
    return {
        ...rest,
        findings: findings.map((finding) => {
            // SAFETY: the engine writes each finding in its family's host shape, with the
            // fields its query adds and `places` naming its place set; the handshake checked
            // the shared contract. Verified by: findings-query.test.ts compares queried pages
            // with the in-memory workspace's.
            const { places: id, ...evidence } = finding;
            const inflated = {
                ...evidence,
                // A set with no places, such as a gathered-only line's, sends no rows.
                affectedOccurrences: sets.get(id) ?? []
            };
            // SAFETY: as above; the place sets hold the affected occurrences in host shape.
            // Verified by: findings-query.test.ts compares queried pages with the in-memory
            // workspace's.
            return inflated;
        })
    };
});
/**
 * Registers the accepted findings of the review a read applies, or none. A review without
 * accepted findings hides nothing, so it has no key.
 */
export const acceptReview = (native, key, review) => review === undefined || review.acceptedFindings.length === 0
    ? Effect.undefined
    : native.findingsAccept(key, review.acceptedFindings.map(({ check, culture, namespace, key, fingerprint }) => ({
        check,
        ...(culture === null ? undefined : { culture }),
        namespace,
        key,
        fingerprint
    })));
/**
 * Fails with the rules file error the engine finds in a document's complete rules: an expression
 * it can't run, or rules that read each other's findings in a cycle. Decoding checked the rest.
 */
export const checkCompleteRules = (native, document) => completeRulesOf(document).length === 0
    ? Effect.void
    : native
        .rulesCheck(effectiveRuleDocument(document))
        .pipe(Effect.flatMap(({ problem }) => problem ? Effect.fail(ruleProblemError(problem)) : Effect.void));
