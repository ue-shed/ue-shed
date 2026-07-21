import { siteMedia } from "./showcase/media.js";

export const repositoryUrl = "https://github.com/peculiarnewbie/ue-shed";

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
	}
];

export type Tool = {
	readonly name: string;
	readonly tag: string;
	readonly line: string;
};

export const tools: readonly Tool[] = [
	{
		name: "ue-shed",
		tag: "CLI",
		line: "Everything below, scriptable: inspect, audit, author, review, capture."
	},
	{
		name: "uasset",
		tag: "Rust crate",
		line: "Read-only parser for saved .uasset packages. Versioned JSON out, no engine needed."
	},
	{
		name: "Data Authoring",
		tag: "Library + UI",
		line: "Inspect and edit DataTables from disk or a live editor. Sessions, typed drafts, undo/redo."
	},
	{
		name: "Asset Audits",
		tag: "Library + UI",
		line: "Rule-check every texture in a content folder, straight from saved packages."
	},
	{
		name: "Game Text",
		tag: "Library",
		line: "Search player-facing text across a saved content corpus, with coverage reports."
	},
	{
		name: "Map Review",
		tag: "Live + UI",
		line: "Capture frames from a running editor, approve a set, diff before and after."
	},
	{
		name: "Actor Observatory",
		tag: "Plugin + UI",
		line: "Discover actors and stream their state live — bounded, resumable, backpressure-aware."
	},
	{
		name: "RC Explorer",
		tag: "UI",
		line: "See what stock Remote Control already exposes before adding anything."
	},
	{
		name: "UEShed* plugins",
		tag: "Unreal plugins",
		line: "Small, separately enabled editor plugins. Capabilities are negotiated, not assumed."
	},
	{
		name: "Workbench",
		tag: "Electron",
		line: "The showcase desktop app. A client of the public API — nothing more."
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
