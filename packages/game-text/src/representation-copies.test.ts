import { describe, expect, it } from "vitest";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { textCorpusFromExtractionEvents } from "./corpus.js";
import { mountPackageTextEvent } from "./package-object-path.js";
import { emptyPackageTextRecord } from "./package-text-record.js";
import {
	classifyFoldedTextAudience,
	foldRepresentationCopies,
	representationSite,
	staleRuntimeCopy
} from "./representation-copies.js";
import { textCorpusQuery } from "./query.test-support.js";

type Occurrence = SavedAssetPackageTextRecord["occurrences"][number];

// Shapes from the native reader's package records (uasset-io 1.12) for Widget Blueprints saved
// by UE 5.7 and UE 4.27, renamed: a Blueprint's compile saves its widget tree again under the
// generated class, its animations as `Name_INST`, and construction-script nodes only there.
const property = (
	object_path: string,
	property_path: string,
	source: string,
	key: string,
	class_path = "/Script/UMG.TextBlock",
	namespace = "[2C1F6B5E4D0A9C8B7E6F5A4B3C2D1E0F]"
): Occurrence => ({
	source,
	dev_notes: "",
	identity: { status: "resolved", namespace, key },
	location: { kind: "asset_property", object_path, class_path, property_path },
	edit_capability: "read_only"
});

const classes = {
	blueprint: "/Game/UI/WBP_Menu.WBP_Menu",
	generatedClass: "/Game/UI/WBP_Menu.WBP_Menu_C",
	classDefault: "/Game/UI/WBP_Menu.Default__WBP_Menu_C"
};

/** A Widget Blueprint package record; `null` stands for a reader before uasset-io 1.12. */
const menu = (
	occurrences: readonly Occurrence[],
	blueprintClasses: SavedAssetPackageTextRecord["blueprintClasses"] | null = [classes]
): SavedAssetPackageTextRecord => ({
	...emptyPackageTextRecord("/project/Content/UI/WBP_Menu.uasset"),
	occurrences,
	...(blueprintClasses === null ? undefined : { blueprintClasses })
});

const title = property("/Game/UI/WBP_Menu.WBP_Menu.WidgetTree.Title", "Text", "Play", "Title");
const compiledTitle = property(
	"/Game/UI/WBP_Menu.WBP_Menu_C.WidgetTree.Title",
	"Text",
	"Play",
	"Title"
);

describe("representationSite", () => {
	const prefixes = [
		{ path: classes.generatedClass, blueprint: classes.blueprint, kind: "generated_class" },
		{ path: classes.classDefault, blueprint: classes.blueprint, kind: "class_default" }
	] as const;
	it.each([
		["WBP_Menu_C.WidgetTree.Title", "WBP_Menu.WidgetTree.Title", "generated_class"],
		["WBP_Menu_C:WidgetTree.Title", "WBP_Menu:WidgetTree.Title", "generated_class"],
		["WBP_Menu_C:FadeIn_INST.FadeIn", "WBP_Menu:FadeIn.FadeIn", "instance"],
		["WBP_Menu_C.FadeIn_INST.FadeIn.Track_0", "WBP_Menu.FadeIn.FadeIn.Track_0", "instance"],
		["Default__WBP_Menu_C", "WBP_Menu", "class_default"],
		["Default__WBP_Menu_C.Prompt", "WBP_Menu.Prompt", "class_default"]
	])("maps %s to its authored site", (copy, site, kind) => {
		expect(
			representationSite(
				`/Game/UI/WBP_Menu.${copy}`,
				prefixes.map((prefix) => ({
					...prefix,
					instances: prefix.kind !== "class_default"
				}))
			)
		).toEqual({ site: `/Game/UI/WBP_Menu.${site}`, kind });
	});
	it("leaves authored paths and look-alike names alone", () => {
		const all = prefixes.map((prefix) => ({ ...prefix, instances: true }));
		for (const path of [
			"/Game/UI/WBP_Menu.WBP_Menu.WidgetTree.Title",
			"/Game/UI/WBP_Menu.WBP_Menu_Cue.Text",
			"/Game/UI/WBP_Menu.WBP_Menu_C_2"
		])
			expect(representationSite(path, all)).toBeUndefined();
	});
});

describe("foldRepresentationCopies", () => {
	it("folds a compiled widget-tree copy into the widget the Blueprint authored", () => {
		const scs = property(
			"/Game/UI/WBP_Menu.WBP_Menu_C.SimpleConstructionScript_0.SCS_Node_0",
			"CategoryName",
			"Default",
			"Default",
			"/Script/Engine.SCS_Node",
			"SCS"
		);
		const folded = foldRepresentationCopies(menu([compiledTitle, title, scs]));
		expect(folded.occurrences).toEqual([
			// The authored site wins even though the reader saw the copy first.
			{
				...title,
				copies: [
					{
						object_path: "/Game/UI/WBP_Menu.WBP_Menu_C.WidgetTree.Title",
						kind: "generated_class",
						source: "Play",
						class_path: "/Script/UMG.TextBlock"
					}
				]
			},
			// Construction-script nodes are saved only under the generated class: no authored
			// site, so the copy stays the place, at its own path.
			scs
		]);
		expect(foldRepresentationCopies(folded)).toEqual(folded);
	});

	it("keeps the authored text when the compiled class holds older text", () => {
		const edited = { ...title, source: "Play now" };
		const folded = foldRepresentationCopies(menu([edited, compiledTitle]));
		expect(folded.occurrences).toEqual([
			{
				...edited,
				copies: [
					{
						object_path: compiledTitle.location.object_path,
						kind: "generated_class",
						source: "Play",
						class_path: "/Script/UMG.TextBlock"
					}
				]
			}
		]);
	});

	it("keeps two properties that share a key as two places", () => {
		// A real default object saves ButtonText[0] and ButtonTooltipText[0] under one key.
		const defaults = [
			property(
				classes.classDefault,
				"ButtonText[0]",
				"01",
				"Tab0",
				"/Game/UI/WBP_Menu.WBP_Menu_C"
			),
			property(
				classes.classDefault,
				"ButtonTooltipText[0]",
				"01",
				"Tab0",
				"/Game/UI/WBP_Menu.WBP_Menu_C"
			)
		];
		expect(foldRepresentationCopies(menu(defaults)).occurrences).toEqual(defaults);
		// The same pair under the Blueprint and the generated class folds pairwise.
		const authored = defaults.map((item) => ({
			...item,
			location: { ...item.location, object_path: "/Game/UI/WBP_Menu.WBP_Menu.Tabs" }
		}));
		const compiled = defaults.map((item) => ({
			...item,
			location: { ...item.location, object_path: "/Game/UI/WBP_Menu.WBP_Menu_C.Tabs" }
		}));
		const folded = foldRepresentationCopies(menu([...authored, ...compiled])).occurrences;
		expect(folded.map((item) => [item.location.object_path, item.copies?.length])).toEqual([
			["/Game/UI/WBP_Menu.WBP_Menu.Tabs", 1],
			["/Game/UI/WBP_Menu.WBP_Menu.Tabs", 1]
		]);
	});

	it("keeps a copy under another key as its own place", () => {
		const rekeyed = { ...compiledTitle, identity: { ...title.identity, key: "OldTitle" } };
		expect(foldRepresentationCopies(menu([title, rekeyed])).occurrences).toEqual([
			title,
			rekeyed
		]);
	});

	it("never folds without the reader's Blueprint evidence", () => {
		// An asset whose own name ends in _C, and a record from a reader before 1.12.
		const cue = property("/Game/Audio/Cue_C.Cue_C", "Subtitle", "Hello", "Hello");
		const cueCopy = property("/Game/Audio/Cue_C.Cue_C.Sub", "Subtitle", "Hello", "Hello");
		const record = menu([cue, cueCopy], [{ ...classes }]);
		expect(foldRepresentationCopies(record).occurrences).toEqual([cue, cueCopy]);
		const older = menu([title, compiledTitle], null);
		expect(foldRepresentationCopies(older)).toBe(older);
	});

	it("folds skeleton classes and default objects, ranking the generated class first", () => {
		const skeleton = {
			...classes,
			skeletonClass: "/Game/UI/WBP_Menu.SKEL_WBP_Menu_C",
			skeletonClassDefault: "/Game/UI/WBP_Menu.Default__SKEL_WBP_Menu_C"
		};
		const skeletonTitle = property(
			"/Game/UI/WBP_Menu.SKEL_WBP_Menu_C.WidgetTree.Title",
			"Text",
			"Play",
			"Title"
		);
		const defaults = property(classes.classDefault, "Prompt", "Hold", "Hold");
		const skeletonDefaults = property(
			"/Game/UI/WBP_Menu.Default__SKEL_WBP_Menu_C",
			"Prompt",
			"Hold",
			"Hold"
		);
		const folded = foldRepresentationCopies(
			menu([skeletonTitle, compiledTitle, skeletonDefaults, defaults], [skeleton])
		).occurrences;
		expect(folded).toEqual([
			// No authored widget was saved: the generated class's copy is the place.
			{
				...compiledTitle,
				copies: [
					{
						object_path: skeletonTitle.location.object_path,
						kind: "skeleton",
						source: "Play",
						class_path: "/Script/UMG.TextBlock"
					}
				]
			},
			{
				...defaults,
				copies: [
					{
						object_path: skeletonDefaults.location.object_path,
						kind: "skeleton",
						source: "Hold",
						class_path: "/Script/UMG.TextBlock"
					}
				]
			}
		]);
	});

	it("folds UE 4.27 package-relative animation instances once paths are mounted", () => {
		// UE 4.27 saves None as the package name; the reader writes object paths relative to it.
		const record: SavedAssetPackageTextRecord = {
			...emptyPackageTextRecord("Content/UI/WBP_Menu.uasset"),
			occurrences: [
				property(
					"WBP_Menu.FadeIn.FadeIn.MovieSceneFloatTrack_0",
					"DisplayName",
					"Render Opacity",
					"/Script/UMG.Widget:RenderOpacity",
					"/Script/MovieSceneTracks.MovieSceneFloatTrack",
					"UObjectDisplayNames"
				),
				property(
					"WBP_Menu_C.FadeIn_INST.FadeIn.MovieSceneFloatTrack_0",
					"DisplayName",
					"Render Opacity",
					"/Script/UMG.Widget:RenderOpacity",
					"/Script/MovieSceneTracks.MovieSceneFloatTrack",
					"UObjectDisplayNames"
				)
			],
			blueprintClasses: [
				{
					blueprint: "WBP_Menu",
					generatedClass: "WBP_Menu_C",
					classDefault: "Default__WBP_Menu_C"
				}
			]
		};
		const mounted = mountPackageTextEvent("/project", {
			...record,
			path: "/project/Content/UI/WBP_Menu.uasset"
		});
		if (mounted.event !== "text_package_record") throw new Error("Expected a record");
		expect(mounted.blueprintClasses).toEqual([classes]);
		expect(foldRepresentationCopies(mounted).occurrences).toEqual([
			expect.objectContaining({
				location: expect.objectContaining({
					object_path: "/Game/UI/WBP_Menu.WBP_Menu.FadeIn.FadeIn.MovieSceneFloatTrack_0"
				}),
				copies: [
					{
						object_path:
							"/Game/UI/WBP_Menu.WBP_Menu_C.FadeIn_INST.FadeIn.MovieSceneFloatTrack_0",
						kind: "instance",
						source: "Render Opacity",
						class_path: "/Script/MovieSceneTracks.MovieSceneFloatTrack"
					}
				]
			})
		]);
	});
});

describe("folded corpus", () => {
	it.each(["Saved label", "Older label"])(
		"folds a unique pin's compiled literal with text %s",
		(compiledSource) => {
			const pin = property(
				`${classes.blueprint}.EventGraph.Node`,
				"Pins[4].DefaultTextValue",
				"Saved label",
				"Pin"
			);
			const bytecode = property(
				`${classes.generatedClass}.ExecuteUbergraph_Menu`,
				"ScriptBytecode[42]",
				compiledSource,
				"Pin",
				"/Script/CoreUObject.Function"
			);
			const folded = foldRepresentationCopies(menu([bytecode, pin]));
			expect(folded.occurrences).toEqual([
				{
					...pin,
					copies: [
						{
							object_path: bytecode.location.object_path,
							kind: "generated_class",
							source: compiledSource,
							class_path: "/Script/CoreUObject.Function"
						}
					]
				}
			]);
			expect(staleRuntimeCopy(folded.occurrences[0]!) !== undefined).toBe(
				compiledSource !== "Saved label"
			);
			expect(foldRepresentationCopies(folded)).toEqual(folded);
		}
	);
	it("keeps ambiguous pin sites and literals from another Blueprint as independent evidence", () => {
		const pin = property(
			`${classes.blueprint}.EventGraph.First`,
			"Pins[4].DefaultTextValue",
			"First",
			"Pin"
		);
		const second = property(
			`${classes.blueprint}.EventGraph.Second`,
			"Pins[4].DefaultTextValue",
			"Second",
			"Pin"
		);
		const bytecode = property(
			`${classes.generatedClass}.ExecuteUbergraph_Menu`,
			"ScriptBytecode[42]",
			"Older",
			"Pin"
		);
		const ambiguous = menu([pin, second, bytecode]);
		expect(foldRepresentationCopies(ambiguous)).toEqual(ambiguous);
		const foreign = menu([
			pin,
			{
				...bytecode,
				location: { ...bytecode.location, object_path: "/Game/UI/Other.Other_C.Function" }
			}
		]);
		expect(foldRepresentationCopies(foreign)).toEqual(foreign);
	});
	it("lists one place per authored site and flags text the compiled class has not caught up with", () => {
		const corpus = textCorpusFromExtractionEvents({
			projectRoot: "/project",
			events: [menu([{ ...title, source: "Play now" }, compiledTitle])]
		});
		expect(corpus.coverage).toMatchObject({ textUnits: 1, textOccurrences: 1 });
		const [unit] = corpus.units;
		// The line's source is the authored site's text, so the key has one text.
		expect(unit!.source).toEqual({ status: "consistent", value: "Play now" });
		expect(unit!.occurrences[0]!.copies).toEqual([
			{
				objectPath: "/Game/UI/WBP_Menu.WBP_Menu_C.WidgetTree.Title",
				kind: "generated_class",
				source: "Play"
			}
		]);
		const query = textCorpusQuery(corpus);
		const signals = query.focus({ id: unit!.id, pageSize: 1 })!.unit.reviewSignals;
		expect(signals).toContain("compiled_copy_differs");
		expect(signals).not.toContain("conflicting");
		const page = query.search({ query: "", capability: "all", pageSize: 50 });
		expect(page.counts.conflicting).toBe(0);
		// Without the reader's Blueprint evidence, the same record reads as one key, two texts.
		const unfolded = textCorpusFromExtractionEvents({
			projectRoot: "/project",
			events: [menu([{ ...title, source: "Play now" }, compiledTitle], null)]
		});
		expect(unfolded.units[0]!.source).toEqual({
			status: "conflicting",
			values: ["Play", "Play now"]
		});
		// Search finds the line by its authored text only.
		expect(query.search({ query: "now", capability: "all", pageSize: 50 }).total).toBe(1);
	});

	it("classifies a folded place as the place alone when its copies agree", () => {
		// Copies differ from their place only in the class object, which no policy row reads.
		const tooltip = property(
			"/Game/UI/WBP_Menu.WBP_Menu.WidgetTree.Button",
			"ToolTipText",
			"Opens the map",
			"Map",
			"/Script/UMG.Button"
		);
		const corpus = textCorpusFromExtractionEvents({
			projectRoot: "/project",
			events: [
				menu([
					tooltip,
					{
						...tooltip,
						location: {
							...tooltip.location,
							object_path: "/Game/UI/WBP_Menu.WBP_Menu_C.WidgetTree.Button"
						}
					}
				])
			]
		});
		const [occurrence] = corpus.units[0]!.occurrences;
		expect(occurrence!.audience).toBe(
			textCorpusFromExtractionEvents({
				projectRoot: "/project",
				events: [menu([tooltip], null)]
			}).units[0]!.occurrences[0]!.audience
		);
	});

	it("classifies each copy from its own evidence: a runtime compiled copy keeps the line player text", () => {
		// The gather table matches text by namespace, key and source, so an edited place and its
		// stale compiled copy can carry different bits: the new tooltip is editor-only, the text
		// the game still runs is runtime.
		const place = {
			...property(
				"/Game/UI/WBP_Menu.WBP_Menu.WidgetTree.Hint",
				"ToolTipText",
				"New tooltip",
				"Hint"
			),
			gather_editor_only: true
		};
		const compiled = {
			...property(
				"/Game/UI/WBP_Menu.WBP_Menu_C.WidgetTree.Hint",
				"ToolTipText",
				"Old tooltip",
				"Hint",
				"/Script/UMG.Border"
			),
			gather_editor_only: false
		};
		const folded = foldRepresentationCopies(menu([place, compiled])).occurrences[0]!;
		expect(folded.copies).toEqual([
			{
				object_path: compiled.location.object_path,
				kind: "generated_class",
				source: "Old tooltip",
				class_path: "/Script/UMG.Border",
				gather_editor_only: false
			}
		]);
		expect(classifyFoldedTextAudience(folded)).toEqual({
			audience: "player",
			reason: "gather_table_runtime"
		});
		const corpus = textCorpusFromExtractionEvents({
			projectRoot: "/project",
			events: [menu([place, compiled])]
		});
		expect(corpus.units[0]!.occurrences[0]).toMatchObject({
			audience: "player",
			audienceReason: "gather_table_runtime"
		});
		// The place alone stays editor text.
		expect(
			textCorpusFromExtractionEvents({ projectRoot: "/project", events: [menu([place])] })
				.units[0]!.occurrences[0]!.audience
		).toBe("editor");
	});

	it("only claims what the game shows from the generated class or class defaults", () => {
		const skeletonClasses = [
			{ ...classes, skeletonClass: "/Game/UI/WBP_Menu.SKEL_WBP_Menu_C" }
		];
		const skeletonTitle = property(
			"/Game/UI/WBP_Menu.SKEL_WBP_Menu_C.WidgetTree.Title",
			"Text",
			"Play",
			"Title"
		);
		const signals = (occurrences: Occurrence[]) => {
			const corpus = textCorpusFromExtractionEvents({
				projectRoot: "/project",
				events: [menu(occurrences, skeletonClasses)]
			});
			const unit = corpus.units[0]!;
			return {
				signals: textCorpusQuery(corpus).focus({ id: unit.id, pageSize: 1 })!.unit
					.reviewSignals,
				stale: staleRuntimeCopy(unit.occurrences[0]!)?.objectPath
			};
		};
		const now = { ...title, source: "Play now" };
		// Compiled and up to date; only a saved skeleton still holds the old text.
		const skeletonOnly = signals([
			now,
			{ ...compiledTitle, source: "Play now" },
			skeletonTitle
		]);
		expect(skeletonOnly.signals).not.toContain("compiled_copy_differs");
		expect(skeletonOnly.signals).not.toContain("conflicting");
		expect(skeletonOnly.stale).toBeUndefined();
		// Not compiled: the generated class's text is what the game shows, even after a skeleton.
		const runtime = signals([now, skeletonTitle, { ...compiledTitle, source: "Play again" }]);
		expect(runtime.signals).toContain("compiled_copy_differs");
		expect(runtime.stale).toBe(compiledTitle.location.object_path);
	});
});
