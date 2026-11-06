import * as stylex from "@stylexjs/stylex";
import {
	LocalizationEdit,
	type LocalizationEditOutcome,
	type LocalizationEditResult,
	type LocalizationFocus,
	type LocalizationTranslation
} from "@ue-shed/game-text/corpus";
import { textCountLabel } from "@ue-shed/game-text/labels";
import { type LocalizationSelection } from "@ue-shed/game-text/schema";
import { Button, createEffectAction } from "@ue-shed/ui";
import { Effect, Schema } from "effect";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { GameTextClientApi } from "./game-text-client.js";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import type { GameTextEditSession } from "./game-text-preferences.js";
import { styles } from "./game-text-styles.js";

const local = stylex.create({
	panel: {
		display: "flex",
		flexDirection: "column",
		flexShrink: 0,
		minHeight: 0,
		maxHeight: "min(45vh, 360px)",
		overflow: "hidden"
	},
	intro: { margin: 0, flex: 1, minWidth: 0 },
	changes: { flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" },
	actions: { flexShrink: 0 },
	edit: {
		display: "grid",
		gap: 2,
		paddingBlock: 6,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	diff: { margin: 0, fontSize: 13, overflowWrap: "anywhere" },
	before: { color: tokens.colorTextMuted, textDecorationLine: "line-through" }
});

/** A staged edit plus the source text it translates, kept only for display. */
interface StagedEdit {
	readonly target: LocalizationSelection["target"];
	readonly edit: LocalizationEdit;
	readonly source: string;
}

const isStageableTranslation = Schema.is(LocalizationEdit.fields.translation);

const editKey = (edit: Pick<LocalizationEdit, "culture" | "namespace" | "key">) =>
	JSON.stringify([edit.culture, edit.namespace, edit.key]);

const outcomeLabels = {
	ready: "Ready to write",
	unchanged: "Already in the PO file",
	wrong_target: "Belongs to another target",
	culture_unavailable: "This culture's PO file is unavailable",
	not_in_manifest: "Not gathered: gather the target first",
	stale_source: "The source changed since you staged this",
	not_in_po: "Not in the PO file: export PO files first",
	po_out_of_date: "The PO file is older than the source: export PO files first",
	stale_translation: "The translation changed since you staged this"
} satisfies Record<LocalizationEditOutcome["outcome"], string>;

/** States where Unreal can import a translation for the line. */
const editableStates = new Set([
	"translated",
	"not_translated",
	"needs_update",
	"not_synced",
	"gathered_only"
]);

/** The translation that ships next: a pending PO edit, otherwise the imported translation. */
export function seenTranslation(translation: LocalizationTranslation): string | null {
	return translation.poTranslation ?? translation.archiveTranslation ?? null;
}

export function createGameTextEdits(input: {
	readonly client: Pick<GameTextClientApi, "localizationEdits">;
	readonly target: () => LocalizationSelection["target"] | undefined;
	readonly nativeCulture: () => string | undefined;
	readonly busy: () => boolean;
	readonly onWritten: () => void;
	readonly initial?: GameTextEditSession | undefined;
}) {
	const keyed = (item: StagedEdit) => JSON.stringify([item.target, editKey(item.edit)]);
	const fromItems = (items: readonly StagedEdit[]) =>
		new Map(items.map((item) => [keyed(item), item]));
	const [staged, setStaged] = createSignal<ReadonlyMap<string, StagedEdit>>(
		fromItems(input.initial?.staged ?? [])
	);
	const [drafts, setDrafts] = createSignal<ReadonlyMap<string, StagedEdit>>(
		fromItems(input.initial?.drafts ?? [])
	);
	const [undo, setUndo] = createSignal<ReadonlyMap<string, StagedEdit>>();
	const keyFor = (edit: Pick<LocalizationEdit, "culture" | "namespace" | "key">) =>
		JSON.stringify([input.target(), editKey(edit)]);
	const [open, setOpen] = createSignal(false);
	const [reviewTarget, setReviewTarget] = createSignal<LocalizationSelection["target"]>();
	const [review, setReview] = createSignal<LocalizationEditResult | undefined>(undefined);
	const [message, setMessage] = createSignal<string | undefined>(undefined);
	const [working, setWorking] = createSignal(false);
	const action = createEffectAction();
	const edits = createMemo(() =>
		[...staged().values()].filter((item) => item.target === input.target())
	);

	const resetReview = () => {
		setReview(undefined);
		setReviewTarget(undefined);
		setMessage(undefined);
	};
	// Undo restores the last removal in the target it happened in; another target retires it.
	createEffect(input.target, () => setUndo(undefined));
	const stage = (edit: LocalizationEdit, source: string) => {
		if (!isStageableTranslation(edit.translation)) {
			setMessage(
				"This draft is too long to stage. Shorten it to 65,536 characters or fewer. The typed draft is retained."
			);
			return false;
		}
		const next = new Map(staged());
		const target = input.target();
		if (!target) return false;
		next.set(keyFor(edit), { edit, source, target });
		setStaged(next);
		resetReview();
		return true;
	};
	// Many edits at once, such as a selection's carried translations, in one update.
	const stageAll = (
		items: readonly { readonly edit: LocalizationEdit; readonly source: string }[]
	) => {
		const next = new Map(staged());
		const target = input.target();
		if (!target) return;
		for (const item of items) next.set(keyFor(item.edit), { ...item, target });
		setStaged(next);
		resetReview();
	};
	/** Removes one or more staged edits; undo brings back all of them. */
	const unstage = (
		...removing: readonly Pick<LocalizationEdit, "culture" | "namespace" | "key">[]
	) => {
		const next = new Map(staged());
		const removed = new Map<string, StagedEdit>();
		for (const edit of removing) {
			const item = staged().get(keyFor(edit));
			if (item) removed.set(keyFor(edit), item);
			next.delete(keyFor(edit));
		}
		setUndo(removed.size > 0 ? removed : undefined);
		setStaged(next);
		resetReview();
		if (next.size === 0) setOpen(false);
	};
	const editable = (detail: LocalizationFocus, translation: LocalizationTranslation) =>
		input.client.localizationEdits !== undefined &&
		detail.identity !== null &&
		!detail.scopeSummary &&
		translation.culture !== input.nativeCulture() &&
		editableStates.has(translation.state);

	const submit = (mode: "review" | "write") => {
		const target = input.target();
		const request = input.client.localizationEdits;
		if (!target || !request || edits().length === 0 || working()) return;
		const submitted = new Map(edits().map((item) => [keyed(item), item]));
		setWorking(true);
		setReviewTarget(target);
		if (mode === "write") setUndo(undefined);
		setMessage(undefined);
		action.run(
			request({ target, mode, edits: [...submitted.values()].map((item) => item.edit) }),
			{
				onSuccess: (result) => {
					setWorking(false);
					if (result.status === "failed") {
						setReview(undefined);
						setMessage(`${result.message} ${result.recovery}`);
						return;
					}
					if (result.status === "not_ready") {
						setMessage("Translations are still loading. Try again in a moment.");
						return;
					}
					if (
						mode === "review" &&
						JSON.stringify(edits().map((item) => item.edit)) !==
							JSON.stringify([...submitted.values()].map((item) => item.edit))
					) {
						setReview(undefined);
						setMessage("Edits changed while being checked. Check changes again.");
						return;
					}
					setReview(result);
					if (result.status === "written" || result.status === "partially_written") {
						// Edits whose culture's file was replaced are done, including those the
						// file already held; the rest stay staged.
						const landed = result.edits.filter(
							(item) =>
								(item.outcome === "ready" || item.outcome === "unchanged") &&
								result.files.some(
									(file) => file.written && file.culture === item.culture
								)
						);
						const done = new Set(
							landed.map((edit) => JSON.stringify([target, editKey(edit)]))
						);
						const remaining = new Map(
							[...staged()].filter(
								([key, item]) =>
									!done.has(key) ||
									JSON.stringify(item.edit) !==
										JSON.stringify(submitted.get(key)?.edit)
							)
						);
						setStaged(remaining);
						setReview(undefined);
						const changed = landed.filter((item) => item.outcome === "ready").length;
						const files = result.files.filter((file) => file.written).length;
						const wrote = `Wrote ${textCountLabel(changed, "translation")} to ${textCountLabel(files, "PO file")}.`;
						if (result.status === "partially_written") {
							const left = [...remaining.values()].filter(
								(item) => item.target === target
							).length;
							const failedFiles = result.files
								.filter((file) => !file.written)
								.map((file) => file.relativePath);
							setMessage(
								`${wrote} ${textCountLabel(left, "edit")} not written, because ${
									failedFiles.length === 1 ? "this file" : "these files"
								} could not be replaced: ${failedFiles.join(", ")}. Close any program using ${
									failedFiles.length === 1 ? "it" : "them"
								}, then check the changes and write again.`
							);
						} else
							setMessage(`${wrote} They are not synced until you sync with Unreal.`);
						input.onWritten();
					} else if (result.status === "rejected") {
						setMessage("Nothing was written: some staged edits are no longer current.");
					}
				},
				onFailure: () => {
					setWorking(false);
					setMessage("The edits could not be checked. Rescan and try again.");
				}
			}
		);
	};

	const copyFiles = () => {
		const current = review();
		if (current?.status !== "reviewed") return;
		action.run(
			Effect.tryPromise({
				try: () =>
					navigator.clipboard.writeText(
						current.files.map((file) => file.relativePath).join("\n")
					),
				catch: String
			}),
			{
				onSuccess: () => setMessage("File list copied."),
				onFailure: () => setMessage("The file list could not be copied.")
			}
		);
	};

	return {
		staged,
		edits,
		session: () => ({ staged: [...staged().values()], drafts: [...drafts().values()] }),
		restore: (session: GameTextEditSession) => {
			setStaged(fromItems(session.staged));
			setDrafts(fromItems(session.drafts));
		},
		hasDrafts: () => staged().size > 0 || drafts().size > 0,
		/** Drops staged edits and drafts for targets the project no longer has. */
		prune: (targets: readonly LocalizationSelection["target"][]) => {
			const known = new Set(targets);
			const keep = (items: ReadonlyMap<string, StagedEdit>) =>
				[...items.values()].every((item) => known.has(item.target))
					? items
					: new Map([...items].filter(([, item]) => known.has(item.target)));
			setStaged(keep);
			setDrafts(keep);
		},
		undoAvailable: () => undo() !== undefined,
		undo: () => {
			const previous = undo();
			if (previous) setStaged(new Map([...previous, ...staged()]));
			setUndo(undefined);
			resetReview();
		},
		draftFor: (edit: Pick<LocalizationEdit, "culture" | "namespace" | "key">) =>
			drafts().get(keyFor(edit)),
		setDraft: (edit: LocalizationEdit, source: string) => {
			const target = input.target();
			if (target)
				setDrafts((current) =>
					new Map(current).set(keyFor(edit), { target, edit, source })
				);
		},
		clearDraft: (edit: Pick<LocalizationEdit, "culture" | "namespace" | "key">) =>
			setDrafts((current) => {
				const next = new Map(current);
				next.delete(keyFor(edit));
				return next;
			}),
		open,
		setOpen,
		review: () => (input.target() === reviewTarget() ? review() : undefined),
		message,
		working,
		busy: () => input.busy() || working(),
		stage,
		stageAll,
		unstage,
		editable,
		discard: () => {
			setUndo(new Map([...staged()].filter(([, item]) => item.target === input.target())));
			setStaged(new Map([...staged()].filter(([, item]) => item.target !== input.target())));
			resetReview();
			setOpen(false);
		},
		check: () => submit("review"),
		write: () => submit("write"),
		copyFiles,
		stagedFor: (
			culture: LocalizationEdit["culture"],
			identity: LocalizationFocus["identity"]
		) =>
			identity === null
				? undefined
				: staged().get(
						keyFor({ culture, namespace: identity.namespace, key: identity.key })
					)
	};
}
export type GameTextEdits = ReturnType<typeof createGameTextEdits>;

/** "N staged" toolbar entry; hidden while nothing is staged. */
export function StagedEditsButton(props: { readonly model: GameTextEdits }) {
	return (
		<Show when={props.model.edits().length > 0}>
			<Button
				size="compact"
				tone="quiet"
				aria-expanded={props.model.open() ? "true" : "false"}
				onClick={() => props.model.setOpen(!props.model.open())}
			>
				{props.model.edits().length} staged
			</Button>
		</Show>
	);
}

/** Inline review of staged edits: check, see the PO files to check out, write, or discard. */
export function StagedEditsPanel(props: { readonly model: GameTextEdits }) {
	const outcome = (item: StagedEdit) => {
		const current = props.model.review();
		if (!current || current.status === "not_ready" || current.status === "failed")
			return undefined;
		return current.edits.find((result) => editKey(result) === editKey(item.edit));
	};
	const reviewed = () => {
		const current = props.model.review();
		return current?.status === "reviewed" ? current : undefined;
	};
	const canWrite = () =>
		reviewed()?.edits.every(
			(item) => item.outcome === "ready" || item.outcome === "unchanged"
		) === true && (reviewed()?.files.length ?? 0) > 0;
	// Staged edits the last check found unwritable, so they can leave together.
	const blocked = () =>
		props.model.edits().filter((item) => {
			const result = outcome(item)?.outcome;
			return result !== undefined && result !== "ready" && result !== "unchanged";
		});
	const writeReason = () =>
		canWrite()
			? undefined
			: blocked().length > 0
				? `${textCountLabel(blocked().length, "edit")} can't be written. Unstage ${
						blocked().length === 1 ? "it" : "them"
					}, then check again.`
				: "Check the changes first.";
	return (
		<>
			<Show when={props.model.open() && props.model.edits().length > 0}>
				<section
					aria-label="Staged translations"
					{...stylex.attrs(styles.card, local.panel)}
				>
					<div {...stylex.attrs(styles.bar, local.actions)}>
						<p {...stylex.attrs(local.intro)}>
							{props.model.edits().length} staged{" "}
							{props.model.edits().length === 1 ? "translation" : "translations"}.
							Writing changes only the PO files; Unreal imports them when you sync.
						</p>
						<Button
							size="compact"
							tone="quiet"
							onClick={() => props.model.setOpen(false)}
						>
							Close staged translations
						</Button>
					</div>
					<div
						role="region"
						aria-label="Staged translation changes"
						tabindex={0}
						{...stylex.attrs(local.changes)}
					>
						<For each={props.model.edits()}>
							{(item) => (
								<div {...stylex.attrs(local.edit)}>
									<div {...stylex.attrs(styles.bar)}>
										<strong>{item.edit.culture}</strong>
										<code>
											{item.target} · {item.edit.namespace}:{item.edit.key}
										</code>
										<span {...stylex.attrs(styles.muted)}>{item.source}</span>
										<Show when={outcome(item)}>
											{(result) => (
												<span
													{...stylex.attrs(
														styles.muted,
														result().outcome !== "ready" &&
															result().outcome !== "unchanged" &&
															styles.warning
													)}
												>
													{outcomeLabels[result().outcome]}
												</span>
											)}
										</Show>
										<Button
											size="compact"
											tone="quiet"
											disabled={props.model.busy()}
											onClick={() => props.model.unstage(item.edit)}
										>
											Unstage
										</Button>
									</div>
									<p {...stylex.attrs(local.diff)}>
										<span {...stylex.attrs(local.before)}>
											{item.edit.seenTranslation ?? "No translation"}
										</span>
										<span aria-hidden="true" {...stylex.attrs(styles.muted)}>
											{" → "}
										</span>
										<span>{item.edit.translation}</span>
									</p>
								</div>
							)}
						</For>
						<Show when={reviewed()?.files.length}>
							<span {...stylex.attrs(styles.muted)}>PO files to write</span>
							<For each={reviewed()?.files ?? []}>
								{(file) => (
									<code {...stylex.attrs(styles.mono)}>{file.relativePath}</code>
								)}
							</For>
							<span {...stylex.attrs(styles.muted)}>
								Check these files out in your source control first; UE Shed does not
								touch source control.
							</span>
						</Show>
					</div>
					<div {...stylex.attrs(styles.bar, local.actions)}>
						<Button
							size="compact"
							disabled={props.model.busy()}
							onClick={() => props.model.check()}
						>
							Check changes
						</Button>
						<Show when={reviewed()?.files.length}>
							<Button
								size="compact"
								tone="quiet"
								onClick={() => props.model.copyFiles()}
							>
								Copy file list
							</Button>
						</Show>
						<Button
							size="compact"
							tone="primary"
							disabled={props.model.busy() || !canWrite()}
							title={writeReason()}
							onClick={() => props.model.write()}
						>
							Write to PO
						</Button>
						<Show when={blocked().length > 0}>
							<Button
								size="compact"
								tone="quiet"
								disabled={props.model.busy()}
								onClick={() =>
									props.model.unstage(...blocked().map((item) => item.edit))
								}
							>
								Unstage {textCountLabel(blocked().length, "blocked edit")}
							</Button>
						</Show>
						<Button
							size="compact"
							tone="quiet"
							disabled={props.model.busy()}
							onClick={() => props.model.discard()}
						>
							Discard all
						</Button>
					</div>
				</section>
			</Show>
			<Show when={props.model.undoAvailable()}>
				<Button size="compact" onClick={props.model.undo}>
					Undo unstage / discard
				</Button>
			</Show>
			<Show when={props.model.message()}>
				<p role="status" {...stylex.attrs(styles.muted)}>
					{props.model.message()}
				</p>
			</Show>
		</>
	);
}

/** Inline editor inside one culture's translation card. */
export function TranslationEditor(props: {
	readonly model: GameTextEdits;
	readonly detail: LocalizationFocus;
	readonly translation: LocalizationTranslation;
}) {
	const identity = () => props.detail.identity;
	const draftItem = () => {
		const key = identity();
		return key
			? props.model.draftFor({ ...key, culture: props.translation.culture })
			: undefined;
	};
	const editing = () => draftItem() !== undefined;
	const draft = () => draftItem()?.edit.translation ?? "";
	const staged = () => props.model.stagedFor(props.translation.culture, props.detail.identity);
	const current = () => seenTranslation(props.translation);
	// The field grows with the draft up to a dozen lines, then scrolls.
	const draftRows = () => Math.min(12, Math.max(3, draft().split("\n").length + 1));
	// Only an Edit click moves focus into the field; a recovered draft leaves focus alone.
	let focusOnOpen = false;
	const begin = () => {
		const key = identity();
		focusOnOpen = true;
		if (key)
			props.model.setDraft(
				{
					...key,
					culture: props.translation.culture,
					seenTranslation: current(),
					translation: staged()?.edit.translation ?? current() ?? ""
				},
				props.detail.source
			);
	};
	const updateDraft = (translation: string) => {
		const item = draftItem();
		if (item) props.model.setDraft({ ...item.edit, translation }, item.source);
	};
	// Leaving the editor from inside it returns focus to its Edit button, not the page.
	let field: HTMLTextAreaElement | undefined;
	let focusOnClose = false;
	const cancel = () => {
		const item = draftItem();
		const container = field?.parentElement;
		focusOnClose = !!container?.contains(document.activeElement);
		if (item) props.model.clearDraft(item.edit);
	};
	const stage = () => {
		const item = draftItem();
		if (!item || item.edit.translation === item.edit.seenTranslation) return;
		if (props.model.stage(item.edit, item.source)) cancel();
	};
	return (
		<Show when={props.model.editable(props.detail, props.translation)}>
			<Show
				when={editing()}
				fallback={
					<div {...stylex.attrs(styles.bar)}>
						<Show when={staged()}>
							{(item) => (
								<span {...stylex.attrs(styles.muted)}>
									Staged: {item().edit.translation}
								</span>
							)}
						</Show>
						<Button
							ref={(element: HTMLButtonElement) => {
								if (focusOnClose) queueMicrotask(() => element.focus());
								focusOnClose = false;
							}}
							size="compact"
							tone="quiet"
							disabled={props.model.busy()}
							onClick={begin}
						>
							{staged() ? "Edit staged" : "Edit"}
						</Button>
						<Show when={staged()}>
							{(item) => (
								<Button
									size="compact"
									tone="quiet"
									disabled={props.model.busy()}
									onClick={() => props.model.unstage(item().edit)}
								>
									Unstage
								</Button>
							)}
						</Show>
					</div>
				}
			>
				<textarea
					ref={(element) => {
						field = element;
						if (focusOnOpen) queueMicrotask(() => element.focus());
						focusOnOpen = false;
					}}
					dir="auto"
					lang={props.translation.culture}
					aria-label={"New " + props.translation.culture + " translation"}
					aria-keyshortcuts="Control+Enter Meta+Enter Escape"
					title="Ctrl Enter stages the draft; Escape cancels it."
					value={draft()}
					onInput={(event) => updateDraft(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.isComposing) return;
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							cancel();
						} else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
							event.preventDefault();
							stage();
						}
					}}
					rows={draftRows()}
					{...stylex.attrs(styles.textarea)}
				/>
				<div {...stylex.attrs(styles.bar)}>
					<Button
						size="compact"
						disabled={draft() === current() || props.model.busy()}
						onClick={stage}
					>
						Stage
					</Button>
					<Button size="compact" tone="quiet" onClick={cancel}>
						Cancel
					</Button>
				</div>
			</Show>
		</Show>
	);
}
