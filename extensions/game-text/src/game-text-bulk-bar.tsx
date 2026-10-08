import * as stylex from "@stylexjs/stylex";
import {
	MAX_LOCALIZATION_EDITS,
	type LocalizationLineId,
	type LocalizationLinePreview,
	type LocalizationReviewChange,
	type LocalizationSelection
} from "@ue-shed/game-text/browser";
import { Button, createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Effect } from "effect";
import { Show, createMemo, createSignal } from "solid-js";
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
	const [capped, setCapped] = createSignal(false);
	let anchor: LocalizationLineId | undefined;
	const toggle = (line: LocalizationLinePreview, range: boolean) => {
		const on = !ticked().has(line.id);
		const span = range ? lineRange(input.order(), anchor, line.id) : [line];
		const next = new Map(ticked());
		let full = false;
		for (const item of span.length === 0 ? [line] : span) {
			if (!on) next.delete(item.id);
			else if (next.size < MAX_SELECTED_LINES || next.has(item.id)) next.set(item.id, item);
			else full = true;
		}
		anchor = line.id;
		setCapped(full);
		setTicked(next);
	};
	const clear = () => {
		anchor = undefined;
		setCapped(false);
		setTicked(new Map());
	};
	// Each ticked line as the list last loaded it, so a reload after a write shows its new state.
	const current = createMemo(() => {
		const fresh = new Map(input.order().map((line) => [line.id, line]));
		return new Map([...ticked()].map(([id, line]) => [id, fresh.get(id) ?? line] as const));
	});
	return {
		ticked: current,
		capped,
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
	readonly client: GameTextClientApi;
	readonly localization: LocalizationSelection | undefined;
	readonly cultures: readonly string[];
	readonly nativeCulture: string | undefined;
	readonly edits: GameTextEdits;
	readonly busy: boolean;
	/** The project's state changed, such as review flags; the list reloads. */
	readonly onChanged: () => void;
}) {
	const action = createEffectAction();
	const [working, setWorking] = createSignal(false);
	const [message, setMessage] = createSignal<string | undefined>(undefined);
	const lines = createMemo(() => [...props.selection.ticked().values()]);
	// Reviews written from this bar, so a ticked line in a closed group, which the list has not
	// reloaded, does not offer them again.
	const [written, setWritten] = createSignal<ReadonlySet<string>>(new Set());
	const reviewKey = (change: LocalizationReviewChange) =>
		change.kind === "set" ? [change.culture, change.namespace, change.key].join("\u0000") : "";
	const reviews = createMemo(() =>
		reviewChanges(lines(), props.cultures, props.nativeCulture).filter(
			(change) => !written().has(reviewKey(change))
		)
	);
	const carries = createMemo(() => carryEdits(lines()));
	const count = () => lines().length;
	const run = <A, E>(
		effect: Effect.Effect<A, E>,
		done: (value: A) => string | undefined,
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
				setMessage(failed);
			}
		});
	};
	const exportLines = () => {
		const request = props.client.localizationLinesFile;
		const localization = props.localization;
		if (!request || !localization || count() === 0) return;
		run(
			request(exportRequest(localization, lines())),
			(result) =>
				result.status === "saved"
					? `Exported ${result.rowCount.toLocaleString()} lines.`
					: result.status === "failed"
						? `${result.message} ${result.recovery}`
						: result.status === "not_ready"
							? "Translations are still loading. Try again in a moment."
							: undefined,
			"The lines could not be exported. Try again."
		);
	};
	const markReviewed = () => {
		const request = props.client.localizationReview;
		const target = props.localization?.target;
		const changes = reviews();
		if (!request || target === undefined || changes.length === 0) return;
		// One request per batch, in order; the first failure stops the rest.
		const write = Effect.gen(function* () {
			let marked = 0;
			for (const batch of batches(changes, REVIEW_BATCH)) {
				const result = yield* request({ target, changes: batch });
				if (result.status !== "written") return { marked, result };
				marked += batch.length;
				setWritten((done) => new Set([...done, ...batch.map(reviewKey)]));
			}
			return { marked, result: undefined };
		});
		run(
			write,
			({ marked, result }) => {
				if (marked > 0) props.onChanged();
				const done = `Marked ${marked.toLocaleString()} translations reviewed.`;
				return result?.status === "failed"
					? `${marked > 0 ? done + " " : ""}${result.message} ${result.recovery}`
					: result?.status === "not_ready"
						? "Translations are still loading. Try again in a moment."
						: done;
			},
			"Review state could not be saved. Rescan and try again."
		);
	};
	// Staged edits are written in one request, so carrying stops at its limit.
	const carry = () => {
		const fresh = carries().filter(
			({ edit }) =>
				props.edits.stagedFor(edit.culture, {
					namespace: edit.namespace,
					key: edit.key
				}) === undefined
		);
		const room = Math.max(0, MAX_LOCALIZATION_EDITS - props.edits.edits().length);
		const staged = fresh.slice(0, room);
		if (staged.length > 0) {
			props.edits.stageAll(staged);
			props.edits.setOpen(true);
		}
		setMessage(
			`Staged ${staged.length.toLocaleString()} translations to carry.` +
				(staged.length < fresh.length
					? ` Write them first: at most ${MAX_LOCALIZATION_EDITS} edits are staged at once.`
					: "")
		);
	};
	const copyKeys = () =>
		run(
			Effect.tryPromise({
				try: () => navigator.clipboard.writeText(keysText(lines())),
				catch: String
			}),
			() => `Copied ${count().toLocaleString()} keys.`,
			"The keys could not be copied."
		);
	const clear = () => {
		setMessage(undefined);
		setWritten(new Set<string>());
		props.selection.clear();
	};
	return (
		<Show when={count() > 0}>
			<div role="toolbar" aria-label="Selected lines" {...stylex.attrs(styles.bar)}>
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
						onClick={markReviewed}
					>
						Mark reviewed ({reviews().length.toLocaleString()})
					</Button>
				</Show>
				<Show when={props.client.localizationEdits && carries().length > 0}>
					<Button
						size="compact"
						tone="quiet"
						disabled={working() || props.busy}
						onClick={carry}
					>
						Carry translations ({carries().length.toLocaleString()})
					</Button>
				</Show>
				<Button size="compact" tone="quiet" disabled={working()} onClick={copyKeys}>
					Copy keys
				</Button>
				<Show when={message() ?? (props.selection.capped() ? capNote : undefined)}>
					{(text) => (
						<span role="status" {...stylex.attrs(styles.message)}>
							{text()}
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

const capNote = `A selection holds at most ${MAX_SELECTED_LINES.toLocaleString()} lines.`;

const styles = stylex.create({
	bar: {
		position: "sticky",
		bottom: 8,
		zIndex: 2,
		display: "flex",
		alignItems: "center",
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
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: tokens.colorTextMuted
	},
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
