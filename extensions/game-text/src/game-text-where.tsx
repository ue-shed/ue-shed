import * as stylex from "@stylexjs/stylex";
import {
	TEXT_ORIGIN_KINDS,
	type TextCorpusSearchCounts,
	type TextOriginKind,
	type TextWhere
} from "@ue-shed/game-text/browser";
import { Chip } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createSignal } from "solid-js";

const originLabels = {
	string_table: "String table",
	data_table: "Data table",
	asset: "Asset",
	cpp: "C++",
	other_source: "Other source"
} satisfies Record<TextOriginKind, string>;

/** A location filter with only the given parts; none at all means no filter. */
export function textWhere(
	kinds: readonly TextOriginKind[] | undefined,
	pathPrefix: string | undefined
): TextWhere | undefined {
	const ordered = TEXT_ORIGIN_KINDS.filter((kind) => kinds?.includes(kind));
	if (ordered.length === 0 && pathPrefix === undefined) return undefined;
	return {
		...(ordered.length > 0 ? { kinds: ordered } : undefined),
		...(pathPrefix === undefined ? undefined : { pathPrefix })
	};
}

/** Toggle chips for where text comes from. A chip is hidden at zero unless it is selected. */
export function OriginChips(props: {
	readonly where: TextWhere | undefined;
	readonly counts: TextCorpusSearchCounts["origins"] | undefined;
	readonly searching: boolean;
	readonly disabled: boolean;
	readonly onChange: (where: TextWhere | undefined) => void;
}) {
	const selected = (kind: TextOriginKind) => props.where?.kinds?.includes(kind) ?? false;
	const toggle = (kind: TextOriginKind) => {
		const kinds = props.where?.kinds ?? [];
		props.onChange(
			textWhere(
				selected(kind) ? kinds.filter((item) => item !== kind) : [...kinds, kind],
				props.where?.pathPrefix
			)
		);
	};
	return (
		<For
			each={TEXT_ORIGIN_KINDS.filter(
				(kind) => selected(kind) || (props.counts?.[kind] ?? 0) > 0
			)}
		>
			{(kind) => (
				<Chip
					label={originLabels[kind]}
					toggle
					disabled={props.disabled}
					selected={selected(kind)}
					count={props.searching ? undefined : props.counts?.[kind]}
					onClick={() => toggle(kind)}
				/>
			)}
		</For>
	);
}

/** "Path…" opens a compact input; a set prefix reads "Path: /Game/UI/" until it is cleared. */
export function PathFilter(props: {
	readonly where: TextWhere | undefined;
	readonly disabled: boolean;
	readonly onChange: (where: TextWhere | undefined) => void;
}) {
	const [editing, setEditing] = createSignal(false);
	const commit = (value: string) => {
		setEditing(false);
		const prefix = value.trim().slice(0, 512);
		if (prefix === (props.where?.pathPrefix ?? "")) return;
		props.onChange(textWhere(props.where?.kinds, prefix === "" ? undefined : prefix));
	};
	return (
		<Show
			when={editing()}
			fallback={
				<Chip
					label={props.where?.pathPrefix ? "Path: " + props.where.pathPrefix : "Path…"}
					disabled={props.disabled}
					selected={props.where?.pathPrefix !== undefined}
					onClick={() => setEditing(true)}
				/>
			}
		>
			<input
				autofocus
				type="text"
				aria-label="Path starts with"
				placeholder="/Game/UI/ or Source/"
				maxlength={512}
				value={props.where?.pathPrefix ?? ""}
				onKeyDown={(event) => {
					if (event.key === "Enter") commit(event.currentTarget.value);
					else if (event.key === "Escape") setEditing(false);
				}}
				onBlur={(event) => {
					if (editing()) commit(event.currentTarget.value);
				}}
				{...stylex.attrs(styles.input)}
			/>
		</Show>
	);
}

const styles = stylex.create({
	input: {
		width: 200,
		height: 26,
		boxSizing: "border-box",
		paddingInline: 8,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorder, ":focus-visible": tokens.colorAccent },
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 12,
		outlineStyle: "none"
	}
});
