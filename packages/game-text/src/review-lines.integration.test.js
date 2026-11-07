import { Effect } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CultureCode, TextKey, TextNamespace, localizationEvidenceFingerprint } from "@ue-shed/localization";
import { GameTextIndexRefresh } from "./index-contract.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { evidenceReviewLines } from "./localization-review.js";
const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
/** One manifest entry, with a JSON escape the files may carry. */
const child = (key, source) => ({
    Source: { Text: source },
    Keys: [{ Key: key, Path: `/Game/Text/Table.Table.${key}` }]
});
describe.skipIf(!executable)("native review lines", () => {
    it("fingerprint each line as review-file evidence does, in one call per culture", async () => {
        if (!executable)
            throw new Error("Native reader required");
        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const fixture = yield* makeIndexRegressionFixture();
            // K ships its archive text, L a pending PO edit in German, M text with scalars
            // the engine escapes in its string views, and N has no German archive entry,
            // so nothing ships.
            const lone = "Reserved \u{f0000} \u{f0001} scalars 😀";
            yield* Effect.promise(async () => {
                await writeFile(join(fixture.projectRoot, "Review.manifest"), JSON.stringify({
                    FormatVersion: 1,
                    Namespace: "UI",
                    Children: [
                        child("K", "Source"),
                        child("L", "Other"),
                        child("M", lone),
                        child("N", "Unshipped")
                    ]
                }));
                for (const culture of fixture.target.cultures) {
                    const archived = [
                        ["K", "Source", "Shipped"],
                        ["L", "Other", "Andere"],
                        ["M", lone, lone],
                        ...(culture === "de" ? [] : [["N", "Unshipped", "Unshipped"]])
                    ];
                    await writeFile(join(fixture.projectRoot, `${culture}.archive`), JSON.stringify({
                        FormatVersion: 2,
                        Namespace: "UI",
                        Children: archived.map(([key, source, translation]) => ({
                            Key: key,
                            Source: { Text: source },
                            Translation: { Text: translation }
                        }))
                    }));
                    await writeFile(join(fixture.projectRoot, `${culture}.po`), [
                        'msgctxt "UI,K"\nmsgid "Source"\nmsgstr "Shipped"\n',
                        `msgctxt "UI,L"\nmsgid "Other"\nmsgstr "${culture === "de" ? "Neu" : "Andere"}"\n`
                    ].join("\n"));
                }
            });
            yield* Effect.gen(function* () {
                const model = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
                const identities = ["K", "L", "M", "N", "Missing"].map((key) => ({
                    namespace: TextNamespace.make("UI"),
                    key: TextKey.make(key)
                }));
                for (const culture of [
                    ...fixture.target.cultures,
                    CultureCode.make("fr")
                ]) {
                    const request = { target: fixture.target.name, culture, identities };
                    const native = yield* model.query.reviewLines(request);
                    // The index's own evidence, read whole in the host, agrees line by line.
                    expect(native).toEqual(evidenceReviewLines(model.evidence, request));
                    native.forEach((line, index) => {
                        expect(line.status === "found" ? line.fingerprint : undefined).toBe(localizationEvidenceFingerprint(model.evidence, culture, identities[index]));
                    });
                }
                const german = yield* model.query.reviewLines({
                    target: fixture.target.name,
                    culture: "de",
                    identities
                });
                expect(german.map((line) => line.status === "found" ? [line.translation, line.po?.msgid] : [])).toEqual([
                    ["Shipped", "Source"],
                    ["Neu", "Other"],
                    [lone, undefined],
                    [null, undefined],
                    []
                ]);
                // More identities than one engine batch come back in request order.
                const many = Array.from({ length: 3000 }, (_, index) => ({
                    namespace: "UI",
                    key: index === 2999 ? "L" : `Absent${index}`
                }));
                const read = yield* model.query.reviewLines({
                    target: fixture.target.name,
                    culture: "de",
                    identities: many
                });
                expect(read).toHaveLength(3000);
                expect(read.at(-1)).toEqual(german[1]);
            }).pipe(Effect.provide(fixture.layer(fixture.source, nativeIndexBuilderLayer({
                executable,
                timeoutMs: 30000,
                catalogTimeoutMs: 120000
            }))));
        })));
    }, 120000);
});
