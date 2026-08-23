import { join } from "node:path";
import {
	buildPluginBundle,
	MAP_REVIEW_PLUGIN_IDS,
	NIAGARA_PLUGIN_IDS,
	OBSERVATORY_PLUGIN_IDS
} from "./plugin-bundle.ts";
import { validatePublicPluginBundle } from "./plugin-bundle.ts";
import { PUBLIC_VERSION } from "./pack-public-packages.ts";

const repositoryRoot = join(import.meta.dirname, "..");
const preset = process.argv[2];

function releaseArgument(name: string) {
	const index = process.argv.indexOf(`--${name}`);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (value === undefined) throw new Error(`Public plugin release requires --${name} <value>.`);
	return value;
}
const presets = {
	full: { directory: "plugins", plugins: undefined, stem: `ue-shed-plugins-${PUBLIC_VERSION}` },
	"map-review": {
		directory: "plugins-map-review",
		plugins: MAP_REVIEW_PLUGIN_IDS,
		stem: `ue-shed-plugins-map-review-${PUBLIC_VERSION}`
	},
	niagara: {
		directory: "plugins-niagara",
		plugins: NIAGARA_PLUGIN_IDS,
		stem: `ue-shed-plugins-niagara-${PUBLIC_VERSION}`
	},
	observatory: {
		directory: "plugins-observatory",
		plugins: OBSERVATORY_PLUGIN_IDS,
		stem: `ue-shed-plugins-observatory-${PUBLIC_VERSION}`
	}
} as const;

if (
	preset !== "full" &&
	preset !== "map-review" &&
	preset !== "niagara" &&
	preset !== "observatory"
) {
	throw new Error(
		"Usage: node scripts/release-plugin-bundle.ts <full|map-review|niagara|observatory>"
	);
}

const selected = presets[preset];
const candidateManifest = releaseArgument("candidate-manifest");
const sourceCommit = releaseArgument("commit");
const sourceRef = releaseArgument("ref");
const result = await buildPluginBundle({
	candidateManifest,
	output: join(repositoryRoot, "out", "releases", PUBLIC_VERSION, selected.directory),
	releaseVersion: PUBLIC_VERSION,
	releaseAssetStem: selected.stem,
	requestedPlugins: selected.plugins,
	sourceCommit,
	sourceRef
});

await validatePublicPluginBundle(result);

console.log(
	`Built ${result.manifest.plugins.length} Unreal plugin sources for suite ${PUBLIC_VERSION}.`
);
