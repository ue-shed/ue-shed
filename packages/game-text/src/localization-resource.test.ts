import { crc32 } from "node:zlib";
import { LocalizationError, type LocalizationTargetEvidence } from "@ue-shed/localization/browser";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	joinLocalizationTarget,
	localizationResourceSourceHash,
	type LocalizationReferenceResource
} from "./localization.js";
import { LocalizationJoin } from "./localization-schema.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import {
	archiveEntry,
	corpus,
	evidence,
	manifestEntry,
	unit
} from "./localization.test-support.js";

const decodeLocalizationJoin = Schema.decodeSync(LocalizationJoin);
const missing = {
	status: "failed",
	relativePath: null,
	error: new LocalizationError({
		code: "file_missing",
		message: "Evidence is missing.",
		recovery: "Generate this file with Unreal.",
		retrySafe: true,
		nextStep: "fix_input"
	})
} as const;

/** German without a PO, and without its archive unless `archived`; optionally no manifest. */
function withoutArchive(manifest = true, files = evidence(), archived = false) {
	return {
		...files,
		manifest: manifest ? files.manifest : missing,
		cultures: files.cultures.map((culture) =>
			culture.culture === "de"
				? { ...culture, po: missing, archive: archived ? culture.archive : missing }
				: culture
		)
	} satisfies LocalizationTargetEvidence;
}
function resource(
	text: string | null,
	source = "Source",
	verified = true
): LocalizationReferenceResource {
	return {
		verified,
		entries:
			text === null
				? []
				: [
						{
							namespace: "NS",
							key: "K",
							sourceHash: localizationResourceSourceHash(source),
							text
						}
					]
	};
}
function german(files: LocalizationTargetEvidence, de: LocalizationReferenceResource) {
	const join = joinLocalizationTarget(corpus([unit()]), files, files.target, {
		resources: new Map([["de", de]])
	});
	decodeLocalizationJoin(join);
	const culture = join.lines[0]?.cultures.find((item) => item.culture === "de");
	if (!culture) throw new Error("Expected a German state.");
	return culture;
}

describe("a culture without an archive reads its compiled resource", () => {
	it("hashes each UTF-16 unit as four bytes up to the first NUL, as Unreal does", () => {
		expect(localizationResourceSourceHash("a")).toBe(crc32(Buffer.from([0x61, 0, 0, 0])));
		expect(localizationResourceSourceHash("ab\0cd")).toBe(localizationResourceSourceHash("ab"));
		expect(localizationResourceSourceHash("\u{1f600}")).toBe(
			crc32(Buffer.from([0x3d, 0xd8, 0, 0, 0x00, 0xde, 0, 0]))
		);
		expect(localizationResourceSourceHash("")).toBe(0);
	});

	it("decides translated, not translated and needs update against the manifest source", () => {
		const translated = german(withoutArchive(), resource("Quelle"));
		expect(translated.state).toBe("translated");
		expect(translated.locres).toEqual({
			text: "Quelle",
			sourceHash: localizationResourceSourceHash("Source")
		});
		expect(translated.reducedSourceChecking).toBe(true);
		expect(localizationShippedTranslation(translated)).toEqual({
			origin: "locres",
			value: "Quelle"
		});
		expect(german(withoutArchive(), resource("Source")).state).toBe("not_translated");
		expect(german(withoutArchive(), resource("Quelle", "Old")).state).toBe("needs_update");
		// An unproven hash is not trusted: the text alone decides.
		expect(german(withoutArchive(), resource("Quelle", "Old", false)).state).toBe("translated");
		const absent = german(withoutArchive(), resource(null));
		expect(absent.state).toBe("not_translated");
		expect(absent.locres).toBeNull();
	});

	it("decides against the saved source without a manifest, and keeps the reason", () => {
		const translated = german(withoutArchive(false), resource("Quelle"));
		expect(translated.state).toBe("translated");
		expect(translated.unknownReasons).toContain("missing_manifest");
		expect(german(withoutArchive(false), resource("Quelle", "Old")).state).toBe("needs_update");
		expect(german(withoutArchive(false), resource(null)).state).toBe("unknown");
	});

	it("decides nothing for a culture whose resource could not be read", () => {
		const join = joinLocalizationTarget(corpus([unit()]), withoutArchive(), undefined, {
			failedResources: new Set(["de"])
		});
		decodeLocalizationJoin(join);
		const culture = join.lines[0]?.cultures.find((item) => item.culture === "de");
		expect(culture?.state).toBe("unknown");
		expect(culture?.facts).not.toContain("not_translated");
		expect(culture?.unknownReasons).toContain("missing_archive");
	});

	it("never reads the resource of a culture that has its archive", () => {
		const files = evidence(
			[manifestEntry()],
			[archiveEntry("K", "Source", "Archiv")],
			undefined,
			[archiveEntry("K", "Source", "Source")]
		);
		const culture = german(withoutArchive(true, files, true), resource("Quelle"));
		expect(culture.state).toBe("translated");
		expect(culture.archive?.translation.Text).toBe("Archiv");
		expect("locres" in culture).toBe(false);
		expect(localizationShippedTranslation(culture).origin).toBe("archive");
	});
});
