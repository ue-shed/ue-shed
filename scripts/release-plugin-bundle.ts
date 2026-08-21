import { join } from "node:path";
import {
	buildPluginBundle,
	MAP_REVIEW_PLUGIN_IDS,
	OBSERVATORY_PLUGIN_IDS
} from "./plugin-bundle.ts";
import { PUBLIC_VERSION } from "./pack-public-packages.ts";

const repositoryRoot = join(import.meta.dirname, "..");
const preset = process.argv[2];
const presets = {
	full: { directory: "plugins", plugins: undefined, stem: `ue-shed-plugins-${PUBLIC_VERSION}` },
	"map-review": {
		directory: "plugins-map-review",
		plugins: MAP_REVIEW_PLUGIN_IDS,
		stem: `ue-shed-plugins-map-review-${PUBLIC_VERSION}`
	},
	observatory: {
		directory: "plugins-observatory",
		plugins: OBSERVATORY_PLUGIN_IDS,
		stem: `ue-shed-plugins-observatory-${PUBLIC_VERSION}`
	}
} as const;

if (preset !== "full" && preset !== "map-review" && preset !== "observatory") {
	throw new Error("Usage: node scripts/release-plugin-bundle.ts <full|map-review|observatory>");
}

const selected = presets[preset];
const result = await buildPluginBundle({
	output: join(repositoryRoot, "out", "releases", PUBLIC_VERSION, selected.directory),
	releaseVersion: PUBLIC_VERSION,
	releaseAssetStem: selected.stem,
	requestedPlugins: selected.plugins
});

console.log(
	`Built ${result.manifest.plugins.length} Unreal plugin sources for suite ${PUBLIC_VERSION}.`
);
