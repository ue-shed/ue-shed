import * as stylex from "@stylexjs/stylex";
import type { TextFilter, TextGroup, TextGroupList } from "@ue-shed/game-text/browser";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show } from "solid-js";
import { hasValue, toggleValue } from "./game-text-filter-model.js";

const SEVERE = new Set<string>(["key_changed", "conflicting_source"]);

/** The folder above `folder`, or empty for the top folders. */
function parentOf(folder: string): string {
	const trimmed = folder.replace(/\/+$/u, "");
	const end = trimmed.lastIndexOf("/");
	return end < 0 ? "" : trimmed.slice(0, end);
}

/**
 * Folders one level at a time, worst first: a name adds or removes its folder pill, the arrow opens
 * the folders inside it, and "‹" goes back up. The same browser sits in the side pane and in the
 * Filter menu's Folder submenu, where typed text narrows the level shown and can add a path prefix.
 */
export function FolderBrowser(props: {
	readonly list: TextGroupList | undefined;
	/** The folder whose folders are listed; empty for the top folders. */
	readonly folder: string;
	readonly filter: TextFilter;
	readonly onFolderChange: (folder: string) => void;
	readonly onFilterChange: (filter: TextFilter) => void;
	/** In the Filter menu: items are menu checkboxes and typed text narrows the level. */
	readonly menu?: boolean;
	readonly typed?: string;
}) {
	const needle = () => props.typed?.trim().toLocaleLowerCase() ?? "";
	const entries = (): readonly TextGroup[] =>
		(props.list?.entries ?? []).filter(
			(entry) => needle() === "" || entry.label.toLocaleLowerCase().includes(needle())
		);
	const value = (entry: TextGroup) => entry.key + "/";
	const chosen = (folder: string) =>
		hasValue(props.filter, "folder", folder) ||
		hasValue(props.filter, "folder", folder, "is_not");
	const toggle = (folder: string) =>
		props.onFilterChange(
			toggleValue(props.filter, { field: "folder", op: "is", values: [folder] })
		);
	const name = (entry: TextGroup) => entry.label.split("/").at(-1) ?? entry.label;
	const typedPrefix = () => props.typed?.trim() ?? "";
	return (
		<div {...stylex.attrs(styles.browser)}>
			<Show when={props.folder !== ""}>
				<button
					type="button"
					role={props.menu ? "menuitem" : undefined}
					onClick={() => props.onFolderChange(parentOf(props.folder))}
					{...stylex.attrs(styles.item, styles.up)}
				>
					<span aria-hidden="true">‹</span>
					<span {...stylex.attrs(styles.name, styles.mono)}>
						{parentOf(props.folder) === "" ? "Top folders" : parentOf(props.folder)}
					</span>
				</button>
			</Show>
			<For each={entries()}>
				{(entry) => (
					<div {...stylex.attrs(styles.row)}>
						<button
							type="button"
							role={props.menu ? "menuitemcheckbox" : undefined}
							aria-checked={
								props.menu ? (chosen(value(entry)) ? "true" : "false") : undefined
							}
							aria-pressed={
								props.menu ? undefined : chosen(value(entry)) ? "true" : "false"
							}
							aria-label={`${name(entry)} ${entry.count.toLocaleString()}`}
							title={entry.label}
							onClick={() => toggle(value(entry))}
							{...stylex.attrs(styles.item, chosen(value(entry)) && styles.chosen)}
						>
							<Show when={props.menu}>
								<span
									aria-hidden="true"
									{...stylex.attrs(
										styles.box,
										chosen(value(entry)) && styles.boxOn
									)}
								>
									{chosen(value(entry)) ? "✓" : ""}
								</span>
							</Show>
							<span {...stylex.attrs(styles.name, styles.mono)}>{name(entry)}</span>
							<span {...stylex.attrs(styles.count)}>
								<Show when={entry.needWork > 0}>
									<span
										{...stylex.attrs(
											SEVERE.has(entry.worst) ? styles.severe : styles.waiting
										)}
									>
										{entry.needWork.toLocaleString()}
									</span>
									{" · "}
								</Show>
								{entry.count.toLocaleString()}
							</span>
						</button>
						<button
							type="button"
							role={props.menu ? "menuitem" : undefined}
							aria-label={`Folders in ${entry.label}`}
							onClick={() => props.onFolderChange(entry.label)}
							{...stylex.attrs(styles.into)}
						>
							›
						</button>
					</div>
				)}
			</For>
			<Show when={entries().length === 0 && typedPrefix() === ""}>
				<p {...stylex.attrs(styles.note)}>No folders here.</p>
			</Show>
			<Show when={(props.list?.more ?? 0) > 0 && needle() === ""}>
				<p {...stylex.attrs(styles.note)}>
					{(props.list?.more ?? 0).toLocaleString()} more, by problems.
				</p>
			</Show>
			<Show when={props.menu && typedPrefix() !== ""}>
				<button
					type="button"
					role="menuitemcheckbox"
					aria-checked={chosen(typedPrefix()) ? "true" : "false"}
					aria-label={`Path starts with ${typedPrefix()}`}
					onClick={() => toggle(typedPrefix())}
					{...stylex.attrs(styles.item, styles.typed)}
				>
					<span
						aria-hidden="true"
						{...stylex.attrs(styles.box, chosen(typedPrefix()) && styles.boxOn)}
					>
						{chosen(typedPrefix()) ? "✓" : ""}
					</span>
					<span {...stylex.attrs(styles.name)}>
						Path starts with <span {...stylex.attrs(styles.mono)}>{typedPrefix()}</span>
					</span>
				</button>
			</Show>
		</div>
	);
}

const styles = stylex.create({
	browser: { display: "grid", gap: 2 },
	row: { display: "flex", alignItems: "center", gap: 2 },
	item: {
		flex: 1,
		minWidth: 0,
		display: "flex",
		alignItems: "center",
		gap: 8,
		minHeight: 28,
		paddingInline: 8,
		borderWidth: 0,
		borderRadius: 5,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 12.5,
		textAlign: "start",
		cursor: "pointer",
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: -2 }
	},
	chosen: { backgroundColor: tokens.colorAccentWash, color: tokens.colorTextStrong },
	up: { color: tokens.colorTextMuted },
	typed: { color: tokens.colorTextMuted },
	into: {
		width: 24,
		height: 24,
		flexShrink: 0,
		borderWidth: 0,
		borderRadius: 4,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorTextMuted,
		cursor: "pointer",
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: -2 }
	},
	box: {
		width: 13,
		height: 13,
		flexShrink: 0,
		display: "grid",
		placeItems: "center",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: 3,
		fontSize: 9
	},
	boxOn: {
		backgroundColor: tokens.colorAccent,
		borderColor: tokens.colorAccent,
		color: tokens.colorAccentText
	},
	name: {
		flex: 1,
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	mono: { fontFamily: tokens.fontMono, fontSize: 12 },
	count: { color: tokens.colorTextMuted, fontVariantNumeric: "tabular-nums", fontSize: 12 },
	severe: { color: tokens.colorDanger },
	waiting: { color: tokens.colorWarning },
	note: {
		margin: 0,
		paddingInline: 8,
		paddingBlock: 4,
		color: tokens.colorTextMuted,
		fontSize: 12
	}
});
