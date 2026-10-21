// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { LocalizationEdit, type LocalizationEditResult } from "@ue-shed/game-text/corpus";
import { LocalizationSelection } from "@ue-shed/game-text/schema";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { createSignal } from "solid-js";
import { afterAll, afterEach, expect, it } from "vitest";
import {
	createGameTextEdits,
	StagedEditsButton,
	StagedEditsPanel
} from "./game-text-translation-edits.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());
afterEach(cleanup);

it("keeps 45 drafts available after closing the scrollable review", async () => {
	function Review() {
		const model = createGameTextEdits({
			client: {},
			target: () => LocalizationSelection.fields.target.make("Game"),
			nativeCulture: () => "en",
			busy: () => false,
			onWritten: () => {
				throw new Error("This test never writes translations");
			}
		});
		const stage = () => {
			model.stageAll(
				Array.from({ length: 45 }, (_, index) => ({
					edit: Schema.decodeUnknownSync(LocalizationEdit)({
						culture: "fr",
						namespace: "UI",
						key: `Line${index}`,
						seenTranslation: null,
						translation: `Translation ${index}`
					}),
					source: `Source ${index}`
				}))
			);
			model.setOpen(true);
		};
		return (
			<>
				<button onClick={stage}>Stage 45 drafts</button>
				<StagedEditsButton model={model} />
				<StagedEditsPanel model={model} />
			</>
		);
	}
	// The panel only needs the edit methods; no scan or filesystem capability is invoked.
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<Review />
		</EffectRuntimeProvider>
	));
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "Stage 45 drafts" }));
	const panel = screen.getByRole("region", { name: "Staged translations" });
	const changes = within(panel).getByRole("region", { name: "Staged translation changes" });
	expect(changes.getAttribute("tabindex")).toBe("0");
	expect(within(changes).getAllByRole("button", { name: "Unstage" })).toHaveLength(45);
	expect(within(panel).getByRole("button", { name: "Write to PO" })).toHaveProperty(
		"disabled",
		true
	);
	await user.click(within(panel).getByRole("button", { name: "Close staged translations" }));
	expect(screen.queryByRole("region", { name: "Staged translations" })).toBeNull();
	await user.click(screen.getByRole("button", { name: "45 staged" }));
	expect(screen.getAllByRole("button", { name: "Unstage" })).toHaveLength(45);
	expect(screen.getByText("Translation 44")).toBeDefined();
});

it("retains unwritten PO edits after a partial write and requires a new check", async () => {
	const target = LocalizationSelection.fields.target.make("Game");
	const items = ["de", "fr"].map((culture) => ({
		target,
		source: "Source",
		edit: Schema.decodeUnknownSync(LocalizationEdit)({
			culture,
			namespace: "UI",
			key: "K",
			seenTranslation: "Before",
			translation: "After"
		})
	}));
	function PartialWrite() {
		const model = createGameTextEdits({
			target: () => target,
			nativeCulture: () => "en",
			busy: () => false,
			onWritten: () => undefined,
			initial: { staged: items, drafts: [] },
			client: {
				localizationEdits: (request) =>
					Effect.succeed({
						status: request.mode === "review" ? "reviewed" : "partially_written",
						edits: request.edits.map((edit) => ({
							culture: edit.culture,
							namespace: edit.namespace,
							key: edit.key,
							outcome: "ready",
							currentTranslation: edit.seenTranslation,
							translation: edit.translation
						})),
						files: request.edits.map((edit) => ({
							culture: edit.culture,
							relativePath: `Localization/${edit.culture}/Game.po`,
							changes: 1,
							written: request.mode === "write" && edit.culture === "de"
						})),
						notSynced: 2
					})
			}
		});
		return (
			<>
				<StagedEditsButton model={model} />
				<StagedEditsPanel model={model} />
			</>
		);
	}
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<PartialWrite />
		</EffectRuntimeProvider>
	));
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "2 staged" }));
	await user.click(screen.getByRole("button", { name: "Check changes" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Write to PO" })).toHaveProperty(
			"disabled",
			false
		)
	);
	await user.click(screen.getByRole("button", { name: "Write to PO" }));
	await screen.findByText(
		/^Wrote 1 translation to 1 PO file\. 1 edit not written, because this file could not be replaced: Localization\/fr\/Game\.po\./u
	);
	expect(screen.getByRole("button", { name: "1 staged" })).toBeDefined();
	expect(screen.queryByText("Ready to write")).toBeNull();
	expect(screen.getByRole("button", { name: "Write to PO" })).toHaveProperty("disabled", true);
});

it("keeps staging separate by target and offers undo after unstage and discard", async () => {
	const first = LocalizationSelection.fields.target.make("Game");
	const second = LocalizationSelection.fields.target.make("Other");
	const edit = Schema.decodeUnknownSync(LocalizationEdit)({
		culture: "fr",
		namespace: "UI",
		key: "K",
		seenTranslation: null,
		translation: "First"
	});
	function Targets() {
		const [target, setTarget] = createSignal(first);
		const model = createGameTextEdits({
			client: {},
			target,
			nativeCulture: () => "en",
			busy: () => false,
			onWritten: () => undefined,
			initial: { staged: [{ target: first, edit, source: "Source" }], drafts: [] }
		});
		return (
			<>
				<button onClick={() => setTarget(second)}>Other target</button>
				<button onClick={() => setTarget(first)}>Game target</button>
				<button
					onClick={() => model.stage({ ...edit, translation: "Second" }, "Other source")}
				>
					Stage other
				</button>
				<StagedEditsButton model={model} />
				<StagedEditsPanel model={model} />
			</>
		);
	}
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<Targets />
		</EffectRuntimeProvider>
	));
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "1 staged" }));
	await user.click(screen.getByRole("button", { name: "Unstage" }));
	await user.click(screen.getByRole("button", { name: "Undo unstage / discard" }));
	await user.click(screen.getByRole("button", { name: "Other target" }));
	expect(screen.queryByRole("button", { name: "1 staged" })).toBeNull();
	await user.click(screen.getByRole("button", { name: "Stage other" }));
	await user.click(screen.getByRole("button", { name: "Game target" }));
	await user.click(screen.getByRole("button", { name: "1 staged" }));
	expect(screen.getByText("First")).toBeDefined();
	expect(screen.queryByText("Second")).toBeNull();
	await user.click(screen.getByRole("button", { name: "Discard all" }));
	await user.click(screen.getByRole("button", { name: "Undo unstage / discard" }));
	await user.click(screen.getByRole("button", { name: "1 staged" }));
	expect(screen.getByText("First")).toBeDefined();
});

it("does not remove a newer staged draft when an earlier write finishes", async () => {
	const pending = await Effect.runPromise(Deferred.make<LocalizationEditResult>());
	const target = LocalizationSelection.fields.target.make("Game");
	const edit = Schema.decodeUnknownSync(LocalizationEdit)({
		culture: "fr",
		namespace: "UI",
		key: "K",
		seenTranslation: "Before",
		translation: "Submitted"
	});
	function InFlight() {
		const model = createGameTextEdits({
			client: { localizationEdits: () => Deferred.await(pending) },
			target: () => target,
			nativeCulture: () => "en",
			busy: () => false,
			onWritten: () => undefined,
			initial: { staged: [{ target, edit, source: "Source" }], drafts: [] }
		});
		return (
			<>
				<button onClick={model.write}>Start write</button>
				<button
					onClick={() => model.stage({ ...edit, translation: "Newer draft" }, "Source")}
				>
					Replace draft
				</button>
				<StagedEditsButton model={model} />
				<StagedEditsPanel model={model} />
			</>
		);
	}
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<InFlight />
		</EffectRuntimeProvider>
	));
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "Start write" }));
	await user.click(screen.getByRole("button", { name: "Replace draft" }));
	await Effect.runPromise(
		Deferred.succeed(pending, {
			status: "written",
			edits: [
				{
					culture: edit.culture,
					namespace: edit.namespace,
					key: edit.key,
					outcome: "ready",
					currentTranslation: "Before",
					translation: "Submitted"
				}
			],
			files: [
				{
					culture: edit.culture,
					relativePath: "Localization/fr/Game.po",
					changes: 1,
					written: true
				}
			],
			notSynced: 1
		})
	);
	await screen.findByText(/Wrote 1 translation/u);
	await user.click(screen.getByRole("button", { name: "1 staged" }));
	expect(screen.getByText("Newer draft")).toBeDefined();
});

it("retains an oversized typed draft and refuses to stage it as a PO edit", async () => {
	const target = LocalizationSelection.fields.target.make("Game");
	const edit = LocalizationEdit.make({
		culture: LocalizationEdit.fields.culture.make("fr"),
		namespace: LocalizationEdit.fields.namespace.make("UI"),
		key: LocalizationEdit.fields.key.make("Long"),
		seenTranslation: null,
		translation: "Initial"
	});
	const draft = { ...edit, translation: "x".repeat(65_537) };
	function LongDraft() {
		const model = createGameTextEdits({
			client: {},
			target: () => target,
			nativeCulture: () => "en",
			busy: () => false,
			onWritten: () => undefined,
			initial: { staged: [], drafts: [{ target, edit: draft, source: "Source" }] }
		});
		return (
			<>
				<button onClick={() => model.stage(draft, "Source")}>Stage long draft</button>
				<span>Draft length {model.draftFor(edit)?.edit.translation.length}</span>
				<StagedEditsButton model={model} />
				<StagedEditsPanel model={model} />
			</>
		);
	}
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<LongDraft />
		</EffectRuntimeProvider>
	));
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "Stage long draft" }));
	await screen.findByText(/too long to stage/u);
	expect(screen.getByText("Draft length 65537")).toBeDefined();
	expect(screen.queryByRole("button", { name: "1 staged" })).toBeNull();
});

it("keeps stale edits staged and explains why nothing was written", async () => {
	const target = LocalizationSelection.fields.target.make("Game");
	const edit = LocalizationEdit.make({
		culture: LocalizationEdit.fields.culture.make("fr"),
		namespace: LocalizationEdit.fields.namespace.make("UI"),
		key: LocalizationEdit.fields.key.make("K"),
		seenTranslation: "Before",
		translation: "After"
	});
	function StaleEdit() {
		const model = createGameTextEdits({
			target: () => target,
			nativeCulture: () => "en",
			busy: () => false,
			onWritten: () => {
				throw new Error("Stale edits must not be written");
			},
			initial: { staged: [{ target, edit, source: "Source" }], drafts: [] },
			client: {
				localizationEdits: (request) =>
					Effect.succeed({
						status: "reviewed",
						edits: request.edits.map((item) => ({
							culture: item.culture,
							namespace: item.namespace,
							key: item.key,
							outcome: "stale_translation",
							currentTranslation: "Changed elsewhere",
							translation: item.translation
						})),
						files: [],
						notSynced: 1
					})
			}
		});
		return (
			<>
				<StagedEditsButton model={model} />
				<StagedEditsPanel model={model} />
			</>
		);
	}
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<StaleEdit />
		</EffectRuntimeProvider>
	));
	const user = userEvent.setup({ delay: null });
	await user.click(screen.getByRole("button", { name: "1 staged" }));
	const panel = screen.getByRole("region", { name: "Staged translations" });
	await user.click(within(panel).getByRole("button", { name: "Check changes" }));
	await within(panel).findByText("The translation changed since you staged this");
	expect(within(panel).getByRole("button", { name: "Write to PO" })).toHaveProperty(
		"disabled",
		true
	);
	expect(within(panel).getByText("After")).toBeDefined();
	await user.click(within(panel).getByRole("button", { name: "Unstage" }));
	expect(screen.queryByRole("region", { name: "Staged translations" })).toBeNull();
});
