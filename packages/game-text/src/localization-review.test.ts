import {
	emptyLocalizationReviewFile,
	localizationEvidenceFingerprint,
	updateLocalizationReviewFile,
	type LocalizationReviewFile,
	type LocalizationReviewFlag
} from "@ue-shed/localization/browser";
import { describe, expect, it } from "vitest";
import { joinLocalizationTarget } from "./localization.js";
import {
	applyLocalizationReview,
	localizationLineFingerprint,
	withoutAcceptedFindings
} from "./localization-review.js";
import { localizationProgressReport } from "./localization-reports.js";
import { textCorpusQuery } from "./query.js";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	poDocument,
	target,
	unit
} from "./localization.test-support.js";

const stamp = { by: "reviewer", at: "2026-10-08T00:00:00.000Z" };
const text = corpus([unit("K", "Source"), unit("L", "Other")]);
// The PO matches the archive for K, so nothing is pending and the shipped text is the archive's.
const files = evidence(
	[manifestEntry("K", "Source"), manifestEntry("L", "Other")],
	[archiveEntry("K", "Source", "Quelle"), archiveEntry("L", "Other", "Andere")],
	poDocument("Quelle")
);
const base = joinLocalizationTarget(text, files);
const de = cultureCode(target.cultures[1] ?? "de");

function reviewOf(key: string, flags: readonly LocalizationReviewFlag[], join = base) {
	const line = join.lines.find((item) => item.identity?.key === key);
	const culture = line?.cultures.find((item) => item.culture === de);
	if (!line?.identity || !culture) throw new Error("Missing fixture line.");
	return updateLocalizationReviewFile(
		emptyLocalizationReviewFile(target.name),
		[
			{
				kind: "set",
				culture: de,
				namespace: line.identity.namespace,
				key: line.identity.key,
				flags,
				fingerprint: localizationLineFingerprint(line, culture)
			}
		],
		stamp
	);
}

const stateOf = (file: LocalizationReviewFile, key: string, join = base) =>
	applyLocalizationReview(join, file)
		.lines.find((line) => line.identity?.key === key)
		?.cultures.find((culture) => culture.culture === de)?.review;

describe("localization review state", () => {
	it("uses the gathered identity for saved package namespaces and evidence fingerprints", () => {
		const saved = corpus([unit("K", "Source", "Content/Text/Table.uasset", "NS [PKG]")]);
		const joined = joinLocalizationTarget(saved, files);
		const line = joined.lines.find((item) => item.identity?.key === "K");
		const culture = line?.cultures.find((item) => item.culture === de);
		if (!line?.identity || !culture) throw new Error("Missing fixture line.");
		expect(localizationLineFingerprint(line, culture)).toBe(
			localizationEvidenceFingerprint(files, de, line.identity)
		);
		const file = reviewOf("K", ["reviewed"], joined);
		expect(file.records[0]?.namespace).toBe("NS");
		expect(stateOf(file, "K", joined)?.status).toBe("current");
	});

	it("is current for the reviewed text and changed when the translation or source moves on", () => {
		const file = reviewOf("K", ["reviewed", "proofread"]);
		expect(stateOf(file, "K")).toMatchObject({
			status: "current",
			flags: ["reviewed", "proofread"]
		});
		expect(stateOf(file, "L")).toEqual({ status: "not_reviewed" });
		const retranslated = joinLocalizationTarget(
			text,
			evidence(
				[manifestEntry("K", "Source"), manifestEntry("L", "Other")],
				[archiveEntry("K", "Source", "Neue Quelle"), archiveEntry("L", "Other", "Andere")],
				poDocument("Neue Quelle")
			)
		);
		expect(stateOf(file, "K", retranslated)?.status).toBe("changed");
		// A pending PO edit is what ships next, so it also invalidates the review.
		const pending = joinLocalizationTarget(
			text,
			evidence(
				[manifestEntry("K", "Source"), manifestEntry("L", "Other")],
				[archiveEntry("K", "Source", "Quelle"), archiveEntry("L", "Other", "Andere")],
				poDocument("Quelle, überarbeitet")
			)
		);
		expect(stateOf(file, "K", pending)?.status).toBe("changed");
	});

	it("filters and counts review lenses through the same query as search", () => {
		const file = reviewOf("K", ["reviewed", "machine_translated"]);
		const query = textCorpusQuery(text, undefined, applyLocalizationReview(base, file));
		const request = {
			query: "",
			capability: "all" as const,
			pageSize: 50,
			localization: { target: target.name, culture: de }
		};
		const all = query.search(request);
		expect(all.localization?.reviewCounts).toMatchObject({
			reviewed: 1,
			not_reviewed: 1,
			not_proofread: 2,
			changed_since_review: 0,
			machine_translated: 1
		});
		const notReviewed = query.search({
			...request,
			localization: { ...request.localization, review: "not_reviewed" }
		});
		expect(notReviewed.localization?.lines.map((line) => line.identity?.key)).toEqual(["L"]);
		expect(notReviewed.total).toBe(1);
		// Without a review file, pages carry no review counts at all.
		expect(
			textCorpusQuery(text, undefined, base).search(request).localization?.reviewCounts
		).toBeUndefined();
	});

	it("hides accepted findings only while the accepted text is unchanged", () => {
		const line = base.lines.find((item) => item.identity?.key === "K");
		const culture = line?.cultures.find((item) => item.culture === de);
		if (!line?.identity || !culture) throw new Error("Missing fixture line.");
		const finding = {
			lineId: line.id,
			ruleId: "localization.duplicate_source",
			culture: de,
			identity: line.identity
		};
		const accepted = updateLocalizationReviewFile(
			emptyLocalizationReviewFile(target.name),
			[
				{
					kind: "accept",
					check: finding.ruleId,
					culture: de,
					namespace: line.identity.namespace,
					key: line.identity.key,
					fingerprint: localizationLineFingerprint(line, culture)
				}
			],
			stamp
		);
		expect(withoutAcceptedFindings(base, [finding], accepted)).toEqual({
			findings: [],
			accepted: 1
		});
		const changed = joinLocalizationTarget(
			text,
			evidence(
				[manifestEntry("K", "Source"), manifestEntry("L", "Other")],
				[archiveEntry("K", "Source", "Anders"), archiveEntry("L", "Other", "Andere")],
				poDocument("Anders")
			)
		);
		expect(withoutAcceptedFindings(changed, [finding], accepted).accepted).toBe(0);
	});

	it("reports reviewed and proofread shares once a review file exists", () => {
		const file = reviewOf("K", ["reviewed"]);
		const untracked = localizationProgressReport(text, base, files);
		expect(untracked.cultures.find((culture) => culture.culture === de)?.reviewed).toBe(
			"not_tracked"
		);
		const tracked = localizationProgressReport(
			text,
			applyLocalizationReview(base, file),
			files
		).cultures.find((culture) => culture.culture === de);
		expect(tracked?.reviewed).toEqual({ lines: 1, percent: 50 });
		expect(tracked?.proofread).toEqual({ lines: 0, percent: 0 });
	});
});
