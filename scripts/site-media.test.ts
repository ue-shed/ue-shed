import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Schema } from "effect";
import {
	checkSiteMedia,
	containedFile,
	exportPlan,
	pngDigest,
	prepareCaptures,
	RecordingManifest,
	type SiteMedia
} from "./site-media-model.ts";

const png = readFileSync(new URL("../apps/site/public/media/authoring.png", import.meta.url));

test("media promotion requires passed, complete, contained recording evidence", (t) => {
	const root = mkdtempSync(join(tmpdir(), "ue-shed-site-media-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bundle = join(root, "bundle");
	mkdirSync(join(bundle, "chapters"), { recursive: true });
	const chapters = Object.keys(exportPlan["site-saved"]).map((slug) => ({
		screenshot: `chapters/${slug}.png`,
		title: slug
	}));
	for (const chapter of chapters) writeFileSync(join(bundle, chapter.screenshot), png);
	const manifest = Schema.decodeUnknownSync(RecordingManifest)({
		contract: { name: "ue-shed-showcase-recording", version: 1 },
		status: "passed",
		journey: "site-saved",
		finishedAt: "2026-09-27T00:00:00Z",
		commit: "abc1234",
		dirty: false,
		chapters
	});
	const promoted = prepareCaptures(bundle, manifest, "site-saved");
	assert.equal(promoted.length, 6);
	assert.deepEqual(Object.keys(exportPlan), ["site-saved"]);
	assert.deepEqual(promoted.find(({ key }) => key === "mapReview")?.capture, {
		file: "map-review.png",
		journey: "site-saved",
		title: "08-map-review-saved-map",
		sha256: pngDigest(png)
	});
	assert.equal(promoted[0].capture.sha256, pngDigest(png));
	assert.throws(
		() => prepareCaptures(bundle, { ...manifest, journey: "map-review" }, "site-saved"),
		/passed site-saved recording/
	);
	assert.throws(
		() =>
			prepareCaptures(
				bundle,
				{
					...manifest,
					chapters: chapters.filter(
						(chapter) => chapter.screenshot !== "chapters/08-map-review-saved-map.png"
					)
				},
				"site-saved"
			),
		/exactly one chapter 08-map-review-saved-map/
	);
	assert.throws(
		() => prepareCaptures(bundle, { ...manifest, status: "failed" }, "site-saved"),
		/passed/
	);
	assert.throws(
		() => prepareCaptures(bundle, { ...manifest, chapters: chapters.slice(1) }, "site-saved"),
		/exactly one chapter/
	);
	assert.throws(
		() =>
			prepareCaptures(
				bundle,
				{ ...manifest, chapters: [...chapters, chapters[0]] },
				"site-saved"
			),
		/exactly one chapter/
	);
	assert.throws(() =>
		Schema.decodeUnknownSync(RecordingManifest)({ ...manifest, dirty: "false" })
	);
	writeFileSync(join(root, "outside.png"), png);
	assert.throws(() => containedFile(bundle, "../outside.png"), /escapes/);
	writeFileSync(join(bundle, chapters[0].screenshot), "not a screenshot");
	assert.throws(() => prepareCaptures(bundle, manifest, "site-saved"), /PNG/);
});

test("site check detects missing images and edits outside the promotion workflow", (t) => {
	const root = mkdtempSync(join(tmpdir(), "ue-shed-site-check-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const captures: Record<string, SiteMedia["captures"][string]> = {};
	const journeys: Record<string, SiteMedia["journeys"][string]> = {};
	for (const [journey, plan] of Object.entries(exportPlan)) {
		journeys[journey] = {
			recordingId: "run",
			commit: "abc1234",
			dirty: false,
			finishedAt: "2026-09-27T00:00:00Z"
		};
		for (const { key, file } of Object.values(plan)) {
			writeFileSync(join(root, file), png);
			captures[key] = { journey, file, title: key, sha256: pngDigest(png) };
		}
	}
	const media = { exportedAt: "2026-09-27T00:00:00Z", captures, journeys };
	checkSiteMedia(media, root);
	assert.throws(
		() => checkSiteMedia({ ...media, journeys: {} }, root),
		/Missing recording provenance for site-saved/
	);
	assert.throws(
		() =>
			checkSiteMedia(
				{
					...media,
					captures: {
						...captures,
						mapReview: { ...captures.mapReview, journey: "map-review" }
					}
				},
				root
			),
		/Missing or mismatched capture: mapReview/
	);
	writeFileSync(join(root, "authoring.png"), Buffer.concat([png, Buffer.from("changed")]));
	assert.throws(() => checkSiteMedia(media, root), /differs from its manifest/);
	checkSiteMedia(media, root, new Map([["authoring.png", png]]));
	rmSync(join(root, "authoring.png"));
	assert.throws(() => checkSiteMedia(media, root), /ENOENT/);
});
