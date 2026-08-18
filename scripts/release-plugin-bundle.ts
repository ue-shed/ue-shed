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
	full: { directory: "plugins", plugins: undefined },
	"map-review": { directory: "plugins-map-review", plugins: MAP_REVIEW_PLUGIN_IDS },
	observatory: { directory: "plugins-observatory", plugins: OBSERVATORY_PLUGIN_IDS }
} as const;

if (preset !== "full" && preset !== "map-review" && preset !== "observatory") {
	throw new Error("Usage: node scripts/release-plugin-bundle.ts <full|map-review|observatory>");
}

const selected = presets[preset];
const result = await buildPluginBundle({
	output: join(repositoryRoot, "out", "releases", PUBLIC_VERSION, selected.directory),
	releaseVersion: PUBLIC_VERSION,
	requestedPlugins: selected.plugins
});

console.log(
	`Built ${result.manifest.plugins.length} Unreal plugin sources for suite ${PUBLIC_VERSION}.`
);
