import type { siteMedia } from "./showcase/media.js";

export type Guide = {
	readonly slug: string;
	readonly title: string;
	readonly summary: string;
	readonly requirement: string;
	readonly source: string;
	readonly steps: readonly { readonly title: string; readonly text: string }[];
	readonly command: string;
	readonly captures: readonly {
		readonly key: keyof typeof siteMedia.captures;
		readonly caption: string;
	}[];
	readonly boundary: string;
};

export const guides: readonly Guide[] = [
	{
		slug: "getting-started",
		title: "Start with a saved project",
		summary:
			"Explore Unreal content, ask questions, and inspect the evidence before opening the editor.",
		requirement: "Node.js 26+, pnpm 11, Rust 1.89+ · source checkout",
		source: "docs/showcase.md",
		steps: [
			{
				title: "Build and open Workbench",
				text: "Clone the repository and run the commands below from its root. The showcase command builds the native reader and desktop app. Unreal is not needed for this first walkthrough."
			},
			{
				title: "Choose the sample project",
				text: "On a fresh profile, choose Try the sample project. Workbench indexes the committed generic fixture. You can also open your own .uproject; selecting a project reads saved files without launching Unreal."
			},
			{
				title: "Follow a question",
				text: "Open Data Authoring to inspect a table, Game Text to find a source line, or Config Explorer to explain a platform difference. Each guide includes a CLI equivalent."
			},
			{
				title: "Add a live editor when needed",
				text: "Live capture, Apply, and Save need a compatible Unreal installation and the relevant plugins. The Launch menu offers With plugin suite and Plain editor. On Windows, plugin builds also require the Unreal C++ workload in Visual Studio 2022."
			}
		],
		command:
			"git clone https://github.com/ue-shed/ue-shed.git\ncd ue-shed\npnpm install\npnpm showcase",
		captures: [
			{
				key: "authoring",
				caption:
					"Start with real saved content: the sample DataTable opens without an editor."
			}
		],
		boundary:
			"Early-stage software. Unreal 5.7 is the development baseline; saved inspection and live editor operations have different prerequisites. Workbench is optional: public libraries and the CLI own the workflows."
	},
	{
		slug: "data-authoring",
		title: "Inspect a table. Find the outliers.",
		summary:
			"Read typed DataTable fields from disk, then chart the rows you are investigating.",
		requirement: "Saved packages · no editor required for inspection",
		source: "docs/products/data-authoring.md",
		steps: [
			{
				title: "Open Data Authoring",
				text: "With the sample project selected, open Data Authoring and choose DT_Scalars. The table summary identifies the saved package. Field types, cell evidence, and completeness diagnostics stay attached to the data."
			},
			{
				title: "Switch from Grid to Charts",
				text: "Charts profile the filtered rows: boolean and enum distributions, numeric histograms, grouped averages, and a scatter of numeric fields. Filter the table to narrow the question without leaving its catalog."
			},
			{
				title: "Keep drafts separate from saved state",
				text: "Edits belong to a draft session with undo and redo. Review changes before using live Apply, then explicitly Save when persistence is intended. A saved snapshot is not an apply receipt."
			}
		],
		command:
			"pnpm ue-shed authoring inspect fixtures/unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset\npnpm ue-shed authoring analyze fixtures/unreal-project /Game/Fixture/Authoring/DT_Scalars.DT_Scalars",
		captures: [
			{ key: "authoring", caption: "Typed rows and fields from the committed scalar table." },
			{
				key: "authoringCharts",
				caption: "The same table, viewed as distributions in Charts."
			}
		],
		boundary:
			"Saved-package inspection is read-only. Applying and saving edits requires the separately enabled live authoring capability. Partial package support is reported in diagnostics."
	},
	{
		slug: "game-text",
		title: "Find the text and every place it is used",
		summary: "Search saved game text, check writing rules and see every place a line appears.",
		requirement: "Saved assets · no editor required for search",
		source: "docs/products/game-text.md",
		steps: [
			{
				title: "Scan and search",
				text: "Open Game Text and choose Scan project if needed. Type “Hold to skip” in Search text and watch the live match count. Use Editable, Read only, No translator notes and the review chips to narrow the list."
			},
			{
				title: "See where a line appears",
				text: "Select a line to see its key, character and word counts, translator notes and Where it appears. Rows keep exact Unreal names. Copy icons copy text, keys and asset paths; Show in Unreal opens the asset in the connected editor’s Content Browser."
			},
			{
				title: "Check read problems",
				text: "The toolbar shows the scan time and any assets not fully read. Open Read problems for the warning details, and inspect the selected line’s read problems below its locations. Offline, missing-plugin and failed navigation never claims the asset opened."
			},
			{
				title: "Check the writing",
				text: "Open Quality checks. Create rules file starts with examples, or Load rules opens your rules. Review the rules and roles overview, then select a finding to see a highlighted term and How to fix. Edit rules, Preview and Save update checks without changing game text."
			},
			{
				title: "Take the results away",
				text: "Use Export for a readable CSV or JSON, and Presets to save or open the search and writing rules."
			}
		],
		command:
			'pnpm ue-shed text scan fixtures/unreal-project\npnpm ue-shed text search fixtures/unreal-project "Hold to skip"\npnpm ue-shed text rules init fixtures/unreal-project',
		captures: [
			{
				key: "gameText",
				caption: "A saved line, with its key, translator notes and every place it appears."
			}
		],
		boundary:
			"Game Text reads saved assets. It does not show the translated text of a running game. Read problems and incomplete assets remain visible."
	},
	{
		slug: "config-explorer",
		title: "Explain why a config value wins",
		summary:
			"Compare platforms, trace ordered contributions, and distinguish an empty value from a missing one.",
		requirement: "Portable sample included · no editor required",
		source: "docs/products/config-explorer.md",
		steps: [
			{
				title: "Open the platform comparison",
				text: "Open Config Explorer. Its portable sample runs real resolver queries even without a selected Unreal project. Choose the platform-divergence example, then Compare platforms to query PlatformA and PlatformB."
			},
			{
				title: "Read the contribution ledger",
				text: "Read each platform's contribution ledger below the final value to see the ordered operations, source locations, and which values survived or were superseded. Edit the family, section, key, and platform to ask another question."
			},
			{
				title: "Try the edge cases",
				text: "Last writer demonstrates scalar replacement. Empty vs missing distinguishes an initialized empty array. Choose Coverage gap, then Trace value to make unsupported syntax visible. Switch to Selected project to investigate your project's saved configuration."
			}
		],
		command:
			"pnpm ue-shed config compare packages/config-explorer/fixtures/config-source/Project Fixture.Settings Entries --platform PlatformA --platform PlatformB --engine-root packages/config-explorer/fixtures/config-source/Engine --family Game",
		captures: [
			{
				key: "configExplorer",
				caption: "Two platforms, with their effective saved values explained side by side."
			},
			{
				key: "configLineage",
				caption: "The ordered source contributions explain how a value was assembled."
			}
		],
		boundary:
			"The resolver explains saved source configuration. Runtime console variables, command-line overrides, and unsaved editor state are outside this authority."
	},
	{
		slug: "map-review",
		title: "Return to the same view. Compare the result.",
		summary:
			"Build a review set around a subject, capture it in Unreal, and retain independently addressable runs.",
		requirement: "Rendering Unreal editor + Core, Cameras, and Observatory capabilities",
		source: "docs/products/map-review.md",
		steps: [
			{
				title: "Prepare a live fixture",
				text: "Follow the repository showcase setup for Map Review and launch the fixture editor. Confirm the connected endpoint and capability status in Workbench before capturing."
			},
			{
				title: "Frame and approve a view",
				text: "Use Live World to choose an actor, generate a candidate, and tune its framing. Review the preview before approving the view into a Review Set."
			},
			{
				title: "Capture and compare",
				text: "Capture the approved set, then select a completed run from history. Capture again after a change. Each run retains its own evidence so the earlier image remains available."
			}
		],
		command: "pnpm fixture:launch-authoring\npnpm test:flow:map-review",
		captures: [
			{
				key: "mapReview",
				caption:
					"The saved Camera Lab map read offline, with actor positions and the selected Review Subject's details."
			}
		],
		boundary:
			"Capturing needs a rendering editor. The flow test uses the generic fixture, requires a clean map, and retains PNG evidence. The illustration shows where review starts: the saved Camera Lab map's actors and positions, read offline without Unreal."
	}
];
