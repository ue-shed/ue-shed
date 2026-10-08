import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { describe, expect } from "vitest";
import { LocalizationFileAccessLive } from "./file-access.js";
import {
	decodeLocalizationReviewFile,
	defaultLocalizationReviewPath,
	emptyLocalizationReviewFile,
	encodeLocalizationReviewFile,
	localizationReviewFingerprint,
	updateLocalizationReviewFile,
	type LocalizationReviewUpdate
} from "./review-file.js";
import { readLocalizationReview, updateLocalizationReview } from "./review-store.js";
import { CultureCode, LocalizationTargetName, TextKey, TextNamespace } from "./schema.js";
import type { LocalizationReviewFlag } from "./review-file.js";

const target = LocalizationTargetName.make("Game");
const stamp = { by: "writer", at: "2026-10-08T10:00:00.000Z" };
const line = (key: string, culture = "de") => ({
	culture: CultureCode.make(culture),
	namespace: TextNamespace.make("NS"),
	key: TextKey.make(key)
});
const set = (
	key: string,
	flags: readonly LocalizationReviewFlag[],
	fingerprint: string
): LocalizationReviewUpdate => ({ kind: "set", ...line(key), flags, fingerprint });

describe("localization review file", () => {
	it("fingerprints source and translation together, unambiguously", () => {
		expect(localizationReviewFingerprint("a", "bc")).not.toBe(
			localizationReviewFingerprint("ab", "c")
		);
		expect(localizationReviewFingerprint("a", null)).not.toBe(
			localizationReviewFingerprint("a", "")
		);
		expect(localizationReviewFingerprint("a", "b")).toMatch(/^[0-9a-f]{64}$/u);
	});

	it("merges flags for the same text and starts over when the text changed", () => {
		const first = localizationReviewFingerprint("Source", "Quelle");
		const second = localizationReviewFingerprint("Source", "Neue Quelle");
		let file = updateLocalizationReviewFile(
			emptyLocalizationReviewFile(target),
			[set("K", ["reviewed"], first)],
			stamp
		);
		file = updateLocalizationReviewFile(file, [set("K", ["proofread"], first)], stamp);
		expect(file.records[0]?.flags).toEqual(["reviewed", "proofread"]);
		file = updateLocalizationReviewFile(file, [set("K", ["reviewed"], second)], stamp);
		expect(file.records[0]).toMatchObject({ flags: ["reviewed"], fingerprint: second });
		file = updateLocalizationReviewFile(
			file,
			[{ kind: "clear", ...line("K"), flags: [] }],
			stamp
		);
		expect(file.records).toEqual([]);
	});

	it("serializes sorted, stable and minimal so diffs stay small", () => {
		const fingerprint = localizationReviewFingerprint("S", "T");
		const forward = updateLocalizationReviewFile(
			emptyLocalizationReviewFile(target),
			[set("B", ["proofread", "reviewed"], fingerprint), set("A", ["reviewed"], fingerprint)],
			stamp
		);
		const backward = updateLocalizationReviewFile(
			emptyLocalizationReviewFile(target),
			[set("A", ["reviewed"], fingerprint), set("B", ["reviewed", "proofread"], fingerprint)],
			stamp
		);
		const text = encodeLocalizationReviewFile(forward);
		expect(text).toBe(encodeLocalizationReviewFile(backward));
		expect(text.endsWith("}\n")).toBe(true);
		expect(text.indexOf('"key": "A"')).toBeLessThan(text.indexOf('"key": "B"'));
		const changed = updateLocalizationReviewFile(
			forward,
			[set("A", ["proofread"], fingerprint)],
			stamp
		);
		const before = text.split("\n");
		const after = encodeLocalizationReviewFile(changed).split("\n");
		expect(after.length - before.length).toBe(1);
		const decoded = decodeLocalizationReviewFile(text, target);
		expect(Result.isSuccess(decoded) && decoded.success.records.length).toBe(2);
	});

	it("rejects malformed, foreign and duplicated review files", () => {
		const code = (text: string) => {
			const decoded = decodeLocalizationReviewFile(text, target);
			return Result.isFailure(decoded) ? decoded.failure.code : "ok";
		};
		expect(code("{")).toBe("invalid_review_file");
		const other = encodeLocalizationReviewFile(
			emptyLocalizationReviewFile(LocalizationTargetName.make("Other"))
		);
		expect(code(other)).toBe("wrong_target");
		const fingerprint = localizationReviewFingerprint("S", "T");
		const one = updateLocalizationReviewFile(
			emptyLocalizationReviewFile(target),
			[set("K", ["reviewed"], fingerprint)],
			stamp
		);
		const doubled = encodeLocalizationReviewFile({
			...one,
			records: [...one.records, ...one.records]
		});
		expect(code(doubled)).toBe("duplicate_review_record");
	});
});

it.live("creates the review file, updates it in place and refuses a concurrent change", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-review-")));
		yield* Effect.addFinalizer(() =>
			Effect.promise(() => rm(root, { recursive: true, force: true }))
		);
		const location = { projectRoot: root, target };
		const empty = yield* readLocalizationReview(location);
		expect(empty).toMatchObject({ contentHash: null, file: { records: [] } });
		const fingerprint = localizationReviewFingerprint("S", "T");
		const created = yield* updateLocalizationReview(
			location,
			[set("K", ["reviewed"], fingerprint)],
			stamp
		);
		const path = join(root, defaultLocalizationReviewPath(target));
		expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
			encodeLocalizationReviewFile(created.file)
		);
		const stale = yield* readLocalizationReview(location);
		yield* Effect.promise(() =>
			writeFile(path, encodeLocalizationReviewFile(stale.file) + "\n")
		);
		const refused = yield* updateLocalizationReview(
			location,
			[set("K", ["proofread"], fingerprint)],
			stamp,
			stale
		).pipe(Effect.result);
		expect(Result.isFailure(refused) && refused.failure.code).toBe("file_changed");
		const updated = yield* updateLocalizationReview(
			location,
			[set("K", ["proofread"], fingerprint)],
			stamp
		);
		expect(updated.file.records[0]?.flags).toEqual(["reviewed", "proofread"]);
	}).pipe(Effect.scoped, Effect.provide(LocalizationFileAccessLive))
);
