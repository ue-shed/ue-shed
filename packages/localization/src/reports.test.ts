import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { parseLocmeta, parseWordCountCSV } from "./reports.js";
import { defaultLocalizationLimits } from "./schema.js";

function success<A, E>(result: Result.Result<A, E>): A {
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
}
const path = (project: string, target: string, extension: string) =>
	resolve("fixtures", project, "Content/Localization", target, `${target}.${extension}`);

describe("localization metadata and word counts", () => {
	for (const [project, target, version] of [
		["unreal-project", "FixtureGame", 2],
		["unreal-427-localization", "Fixture427", 1]
	] as const) {
		it(`reads ${project} locmeta header and report`, () => {
			const meta = success(parseLocmeta(readFileSync(path(project, target, "locmeta"))));
			expect(meta).toEqual({
				version,
				nativeCulture: "en",
				nativeLocresPath: `en/${target}.locres`,
				compiledCultures: ["de", "en", "fr"],
				isUGC: false
			});
			const report = success(parseWordCountCSV(readFileSync(path(project, target, "csv"))));
			expect(report.cultures).toEqual(["de", "en", "fr"]);
			expect(report.rows.at(-1)?.wordCount).toBe(version === 2 ? 62 : 9);
			expect(report.rows.at(-1)?.cultureWordCounts).toEqual(
				version === 2 ? { de: 59, en: 62, fr: 54 } : { de: 0, en: 9, fr: 0 }
			);
		});
	}

	it("reads Unreal 5.8 locmeta and word-count bytes", () => {
		const directory = resolve(
			"fixtures/unreal-project/FixtureExpected/localization/ue5.8-output"
		);
		const meta = success(parseLocmeta(readFileSync(resolve(directory, "FixtureGame.locmeta"))));
		expect(meta).toEqual({
			version: 2,
			nativeCulture: "en",
			nativeLocresPath: "en/FixtureGame.locres",
			compiledCultures: ["de", "en", "fr"],
			isUGC: false
		});
		const report = success(
			parseWordCountCSV(readFileSync(resolve(directory, "FixtureGame.csv")))
		);
		expect(report.cultures).toEqual(["de", "en", "fr"]);
		expect(report.rows).toHaveLength(2);
		expect(report.rows[0]?.cultureWordCounts).toEqual({ de: 0, en: 62, fr: 0 });
		expect(report.rows.at(-1)?.wordCount).toBe(62);
		expect(report.rows.at(-1)?.cultureWordCounts).toEqual({ de: 59, en: 62, fr: 54 });
	});

	it("accepts quoted CSV fields, BOM and no final newline", () => {
		const report = success(
			parseWordCountCSV(
				new TextEncoder().encode(
					'\uFEFF"Date/Time","Word Count","en"\r\n"2026.10.07-08.16.55","9","9"'
				)
			)
		);
		expect(report.rows[0]?.wordCount).toBe(9);
	});

	it("rejects truncation, unknown versions, trailing data and malicious counts", () => {
		const bytes = readFileSync(path("unreal-project", "FixtureGame", "locmeta"));
		for (let length = 0; length < bytes.length; length++)
			expect(parseLocmeta(bytes.subarray(0, length))._tag).toBe("Failure");
		const newer = Buffer.from(bytes);
		newer[16] = 3;
		const result = parseLocmeta(newer);
		expect(Result.isFailure(result) && result.failure.code).toBe("unsupported_version");
		expect(parseLocmeta(Buffer.concat([bytes, Buffer.from([0])]))._tag).toBe("Failure");
		const oversized = parseLocmeta(bytes, { ...defaultLocalizationLimits, maxFileBytes: 1 });
		expect(Result.isFailure(oversized) && oversized.failure.code).toBe("limit_exceeded");
		const many = parseLocmeta(bytes, { ...defaultLocalizationLimits, maxEntries: 1 });
		expect(Result.isFailure(many) && many.failure.code).toBe("limit_exceeded");
	});

	it("returns typed CSV failures for malformed fields, counts and bounds", () => {
		for (const text of [
			"Wrong,Header",
			"Date/Time,Word Count,en\nx,NaN,1",
			"Date/Time,Word Count,en\nx,1",
			'Date/Time,Word Count,en\n"broken,1,1',
			"Date/Time,Word Count,en,en\nx,1,1,1"
		]) {
			const parsed = parseWordCountCSV(new TextEncoder().encode(text));
			expect(Result.isFailure(parsed) && parsed.failure.code).toBe("malformed_csv");
		}
		const parsed = parseWordCountCSV(
			new TextEncoder().encode("Date/Time,Word Count,en\nx,1,1\ny,1,1"),
			{ ...defaultLocalizationLimits, maxEntries: 1 }
		);
		expect(Result.isFailure(parsed) && parsed.failure.code).toBe("limit_exceeded");
	});
});
