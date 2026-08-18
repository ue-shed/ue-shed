import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	globSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { repositoryRoot } from "./workbench-tools.ts";

// Curates real Workbench captures from showcase review bundles (see `pnpm showcase:record`)
// into the site's assets. The site only renders what this manifest exports, so media can
// never drift from the recording that produced it.

const defaultResultsRoot = join(repositoryRoot, "test-results", "showcase");
const mediaOutDir = join(repositoryRoot, "apps", "site", "public", "media");
const manifestPath = join(repositoryRoot, "apps", "site", "src", "showcase", "media.ts");

interface ExportPlanEntry {
	readonly chapters: Readonly<Record<string, { readonly key: string; readonly file: string }>>;
	readonly video?: string;
}

interface ExportPlan {
	readonly [journey: string]: ExportPlanEntry;
}

interface RecordingManifest {
	readonly contract: { readonly name: string };
	readonly status: string;
	readonly journey: string;
	readonly finishedAt: string;
	readonly commit: string;
	readonly dirty: boolean;
	readonly artifacts?: { readonly video?: string };
	readonly chapters: ReadonlyArray<{ readonly screenshot: string; readonly title: string }>;
}

interface RecordingCandidate {
	readonly bundleDir: string;
	readonly manifest: RecordingManifest;
	readonly recordingId: string;
}

interface JourneyInfo {
	readonly recordingId: string;
	readonly commit: string;
	readonly dirty: boolean;
	readonly finishedAt: string;
	video?: string;
}

const exportPlan: ExportPlan = {
	"saved-workflows": {
		chapters: {
			"02-data-authoring": { key: "authoring", file: "authoring.png" },
			// Withheld: the captured selected-asset panel dumps a raw FiberFailure with
			// absolute local paths. Re-enable after the Workbench error panel is fixed
			// and the journey is re-recorded.
			// "03-texture-audit": { key: "audit", file: "audit.png" },
			"04-game-text": { key: "gameText", file: "game-text.png" }
		}
		// Video withheld: it contains the same audit panel, and the screencast renders
		// the Workbench window at quarter size on gray. Fix recorder sizing first.
	},
	"map-review": {
		chapters: {
			"03-before-and-after": { key: "mapReview", file: "map-review.png" }
		}
		// Video withheld: screencast frames render the Workbench window small on gray;
		// publish once the recorder's window/screencast sizing is fixed.
	}
};

const argumentsAfterCommand = process.argv.slice(2);
const pinnedBundles = new Map();
let resultsRoot = defaultResultsRoot;
for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
	const argument = argumentsAfterCommand[index];
	if (argument === "--bundle") {
		const pin = argumentsAfterCommand[index + 1];
		const separator = pin?.indexOf("=") ?? -1;
		if (!pin || separator <= 0) {
			throw new Error("Usage: --bundle <journey>=<recording-id>");
		}
		pinnedBundles.set(pin.slice(0, separator), pin.slice(separator + 1));
		index += 1;
	} else if (argument === "--results-root") {
		resultsRoot = argumentsAfterCommand[index + 1] ?? defaultResultsRoot;
		index += 1;
	} else {
		throw new Error(
			`Unknown argument "${argument}". Usage: [--bundle <journey>=<recording-id>] [--results-root <dir>]`
		);
	}
}

if (!existsSync(resultsRoot)) {
	throw new Error(
		`No showcase bundles at ${resultsRoot}. Record one first with \`pnpm showcase:record\`.`
	);
}

function readManifest(manifestPath: string): RecordingManifest | undefined {
	try {
		// SAFETY: only the recorder-owned manifest is accepted, and its contract tag is checked next.
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RecordingManifest;
		if (manifest?.contract?.name !== "ue-shed-showcase-recording") {
			return undefined;
		}
		return manifest;
	} catch {
		return undefined;
	}
}

const candidates = new Map<string, RecordingCandidate>();
for (const relativePath of globSync("*/**/run.json", { cwd: resultsRoot })) {
	const recordingId = relativePath.split(/[\\/]/)[0];
	const manifest = readManifest(join(resultsRoot, relativePath));
	if (!manifest || manifest.status !== "passed") {
		continue;
	}
	const journey = manifest.journey;
	if (!Object.hasOwn(exportPlan, journey)) {
		continue;
	}
	const entry = { bundleDir: join(resultsRoot, dirname(relativePath)), manifest, recordingId };
	const current = candidates.get(journey);
	if (!current || manifest.finishedAt > current.manifest.finishedAt) {
		candidates.set(journey, entry);
	}
}

for (const [journey, recordingId] of pinnedBundles) {
	const pinned = [...globSync(`${recordingId}/**/run.json`, { cwd: resultsRoot })]
		.map((relativePath) => ({
			bundleDir: join(resultsRoot, dirname(relativePath)),
			manifest: readManifest(join(resultsRoot, relativePath)),
			recordingId
		}))
		.find(
			(entry): entry is RecordingCandidate =>
				entry.manifest !== undefined && entry.manifest.journey === journey
		);
	if (!pinned) {
		throw new Error(
			`No passed ${journey} bundle with recording id "${recordingId}" under ${resultsRoot}.`
		);
	}
	if (pinned.manifest.status !== "passed") {
		throw new Error(`Bundle ${recordingId} did not pass; refusing to publish it to the site.`);
	}
	candidates.set(journey, pinned);
}

rmSync(mediaOutDir, { force: true, recursive: true });
mkdirSync(mediaOutDir, { recursive: true });

const journeys: Record<string, JourneyInfo> = {};
const captures: Record<
	string,
	{ readonly file: string; readonly journey: string; readonly title: string }
> = {};
const warnings: string[] = [];

for (const [journey, plan] of Object.entries(exportPlan)) {
	const candidate = candidates.get(journey);
	if (!candidate) {
		warnings.push(`no passed "${journey}" bundle found; its captures are skipped`);
		continue;
	}
	const { bundleDir, manifest, recordingId } = candidate;
	const journeyInfo: JourneyInfo = {
		recordingId,
		commit: manifest.commit,
		dirty: manifest.dirty,
		finishedAt: manifest.finishedAt
	};
	if (
		plan.video &&
		manifest.artifacts?.video &&
		existsSync(join(bundleDir, manifest.artifacts.video))
	) {
		copyFileSync(join(bundleDir, manifest.artifacts.video), join(mediaOutDir, plan.video));
		journeyInfo.video = plan.video;
	}
	for (const [slug, target] of Object.entries(plan.chapters)) {
		const chapter = manifest.chapters.find(
			(entry) => basename(entry.screenshot, ".png") === slug
		);
		if (!chapter) {
			warnings.push(`bundle ${recordingId} has no chapter "${slug}"; skipped`);
			continue;
		}
		copyFileSync(join(bundleDir, chapter.screenshot), join(mediaOutDir, target.file));
		captures[target.key] = { file: target.file, journey, title: chapter.title };
	}
	journeys[journey] = journeyInfo;
}

const siteMedia = { exportedAt: new Date().toISOString(), captures, journeys };
const banner =
	"// GENERATED by scripts/site-media.ts — do not edit. Refresh with `pnpm site:media`.\n";
writeFileSync(
	manifestPath,
	`${banner}export const siteMedia = ${JSON.stringify(siteMedia, null, "\t")} as const;\n`
);

const oxfmt = spawnSync(
	process.platform === "win32" ? "pnpm.cmd" : "pnpm",
	["exec", "oxfmt", "--write", manifestPath],
	{
		cwd: repositoryRoot,
		shell: process.platform === "win32",
		stdio: "inherit",
		windowsHide: true
	}
);
if (oxfmt.status !== 0) {
	process.exit(oxfmt.status ?? 1);
}

for (const warning of warnings) {
	process.stdout.write(`warning: ${warning}\n`);
}
process.stdout.write(
	`\nSite media exported to ${mediaOutDir}:\n${Object.values(captures)
		.map((capture) => `  ${capture.file} — ${capture.title}`)
		.join("\n")}\n`
);
