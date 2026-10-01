import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Schema } from "effect";

export const RecordingManifest = Schema.Struct({
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-showcase-recording"),
		version: Schema.Literal(1)
	}),
	status: Schema.Literals(["passed", "failed"]),
	journey: Schema.NonEmptyString,
	finishedAt: Schema.NonEmptyString,
	commit: Schema.NonEmptyString,
	dirty: Schema.Boolean,
	chapters: Schema.Array(Schema.Struct({ screenshot: Schema.String, title: Schema.String }))
});
export interface RecordingManifest extends Schema.Schema.Type<typeof RecordingManifest> {}

export const exportPlan = {
	"site-saved": {
		"02-data-authoring": { key: "authoring", file: "authoring.png" },
		"02-data-authoring-charts": { key: "authoringCharts", file: "authoring-charts.png" },
		"04-game-text": { key: "gameText", file: "game-text.png" },
		"05-config-platform-comparison": { key: "configExplorer", file: "config-explorer.png" },
		"06-config-contribution-ledger": { key: "configLineage", file: "config-lineage.png" },
		"08-map-review-saved-map": { key: "mapReview", file: "map-review.png" }
	}
} as const;
export type Journey = keyof typeof exportPlan;

export const SiteMedia = Schema.Struct({
	exportedAt: Schema.NonEmptyString,
	captures: Schema.Record(
		Schema.String,
		Schema.Struct({
			file: Schema.NonEmptyString,
			journey: Schema.NonEmptyString,
			title: Schema.NonEmptyString,
			sha256: Schema.NonEmptyString
		})
	),
	journeys: Schema.Record(
		Schema.String,
		Schema.Struct({
			recordingId: Schema.NonEmptyString,
			commit: Schema.NonEmptyString,
			dirty: Schema.Boolean,
			finishedAt: Schema.NonEmptyString
		})
	)
});
export interface SiteMedia extends Schema.Schema.Type<typeof SiteMedia> {}

export function containedFile(root: string, file: string): string {
	const base = realpathSync(root);
	const candidate = realpathSync(resolve(base, file));
	const path = relative(base, candidate);
	if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
		throw new Error(`Media path escapes its root: ${file}`);
	}
	return candidate;
}

export function pngDigest(bytes: Buffer): string {
	if (
		bytes.length < 24 ||
		!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
		bytes.readUInt32BE(16) === 0 ||
		bytes.readUInt32BE(20) === 0
	) {
		throw new Error("Screenshot must be a nonempty PNG");
	}
	return createHash("sha256").update(bytes).digest("hex");
}

export function prepareCaptures(bundleDir: string, manifest: RecordingManifest, journey: Journey) {
	if (manifest.status !== "passed" || manifest.journey !== journey) {
		throw new Error(`Expected a passed ${journey} recording`);
	}
	if (!Number.isFinite(Date.parse(manifest.finishedAt)))
		throw new Error("Invalid recording date");
	return Object.entries(exportPlan[journey]).map(([slug, target]) => {
		const matches = manifest.chapters.filter(
			(chapter) => chapter.screenshot === `chapters/${slug}.png`
		);
		if (matches.length !== 1) throw new Error(`Expected exactly one chapter ${slug}`);
		const chapter = matches[0];
		const bytes = readFileSync(containedFile(bundleDir, chapter.screenshot));
		return {
			key: target.key,
			bytes,
			capture: {
				file: target.file,
				journey,
				title: chapter.title,
				sha256: pngDigest(bytes)
			}
		};
	});
}

export function checkSiteMedia(
	media: SiteMedia,
	mediaDir: string,
	replacements: ReadonlyMap<string, Buffer> = new Map()
): void {
	for (const [journey, chapters] of Object.entries(exportPlan)) {
		const provenance = media.journeys[journey];
		if (!provenance || !Number.isFinite(Date.parse(provenance.finishedAt))) {
			throw new Error(`Missing recording provenance for ${journey}`);
		}
		for (const { key, file } of Object.values(chapters)) {
			const capture = media.captures[key];
			if (!capture || capture.file !== file || capture.journey !== journey) {
				throw new Error(`Missing or mismatched capture: ${key}`);
			}
			const bytes = replacements.get(file) ?? readFileSync(containedFile(mediaDir, file));
			if (pngDigest(bytes) !== capture.sha256) {
				throw new Error(
					`Screenshot differs from its manifest: ${file}. Run pnpm site:media.`
				);
			}
		}
	}
}
