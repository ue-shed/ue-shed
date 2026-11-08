import * as stylex from "@stylexjs/stylex";
import { MAX_LOCALIZATION_EDITS, type LocalizationReviewChange } from "@ue-shed/game-text/corpus";
import { textCountLabel } from "@ue-shed/game-text/labels";
import {
	type LocalizationLineId,
	type LocalizationLinePreview,
	type LocalizationSelection
} from "@ue-shed/game-text/schema";
import { Button, createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Effect } from "effect";
import { Show, createEffect, createMemo, createSignal, untrack } from "solid-js";
import {
	MAX_SELECTED_LINES,
	REVIEW_BATCH,
	batches,
	carryEdits,
	exportRequest,
	keysText,
	lineRange,
	reviewChanges
} from "./game-text-bulk.js";
import type { GameTextClientApi } from "./game-text-client.js";
import type { GameTextEdits } from "./game-text-translation-edits.js";

/**
 * The lines ticked for bulk actions, kept while filters and grouping change so a selection can
 * be built up across several views. A shift-click ticks or unticks every line from the last one
 * ticked, in the list's current order.
 */
export function createLineSelection(input: {
	readonly order: () => readonly LocalizationLinePreview[];
}) {
	const [ticked, setTicked] = createSignal<
		ReadonlyMap<LocalizationLineId, LocalizationLinePreview>
	>(new Map());
	// Why the last tick did less than asked: the selection was full, or a range's start is not
	// among the loaded lines.
	const [note, setNote] = createSignal<string>();
	let anchor: LocalizationLineId | undefined;
	const toggle = (line: LocalizationLinePreview, range: boolean) => {
		const on = !ticked().has(line.id);
		const order = input.order();
		const span = range ? lineRange(order, anchor, line.id) : [line];
		const next = new Map(ticked());
		let skipped = 0;
		for (const item of span.length === 0 ? [line] : span) {
			if (!on) next.delete(item.id);
			else if (next.size < MAX_SELECTED_LINES || next.has(item.id)) next.set(item.id, item);
			else skipped++;
		}
		const unloaded =
			range &&
			anchor !== undefined &&
			anchor !== line.id &&
			!order.some((item) => item.id === anchor);
		setNote(
			skipped > 0
				? `${skipped.toLocaleString()} not ticked: a selection holds at most ${MAX_SELECTED_LINES.toLocaleString()} lines.`
				: unloaded
					? "Shift-click ticks a range only between lines shown in open groups."
					: undefined
		);
		anchor = line.id;
		setTicked(next);
	};
	const clear = () => {
		anchor = undefined;
		setNote(undefined);
		setTicked(new Map());
	};
	// Each ticked line as the list last loaded it, so a reload after a write shows its new state.
	const current = createMemo(() => {
		const fresh = new Map(input.order().map((line) => [line.id, line]));
		return new Map([...ticked()].map(([id, line]) => [id, fresh.get(id) ?? line] as const));
	});
	return {
		ticked: current,
		note,
		isTicked: (id: LocalizationLineId) => ticked().has(id),
		toggle,
		clear
	};
}
export type LineSelection = ReturnType<typeof createLineSelection>;

/**
 * What can be done to every ticked line at once: export them for translators, mark their
 * translations reviewed, carry the earlier keys' translations to changed keys, or copy their keys.
 * Exports and reviews cover the picked cultures, or every culture when none is picked.
 */
export function BulkBar(props: {
	readonly selection: LineSelection;
	readonly client: Pick<
		GameTextClientApi,
		"localizationLinesFile" | "localizationReview" | "localizationEdits"
	>;
	readonly localization: LocalizationSelection | undefined;
	readonly cultures: readonly string[];
	readonly nativeCulture: string | undefined;
	readonly edits: GameTextEdits;
	readonly busy: boolean;
	/** The project's state changed, such as review flags; the list reloads. */
	readonly onChanged: () => void;
}) {
	const action = createEffectAction();
	const [confirming, setConfirming] = createSignal(false);
	const [working, setWorking] = createSignal(false);
	// The last action's result; a failure is announced as an alert.
	const [message, setMessage] = createSignal<
		{ readonly text: string; readonly failed: boolean } | undefined
	>(undefined);
	const lines = createMemo(() => [...props.selection.ticked().values()]);
	// A result describes the lines it ran on, so changing the selection retires it.
	createEffect(
		() => props.selection.ticked(),
		() => {
			if (!untrack(working)) setMessage(undefined);
		}
	);
	// Reviews written from this bar, so a ticked line in a closed group, which the list has not
	// reloaded, does not offer them again.
	const [written, setWritten] = createSignal<ReadonlySet<string>>(new Set());
	const reviewContext = createMemo(() => JSON.stringify([props.localization?.target, lines()]));
	createEffect(reviewContext, () => {
		setWritten(new Set<string>());
	});
	const reviewKey = (change: LocalizationReviewChange) =>
		change.kind === "set" ? [change.culture, change.namespace, change.key].join("\u0000") : "";
	const reviews = createMemo(() =>
		reviewChanges(lines(), props.cultures, props.nativeCulture).filter(
			(change) => !written().has(reviewKey(change))
		)
	);
	// Carries not staged yet: the count on the button is what a click stages.
	const carries = createMemo(() =>
		carryEdits(lines()).filter(
			({ edit }) =>
				props.edits.stagedFor(edit.culture, {
					namespace: edit.namespace,
					key: edit.key
				}) === undefined
		)
	);
	const count = () => lines().length;
	const run = <A, E>(
		effect: Effect.Effect<A, E>,
		done: (value: A) => { readonly text: string; readonly failed: boolean } | undefined,
		failed: string
	) => {
		if (working()) return;
		setWorking(true);
		setMessage(undefined);
		action.run(effect, {
			onSuccess: (value) => {
				setWorking(false);
				setMessage(done(value));
			},
			onFailure: () => {
				setWorking(false);
				setMessage({ text: failed, failed: true });
			}
		});
	};
	const ok = (text: string) => ({ text, failed: false });
	const notOk = (text: string) => ({ text, failed: true });
	const exportLines = () => {
		const request = props.client.localizationLinesFile;
		const localization = props.localization;
		if (!request || !localization || count() === 0) return;
		run(
			request(exportRequest(localization, lines())),
			(result) =>
				result.status === "saved"
					? ok(`Exported ${textCountLabel(result.rowCount, "line")}.`)
					: result.status === "failed"
						? notOk(`${result.message} ${result.recovery}`)
						: result.status === "not_ready"
							? notOk("Translations are still loading. Try again in a moment.")
							: undefined,
			"The lines could not be exported. Try again."
		);
	};
	const markReviewed = () => {
		const request = props.client.localizationReview;
		const target = props.localization?.target;
		const changes = reviews();
		const context = reviewContext();
		if (!request || target === undefined || changes.length === 0) return;
		setConfirming(false);
		// One request per batch, in order; the first failure stops the rest.
		const write = Effect.gen(function* () {
			let marked = 0;
			for (const batch of batches(changes, REVIEW_BATCH)) {
				yield* Effect.sync(() =>
					setMessage(
						ok(
							`Marking reviewed: ${marked.toLocaleString()} of ${changes.length.toLocaleString()}`
						)
					)
				);
				const result = yield* request({ target, changes: batch });
				if (result.status !== "written") return { marked, result };
				marked += batch.length;
				if (context === reviewContext())
					setWritten((done) => new Set([...done, ...batch.map(reviewKey)]));
			}
			return { marked, result: undefined };
		});
		run(
			write,
			({ marked, result }) => {
				if (marked > 0) props.onChanged();
				const done = `Marked ${textCountLabel(marked, "translation")} reviewed.`;
				return result?.status === "failed"
					? notOk(`${marked > 0 ? done + " " : ""}${result.message} ${result.recovery}`)
					: result?.status === "not_ready"
						? notOk(
								`${marked > 0 ? done + " " : ""}Translations are still loading. Try the rest in a moment.`
							)
						: ok(done);
			},
			"Review state could not be saved. Rescan and try again."
		);
	};
	// Staged edits are written in one request, so carrying stops at its limit.
	const carry = () => {
		const fresh = carries();
		const room = Math.max(0, MAX_LOCALIZATION_EDITS - props.edits.edits().length);
		const staged = fresh.slice(0, room);
		if (staged.length > 0) {
			props.edits.stageAll(staged);
			props.edits.setOpen(true);
		}
		setMessage(
			ok(
				`Staged ${textCountLabel(staged.length, "translation")} to carry.` +
					(staged.length < fresh.length
						? ` ${textCountLabel(fresh.length - staged.length, "translation")} left: write the staged edits first, since at most ${MAX_LOCALIZATION_EDITS} are staged at once.`
						: "")
			)
		);
	};
	const copyKeys = () => {
		const keyed = lines().filter((line) => line.identity !== null);
		run(
			Effect.tryPromise({
				try: () => navigator.clipboard.writeText(keysText(keyed)),
				catch: String
			}),
			() =>
				ok(
					`Copied ${textCountLabel(keyed.length, "key")}` +
						(keyed.length < count()
							? ` (${textCountLabel(count() - keyed.length, "line")} without a key).`
							: ".")
				),
			"The keys could not be copied."
		);
	};
	const clear = () => {
		setMessage(undefined);
		setWritten(new Set<string>());
		props.selection.clear();
	};
	return (
		<Show when={count() > 0}>
			<div role="toolbar" aria-label="Selected lines" {...stylex.attrs(styles.bar)}>
				<Show when={confirming()}>
					<span>
						Mark {textCountLabel(reviews().length, "current translation")} reviewed in
						the project's review file?
					</span>
					<Button
						size="compact"
						disabled={working() || props.busy}
						onClick={markReviewed}
					>
						Confirm review
					</Button>
					<Button size="compact" onClick={() => setConfirming(false)}>
						Cancel
					</Button>
				</Show>
				<span {...stylex.attrs(styles.count)}>{count().toLocaleString()} selected</span>
				<Show when={props.client.localizationLinesFile && props.localization}>
					<Button
						size="compact"
						tone="quiet"
						disabled={working() || props.busy}
						onClick={exportLines}
					>
						Export for translators
					</Button>
				</Show>
				<Show when={props.client.localizationReview && reviews().length > 0}>
					<Button
						size="compact"
						tone="quiet"
						disabled={working() || props.busy}
						onClick={() => setConfirming(true)}
					>
						Mark reviewed ({reviews().length.toLocaleString()})
					</Button>
				</Show>
				<Show when={props.client.localizationEdits && carries().length > 0}>
					<Button
						size="compact"
						tone="quiet"
						disabled={working() || props.busy || props.edits.working()}
						onClick={carry}
					>
						Carry translations ({carries().length.toLocaleString()})
					</Button>
				</Show>
				<Button size="compact" tone="quiet" disabled={working()} onClick={copyKeys}>
					Copy keys
				</Button>
				<Show when={props.selection.note()}>
					{(note) => (
						<span role="status" title={note()} {...stylex.attrs(styles.message)}>
							{note()}
						</span>
					)}
				</Show>
				<Show when={message()}>
					{(current) => (
						<span
							role={current().failed ? "alert" : "status"}
							title={current().text}
							{...stylex.attrs(styles.message, current().failed && styles.failed)}
						>
							{current().text}
						</span>
					)}
				</Show>
				<button
					type="button"
					aria-label="Clear selection"
					title="Clear selection"
					onClick={clear}
					{...stylex.attrs(styles.close)}
				>
					×
				</button>
			</div>
		</Show>
	);
}

const styles = stylex.create({
	bar: {
		position: "sticky",
		bottom: 8,
		zIndex: 2,
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: 6,
		marginInline: 10,
		marginBlock: 8,
		paddingBlock: 4,
		paddingInline: 10,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: 8,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: "0 6px 20px rgba(0, 0, 0, 0.28)",
		fontSize: 12.5
	},
	count: {
		paddingInlineEnd: 6,
		color: tokens.colorTextStrong,
		fontWeight: 500,
		fontVariantNumeric: "tabular-nums",
		whiteSpace: "nowrap"
	},
	message: {
		minWidth: 0,
		overflow: "hidden",
		overflowWrap: "anywhere",
		whiteSpace: "normal",
		color: tokens.colorTextMuted
	},
	failed: { color: tokens.colorWarning },
	close: {
		marginLeft: "auto",
		width: 24,
		height: 24,
		borderWidth: 0,
		borderRadius: 4,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorTextMuted,
		fontSize: 16,
		lineHeight: 1,
		cursor: "pointer",
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: -2 }
	}
});
