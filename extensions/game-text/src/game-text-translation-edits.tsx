import * as stylex from "@stylexjs/stylex";
import {
	type LocalizationEdit,
	type LocalizationEditOutcome,
	type LocalizationEditResult,
	type LocalizationFocus,
	type LocalizationSelection,
	type LocalizationTranslation
} from "@ue-shed/game-text/browser";
import { Button, createEffectAction } from "@ue-shed/ui";
import { Effect } from "effect";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { GameTextClientApi } from "./game-text-client.js";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { styles } from "./game-text-styles.js";

const local = stylex.create({
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
	readonly edit: LocalizationEdit;
	readonly source: string;
}

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
	readonly client: GameTextClientApi;
	readonly target: () => LocalizationSelection["target"] | undefined;
	readonly nativeCulture: () => string | undefined;
	readonly busy: () => boolean;
	readonly onWritten: () => void;
}) {
	const [staged, setStaged] = createSignal<ReadonlyMap<string, StagedEdit>>(new Map());
	const [open, setOpen] = createSignal(false);
	const [review, setReview] = createSignal<LocalizationEditResult | undefined>(undefined);
	const [message, setMessage] = createSignal<string | undefined>(undefined);
	const [working, setWorking] = createSignal(false);
	const action = createEffectAction();
	const edits = createMemo(() => [...staged().values()]);

	const resetReview = () => {
		setReview(undefined);
		setMessage(undefined);
	};
	const stage = (edit: LocalizationEdit, source: string) => {
		const next = new Map(staged());
		next.set(editKey(edit), { edit, source });
		setStaged(next);
		resetReview();
	};
	const unstage = (edit: Pick<LocalizationEdit, "culture" | "namespace" | "key">) => {
		const next = new Map(staged());
		next.delete(editKey(edit));
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
		setWorking(true);
		setMessage(undefined);
		action.run(request({ target, mode, edits: edits().map((item) => item.edit) }), {
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
				setReview(result);
				if (result.status === "written" || result.status === "partially_written") {
					const written = new Set(
						result.edits
							.filter((item) =>
								result.files.some(
									(file) => file.written && file.culture === item.culture
								)
							)
							.filter(
								(item) => item.outcome === "ready" || item.outcome === "unchanged"
							)
							.map(editKey)
					);
					const remaining = new Map([...staged()].filter(([key]) => !written.has(key)));
					setStaged(remaining);
					const changed = written.size;
					const files = result.files.filter((file) => file.written).length;
					setMessage(
						`Wrote ${changed} ${changed === 1 ? "translation" : "translations"} to ${files} PO ${
							files === 1 ? "file" : "files"
						}. They are not synced until you sync with Unreal.`
					);
					if (remaining.size === 0) setReview(undefined);
					input.onWritten();
				} else if (result.status === "rejected") {
					setMessage("Nothing was written: some staged edits are no longer current.");
				}
			},
			onFailure: () => {
				setWorking(false);
				setMessage("The edits could not be checked. Rescan and try again.");
			}
		});
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
		open,
		setOpen,
		review,
		message,
		working,
		busy: () => input.busy() || working(),
		stage,
		unstage,
		editable,
		discard: () => {
			setStaged(new Map());
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
						editKey({ culture, namespace: identity.namespace, key: identity.key })
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
	return (
		<>
			<Show when={props.model.open() && props.model.edits().length > 0}>
				<section aria-label="Staged translations" {...stylex.attrs(styles.card)}>
					<p>
						{props.model.edits().length} staged{" "}
						{props.model.edits().length === 1 ? "translation" : "translations"}. Writing
						changes only the PO files; Unreal imports them when you sync.
					</p>
					<For each={props.model.edits()}>
						{(item) => (
							<div {...stylex.attrs(local.edit)}>
								<div {...stylex.attrs(styles.bar)}>
									<strong>{item.edit.culture}</strong>
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
					<div {...stylex.attrs(styles.bar)}>
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
							title={canWrite() ? undefined : "Check the changes first."}
							onClick={() => props.model.write()}
						>
							Write to PO
						</Button>
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
	const [editing, setEditing] = createSignal(false);
	const staged = () => props.model.stagedFor(props.translation.culture, props.detail.identity);
	const current = () => seenTranslation(props.translation);
	const [draft, setDraft] = createSignal("");
	const begin = () => {
		setDraft(staged()?.edit.translation ?? current() ?? "");
		setEditing(true);
	};
	const stage = () => {
		const identity = props.detail.identity;
		if (identity === null || draft() === current()) return;
		props.model.stage(
			{
				culture: props.translation.culture,
				namespace: identity.namespace,
				key: identity.key,
				seenTranslation: current(),
				translation: draft()
			},
			props.detail.source
		);
		setEditing(false);
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
					aria-label={"New " + props.translation.culture + " translation"}
					value={draft()}
					onInput={(event) => setDraft(event.currentTarget.value)}
					rows={3}
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
					<Button size="compact" tone="quiet" onClick={() => setEditing(false)}>
						Cancel
					</Button>
				</div>
			</Show>
		</Show>
	);
}
