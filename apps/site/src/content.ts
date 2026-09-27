import { siteMedia } from "./showcase/media.js";

export const repositoryUrl = "https://github.com/ue-shed/ue-shed";

export type TerminalLine = {
	readonly kind: "command" | "output";
	readonly text: string;
};

export type TerminalSpec = {
	readonly title: string;
	readonly lines: readonly TerminalLine[];
};

function command(text: string): TerminalLine {
	return { kind: "command", text };
}

function output(text: string): TerminalLine {
	return { kind: "output", text };
}

// Trimmed from real `ue-shed authoring inspect` output against the repository fixture.
export const inspectTerminal: TerminalSpec = {
	title: "saved package, no editor",
	lines: [
		command("ue-shed authoring inspect DT_Scalars.uasset"),
		output("{"),
		output('  "fingerprint": "sha256-v1:1ca8a88d…",'),
		output('  "snapshot": {'),
		output('    "authority": { "kind": "project_files" },'),
		output('    "completeness": "complete",'),
		output('    "diagnostics": [],'),
		output('    "producer": { "name": "uasset-parser", "version": "0.1.0" },'),
		output('    "table": {'),
		output('      "kind": "data_table",'),
		output('      "objectPath": "/Game/Fixture/Authoring/DT_Scalars.DT_Scalars",'),
		output('      "rows": [ … ]'),
		output("    }"),
		output("  }"),
		output("}")
	]
};

export type ShowcaseTab = {
	readonly id: string;
	readonly label: string;
	readonly capture: keyof typeof siteMedia.captures;
	readonly alt: string;
	readonly note: string;
	readonly chips: readonly string[];
};

// Capture keys come from the generated media manifest, keeping screenshots in sync
// with the available site media.
export const showcaseTabs: readonly ShowcaseTab[] = [
	{
		id: "authoring",
		label: "Data Authoring",
		capture: "authoring",
		alt: "The Workbench's Data Authoring route with DT_Scalars read from its saved package",
		note: "A saved DataTable opened straight from its .uasset package: typed fields, cell evidence, completeness diagnostics.",
		chips: ["saved package · no editor", "typed fields + evidence", "same api as the cli"]
	},
	{
		id: "game-text",
		label: "Game Text",
		capture: "gameText",
		alt: "The Workbench's Game Text route searching the fixture's saved string table corpus",
		note: "Player-facing text searched across the saved corpus — storage, identity, and authority stay attached to every result.",
		chips: ["saved corpus", "identity-aware search", "coverage gaps"]
	},
	{
		id: "map-review",
		label: "Map Review",
		capture: "mapReview",
		alt: "The Workbench's Map Review route comparing immutable capture runs of a fixture camera pose",
		note: "An approved camera pose recaptured into an immutable run, before and after kept independently addressable.",
		chips: ["immutable capture runs", "before/after history", "live editor capture"]
	},
	{
		id: "config-explorer",
		label: "Config Explorer",
		capture: "configExplorer",
		alt: "Config Explorer comparing effective saved values for two sample platforms",
		note: "Follow each saved value through its ordered source contributions and see why platforms differ.",
		chips: ["saved configuration", "source lineage", "platform comparison"]
	}
];

export type Tool = {
	readonly name: string;
	readonly tag: string;
	readonly line: string;
	readonly href: string;
};

export const tools: readonly Tool[] = [
	{
		name: "Data Authoring",
		tag: "Saved + live",
		href: "/docs/data-authoring",
		line: "Inspect typed DataTables, chart filtered rows, and carry drafts through review, Apply, and Save."
	},
	{
		name: "Game Text",
		tag: "Saved corpus",
		href: "/docs/game-text",
		line: "Find player-facing language with identity, authored context, and every known use attached."
	},
	{
		name: "Config Explorer",
		tag: "Saved source",
		href: "/docs/config-explorer",
		line: "Explain a saved .ini value through its contribution history and compare platforms."
	},
	{
		name: "Texture Audit",
		tag: "Saved + optional previews",
		href: `${repositoryUrl}/blob/main/docs/showcase.md#demo-2-texture-asset-audit`,
		line: "Check texture sizes, groups, and compression against rules; investigate individual outliers."
	},
	{
		name: "Map Review",
		tag: "Live editor",
		href: "/docs/map-review",
		line: "Frame an actor, approve review views, and compare independently addressable capture runs."
	},
	{
		name: "Map Capture",
		tag: "Live editor",
		href: `${repositoryUrl}/blob/main/docs/products/map-capture.md`,
		line: "Capture orthographic map tiles into a multiresolution pyramid with immutable evidence."
	},
	{
		name: "World Log",
		tag: "Saved history + Perforce",
		href: `${repositoryUrl}/blob/main/docs/products/map-history.md`,
		line: "Compare saved map revisions and investigate actor changes across time."
	},
	{
		name: "Project Custodian",
		tag: "Local storage",
		href: `${repositoryUrl}/blob/main/docs/products/project-custodian.md`,
		line: "Inventory rebuildable storage, review a durable cleanup proposal, and retain a receipt."
	},
	{
		name: "Input Atlas",
		tag: "Saved packages",
		href: `${repositoryUrl}/blob/main/packages/enhanced-input/README.md`,
		line: "Inspect Enhanced Input mappings, actions, modifiers, and contested chords."
	},
	{
		name: "Blueprint Graphs",
		tag: "Saved packages",
		href: `${repositoryUrl}/blob/main/docs/showcase.md`,
		line: "Reconstruct saved Blueprint nodes, pins, defaults, and links outside the editor."
	},
	{
		name: "Live World Scout",
		tag: "Live editor",
		href: `${repositoryUrl}/blob/main/packages/observatory/README.md`,
		line: "Search and select actors, follow a subject, and receive bounded transform updates."
	},
	{
		name: "Scenario Studio",
		tag: "Live PIE · proving slice",
		href: `${repositoryUrl}/blob/main/docs/products/scenario-studio.md`,
		line: "Run the bounded Movement Gym scenario with status, cancellation, and evidence."
	},
	{
		name: "Niagara Preview",
		tag: "Live editor",
		href: `${repositoryUrl}/blob/main/docs/products/niagara-preview.md`,
		line: "Capture portable preview evidence from a separately enabled Niagara workflow."
	},
	{
		name: "uasset",
		tag: "Rust + native + WASM",
		href: `${repositoryUrl}/blob/main/packages/uasset/README.md`,
		line: "Read saved Unreal packages through shared parser and inspection libraries, without an engine."
	},
	{
		name: "CLI & libraries",
		tag: "Headless-first",
		href: "/docs/getting-started",
		line: "Use the same domain workflows from a shell, automation, or your own trusted host."
	}
];
export type Fact = {
	readonly label: string;
	readonly text: string;
};

export const facts: readonly Fact[] = [
	{
		label: "Open source",
		text: "Every package, plugin, fixture, and this site. Public repo, no accounts, no keys."
	},
	{
		label: "Unreal optional",
		text: "Saved packages are parsed from disk by a Rust reader. Live features are opt-in."
	},
	{
		label: "One public API",
		text: "The CLI, the Workbench, and your own host all call the same libraries."
	}
];

export type ApproachPoint = {
	readonly title: string;
	readonly text: string;
};

export const approach: readonly ApproachPoint[] = [
	{
		title: "Saved state, no engine",
		text: "The Rust reader parses .uasset packages directly. Inspection, audits, and text search run anywhere — CI included."
	},
	{
		title: "Live state, by negotiation",
		text: "Editor plugins advertise a capability manifest. Tools use what exists and say plainly what doesn't."
	},
	{
		title: "No privileged client",
		text: "Delete the Workbench and every capability still works from the CLI and libraries. That's an acceptance test, not a hope."
	}
];

export const diagram = String.raw`
  CLI        Workbench        your host
     \           |              /
        public libraries
              |
    versioned protocols
              |
  stock Unreal + opt-in plugins
`;
