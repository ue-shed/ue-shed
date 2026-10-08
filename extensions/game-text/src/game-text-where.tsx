import * as stylex from "@stylexjs/stylex";
import {
	MAX_TEXT_SCOPE_FILES,
	TEXT_ORIGIN_KINDS,
	type TextCorpusSearchCounts,
	type TextFileScopeSummary,
	type TextOriginKind,
	type TextWhere
} from "@ue-shed/game-text/browser";
import { AnchoredPopover, Button, Chip } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createSignal, createUniqueId } from "solid-js";

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
	pathPrefix: string | undefined,
	files?: readonly string[]
): TextWhere | undefined {
	const ordered = TEXT_ORIGIN_KINDS.filter((kind) => kinds?.includes(kind));
	const listed = files !== undefined && files.length > 0 ? files : undefined;
	if (ordered.length === 0 && pathPrefix === undefined && listed === undefined) return undefined;
	return {
		...(ordered.length > 0 ? { kinds: ordered } : undefined),
		...(pathPrefix === undefined ? undefined : { pathPrefix }),
		...(listed === undefined ? undefined : { files: listed })
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
				props.where?.pathPrefix,
				props.where?.files
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
		props.onChange(
			textWhere(props.where?.kinds, prefix === "" ? undefined : prefix, props.where?.files)
		);
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

/** "12 files · 5 with text · 2 not scanned · 1 outside the project" */
export function fileScopeLine(summary: TextFileScopeSummary): string {
	const parts = [
		summary.files === 1 ? "1 file" : `${summary.files.toLocaleString()} files`,
		`${summary.textFiles.toLocaleString()} with text`
	];
	if (summary.notScanned) parts.push(`${summary.notScanned.toLocaleString()} not scanned`);
	if (summary.outside) parts.push(`${summary.outside.toLocaleString()} outside the project`);
	return parts.join(" · ");
}

/**
 * "Changed files" takes a pasted list from any version control tool and keeps only the text
 * those files hold. The list lasts for the session; it is not saved with the view.
 */
export function ChangedFilesFilter(props: {
	readonly where: TextWhere | undefined;
	readonly summary: TextFileScopeSummary | undefined;
	readonly disabled: boolean;
	readonly onChange: (where: TextWhere | undefined) => void;
}) {
	const id = createUniqueId();
	const [open, setOpen] = createSignal(false);
	const [draft, setDraft] = createSignal("");
	const [message, setMessage] = createSignal<string>();
	const files = () => props.where?.files;
	const apply = () => {
		const listed = draft()
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#"));
		if (listed.length > MAX_TEXT_SCOPE_FILES) {
			setMessage(
				`This list names ${listed.length.toLocaleString()} files. Split it into lists of ${MAX_TEXT_SCOPE_FILES.toLocaleString()} or fewer.`
			);
			return;
		}
		setMessage(undefined);
		setOpen(false);
		props.onChange(textWhere(props.where?.kinds, props.where?.pathPrefix, listed));
	};
	const clear = () => {
		setDraft("");
		setMessage(undefined);
		setOpen(false);
		props.onChange(textWhere(props.where?.kinds, props.where?.pathPrefix));
	};
	return (
		<AnchoredPopover
			id={id}
			ariaLabel="Changed files"
			open={open()}
			onOpenChange={(next) => {
				if (next) setDraft(files()?.join("\n") ?? "");
				setOpen(next);
			}}
			placement="bottom-end"
			style={styles.panel}
			trigger={(trigger) => (
				<Button
					{...trigger}
					type="button"
					size="compact"
					tone="quiet"
					disabled={props.disabled}
					aria-pressed={files() === undefined ? "false" : "true"}
					title={props.summary ? fileScopeLine(props.summary) : undefined}
				>
					{files() === undefined
						? "Changed files…"
						: `Changed files ${files()?.length.toLocaleString()}`}
				</Button>
			)}
		>
			<textarea
				aria-label="Changed files, one path per line"
				placeholder={
					"Content/UI/WBP_Menu.uasset\n/Game/UI/DT_Menu\nSource/Game/Private/Menu.cpp"
				}
				rows={8}
				value={draft()}
				onInput={(event) => setDraft(event.currentTarget.value)}
				{...stylex.attrs(styles.list)}
			/>
			<span {...stylex.attrs(styles.note)}>
				One path per line, from any version control tool. Absolute paths inside the project
				work too.
			</span>
			<Show when={message()}>
				{(text) => (
					<span role="alert" {...stylex.attrs(styles.warning)}>
						{text()}
					</span>
				)}
			</Show>
			<Show when={files() !== undefined && props.summary}>
				{(summary) => (
					<span {...stylex.attrs(styles.note)}>{fileScopeLine(summary())}</span>
				)}
			</Show>
			<div {...stylex.attrs(styles.actions)}>
				<Button type="button" size="compact" tone="primary" onClick={apply}>
					Show their text
				</Button>
				<Show when={files() !== undefined}>
					<Button type="button" size="compact" tone="quiet" onClick={clear}>
						Clear
					</Button>
				</Show>
			</div>
		</AnchoredPopover>
	);
}

const styles = stylex.create({
	panel: { width: 380, display: "grid", gap: 8, padding: 10 },
	list: {
		width: "100%",
		boxSizing: "border-box",
		resize: "vertical",
		padding: 8,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorder, ":focus-visible": tokens.colorAccent },
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorText,
		fontFamily: tokens.fontMono,
		fontSize: 12,
		outlineStyle: "none"
	},
	note: { color: tokens.colorTextMuted, fontSize: 12 },
	warning: { color: tokens.colorWarning, fontSize: 12 },
	actions: { display: "flex", gap: 6 },
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
