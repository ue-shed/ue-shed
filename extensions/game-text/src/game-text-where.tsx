import * as stylex from "@stylexjs/stylex";
import {
	MAX_TEXT_SCOPE_FILES,
	TEXT_ORIGIN_KINDS,
	TEXT_ORIGIN_LABELS,
	type TextCorpusSearchCounts,
	type TextFileScopeSummary,
	type TextOriginKind,
	type TextWhere
} from "@ue-shed/game-text/browser";
import { AnchoredPopover, Button, Chip } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createSignal, createUniqueId } from "solid-js";

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

/** "Where: C++ · Source/ · 12 files", or "Where…" when nothing narrows the list. */
export function whereLabel(where: TextWhere | undefined): string {
	if (where === undefined) return "Where…";
	const parts = [
		...(where.kinds ?? []).map((kind) => TEXT_ORIGIN_LABELS[kind]),
		...(where.pathPrefix === undefined ? [] : [where.pathPrefix]),
		...(where.files === undefined
			? []
			: [
					where.files.length === 1
						? "1 file"
						: `${where.files.length.toLocaleString()} files`
				])
	];
	return "Where: " + parts.join(" · ");
}

/**
 * One compact control for where text comes from: origins (with counts that ignore the origin
 * filter), a path prefix, and a changed-file list pasted from any version control tool. Origins
 * apply at once; the path applies on Enter or when the field loses focus; a file list applies on
 * "Show their text" and lasts for the session.
 */
export function WhereFilter(props: {
	readonly where: TextWhere | undefined;
	readonly counts: TextCorpusSearchCounts["origins"] | undefined;
	readonly fileScope: TextFileScopeSummary | undefined;
	readonly searching: boolean;
	readonly disabled: boolean;
	/** Only the changed-file list; origins and paths are filter pills. */
	readonly filesOnly?: boolean;
	readonly onChange: (where: TextWhere | undefined) => void;
}) {
	const files = () => props.where?.files?.length;
	const triggerLabel = () =>
		props.filesOnly
			? files() === undefined
				? "Changed files…"
				: `Changed files: ${files()?.toLocaleString()}`
			: whereLabel(props.where);
	const id = createUniqueId();
	const [open, setOpen] = createSignal(false);
	const [draft, setDraft] = createSignal("");
	const [message, setMessage] = createSignal<string>();
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
	const commitPath = (value: string) => {
		const prefix = value.trim().slice(0, 512);
		if (prefix === (props.where?.pathPrefix ?? "")) return;
		props.onChange(
			textWhere(props.where?.kinds, prefix === "" ? undefined : prefix, props.where?.files)
		);
	};
	const showFiles = () => {
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
	const clearFiles = () => {
		setDraft("");
		setMessage(undefined);
		props.onChange(textWhere(props.where?.kinds, props.where?.pathPrefix));
	};
	return (
		<AnchoredPopover
			id={id}
			ariaLabel={props.filesOnly ? "Changed files" : "Where text comes from"}
			open={open()}
			onOpenChange={(next) => {
				if (next) setDraft(props.where?.files?.join("\n") ?? "");
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
					aria-pressed={
						(props.filesOnly ? files() === undefined : props.where === undefined)
							? "false"
							: "true"
					}
					title={props.fileScope ? fileScopeLine(props.fileScope) : undefined}
				>
					{triggerLabel()}
				</Button>
			)}
		>
			<Show when={!props.filesOnly}>
				<WhereOrigins
					where={props.where}
					counts={props.counts}
					searching={props.searching}
					disabled={props.disabled}
					selected={selected}
					toggle={toggle}
					commitPath={commitPath}
				/>
			</Show>
			<textarea
				aria-label="Changed files, one path per line"
				placeholder={
					"Changed files, one per line:\nContent/UI/WBP_Menu.uasset\nSource/Game/Private/Menu.cpp"
				}
				rows={5}
				value={draft()}
				onInput={(event) => setDraft(event.currentTarget.value)}
				{...stylex.attrs(styles.field, styles.list)}
			/>
			<Show when={message()}>
				{(text) => (
					<span role="alert" {...stylex.attrs(styles.warning)}>
						{text()}
					</span>
				)}
			</Show>
			<Show when={props.where?.files !== undefined && props.fileScope}>
				{(summary) => (
					<span {...stylex.attrs(styles.note)}>{fileScopeLine(summary())}</span>
				)}
			</Show>
			<div {...stylex.attrs(styles.actions)}>
				<Button type="button" size="compact" tone="primary" onClick={showFiles}>
					Show their text
				</Button>
				<Show when={props.where?.files !== undefined}>
					<Button type="button" size="compact" tone="quiet" onClick={clearFiles}>
						Clear files
					</Button>
				</Show>
				<Show when={!props.filesOnly && props.where !== undefined}>
					<Button
						type="button"
						size="compact"
						tone="quiet"
						onClick={() => {
							setDraft("");
							setMessage(undefined);
							props.onChange(undefined);
						}}
					>
						Clear all
					</Button>
				</Show>
			</div>
		</AnchoredPopover>
	);
}

function WhereOrigins(props: {
	readonly where: TextWhere | undefined;
	readonly counts: TextCorpusSearchCounts["origins"] | undefined;
	readonly searching: boolean;
	readonly disabled: boolean;
	readonly selected: (kind: TextOriginKind) => boolean;
	readonly toggle: (kind: TextOriginKind) => void;
	readonly commitPath: (value: string) => void;
}) {
	return (
		<>
			<div role="group" aria-label="Origins" {...stylex.attrs(styles.chips)}>
				<For
					each={TEXT_ORIGIN_KINDS.filter(
						(kind) => props.selected(kind) || (props.counts?.[kind] ?? 0) > 0
					)}
				>
					{(kind) => (
						<Chip
							label={TEXT_ORIGIN_LABELS[kind]}
							toggle
							disabled={props.disabled}
							selected={props.selected(kind)}
							count={props.searching ? undefined : props.counts?.[kind]}
							onClick={() => props.toggle(kind)}
						/>
					)}
				</For>
			</div>
			<input
				type="text"
				aria-label="Path starts with"
				placeholder="Path starts with: /Game/UI/ or Source/"
				maxlength={512}
				value={props.where?.pathPrefix ?? ""}
				onKeyDown={(event) => {
					if (event.key === "Enter") props.commitPath(event.currentTarget.value);
				}}
				onBlur={(event) => props.commitPath(event.currentTarget.value)}
				{...stylex.attrs(styles.field)}
			/>
		</>
	);
}

const styles = stylex.create({
	panel: {
		display: "grid",
		gap: 8,
		width: 400,
		maxWidth: "calc(100vw - 32px)",
		boxSizing: "border-box",
		padding: 10,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
		zIndex: 20
	},
	chips: { display: "flex", flexWrap: "wrap", gap: 6 },
	field: {
		width: "100%",
		boxSizing: "border-box",
		height: 28,
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
	},
	list: {
		height: "auto",
		paddingBlock: 6,
		resize: "vertical",
		fontFamily: tokens.fontMono,
		wordBreak: "break-all"
	},
	note: { color: tokens.colorTextMuted, fontSize: 12 },
	warning: { color: tokens.colorWarning, fontSize: 12 },
	actions: { display: "flex", gap: 6 }
});
