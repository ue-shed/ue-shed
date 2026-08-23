import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createMemo, createSignal, createUniqueId } from "solid-js";

export interface SavedMapPickerOption {
	readonly label: string;
	readonly mapPath: string;
}

/**
 * The shared searchable saved-map control used by Map Capture, offline Map Review, and World Log.
 *
 * The component deliberately knows nothing about project configuration or file IO. Hosts own
 * the map inventory and decide what selecting an option should load or invalidate.
 */
export function SavedMapPicker(props: {
	readonly ariaLabel?: string;
	readonly disabled?: boolean;
	readonly allowCustomPath?: boolean;
	readonly customPathPlaceholder?: string;
	readonly label?: string;
	readonly mapPath: string;
	readonly maps: ReadonlyArray<SavedMapPickerOption>;
	readonly onMapPathChange: (mapPath: string) => void;
}) {
	const pickerId = createUniqueId();
	const listboxId = `${pickerId}-options`;
	const [activeIndex, setActiveIndex] = createSignal(0);
	const [customOpen, setCustomOpen] = createSignal(false);
	const [open, setOpen] = createSignal(false);
	const [query, setQuery] = createSignal("");
	let customPathInput: HTMLInputElement | undefined;
	let searchInput: HTMLInputElement | undefined;
	let trigger: HTMLButtonElement | undefined;

	const knownMap = createMemo(() => props.maps.find((map) => map.mapPath === props.mapPath));
	const customSelected = createMemo(
		() => props.allowCustomPath === true && (customOpen() || knownMap() === undefined)
	);
	const filteredMaps = createMemo(() => {
		const normalized = query().trim().toLocaleLowerCase();
		if (normalized.length === 0) return props.maps;
		return props.maps.filter(
			(map) =>
				map.label.toLocaleLowerCase().includes(normalized) ||
				map.mapPath.toLocaleLowerCase().includes(normalized)
		);
	});
	const optionCount = createMemo(
		() => filteredMaps().length + (props.allowCustomPath === true ? 1 : 0)
	);
	const activeOptionId = createMemo(() =>
		open() && optionCount() > 0 ? `${pickerId}-option-${activeIndex()}` : undefined
	);

	function closePicker(restoreFocus = false) {
		setOpen(false);
		setQuery("");
		setActiveIndex(0);
		if (restoreFocus) queueMicrotask(() => trigger?.focus());
	}

	function openPicker() {
		if (props.disabled || (props.maps.length === 0 && !props.allowCustomPath)) return;
		setOpen(true);
		setQuery("");
		setActiveIndex(0);
		queueMicrotask(() => searchInput?.focus());
	}

	function selectMap(map: SavedMapPickerOption) {
		setCustomOpen(false);
		props.onMapPathChange(map.mapPath);
		closePicker(true);
	}

	function selectCustomPath() {
		setCustomOpen(true);
		closePicker();
		queueMicrotask(() => customPathInput?.focus());
	}

	function selectActiveOption() {
		const map = filteredMaps()[activeIndex()];
		if (map !== undefined) {
			selectMap(map);
			return;
		}
		if (props.allowCustomPath && activeIndex() === filteredMaps().length) {
			selectCustomPath();
		}
	}

	function moveActiveOption(direction: -1 | 1) {
		const count = optionCount();
		if (count === 0) return;
		setActiveIndex((current) => (current + direction + count) % count);
		queueMicrotask(() => {
			const option = document.getElementById(`${pickerId}-option-${activeIndex()}`);
			option?.scrollIntoView?.({ block: "nearest" });
		});
	}

	function handleSearchKeyDown(event: KeyboardEvent) {
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				moveActiveOption(1);
				break;
			case "ArrowUp":
				event.preventDefault();
				moveActiveOption(-1);
				break;
			case "Enter":
				event.preventDefault();
				selectActiveOption();
				break;
			case "Escape":
				event.preventDefault();
				closePicker(true);
				break;
		}
	}

	return (
		<div {...stylex.props(styles.picker)}>
			<label for={pickerId}>
				<span {...stylex.props(styles.label)}>{props.label ?? "SAVED MAP"}</span>
			</label>
			<button
				ref={(element) => {
					trigger = element;
				}}
				id={pickerId}
				type="button"
				role="combobox"
				aria-label={props.ariaLabel ?? "Saved map"}
				aria-controls={listboxId}
				aria-expanded={open()}
				aria-haspopup="listbox"
				disabled={props.disabled || (props.maps.length === 0 && !props.allowCustomPath)}
				onClick={() => (open() ? closePicker() : openPicker())}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						openPicker();
					}
				}}
				{...stylex.props(styles.trigger, open() && styles.triggerOpen)}
			>
				<span {...stylex.props(styles.triggerText)}>
					<strong {...stylex.props(styles.triggerPrimary)}>
						{customSelected()
							? "CUSTOM MAP PATH"
							: (knownMap()?.label ??
								(props.maps.length === 0 ? "NO SAVED MAPS" : "SELECT MAP"))}
					</strong>
					<small {...stylex.props(styles.triggerSecondary)}>
						{customSelected()
							? props.mapPath || "Enter an explicit path below"
							: (knownMap()?.mapPath ??
								`${props.maps.length.toLocaleString()} maps available`)}
					</small>
				</span>
				<span
					aria-hidden="true"
					{...stylex.props(styles.chevron, open() && styles.chevronOpen)}
				>
					⌄
				</span>
			</button>

			<Show when={open()}>
				<div
					aria-hidden="true"
					onPointerDown={() => closePicker()}
					{...stylex.props(styles.backdrop)}
				/>
				<div {...stylex.props(styles.dropdown)}>
					<div {...stylex.props(styles.searchShell)}>
						<span aria-hidden="true" {...stylex.props(styles.searchIcon)}>
							⌕
						</span>
						<input
							ref={(element) => {
								searchInput = element;
							}}
							type="search"
							role="searchbox"
							aria-label="Search saved maps"
							aria-activedescendant={activeOptionId()}
							aria-controls={listboxId}
							value={query()}
							onInput={(event) => {
								setQuery(event.currentTarget.value);
								setActiveIndex(0);
							}}
							onKeyDown={handleSearchKeyDown}
							placeholder={`Search ${props.maps.length.toLocaleString()} maps by name or path`}
							{...stylex.props(styles.searchInput)}
						/>
					</div>
					<div id={listboxId} role="listbox" {...stylex.props(styles.options)}>
						<For each={filteredMaps()}>
							{(map, index) => (
								<div
									id={`${pickerId}-option-${index()}`}
									role="option"
									aria-selected={map.mapPath === props.mapPath}
									onMouseEnter={() => setActiveIndex(index())}
									onClick={() => selectMap(map)}
									{...stylex.props(
										styles.option,
										activeIndex() === index() && styles.optionActive,
										map.mapPath === props.mapPath && styles.optionSelected
									)}
								>
									<span {...stylex.props(styles.optionLabel)}>{map.label}</span>
									<code
										{...stylex.props(
											styles.optionPath,
											map.mapPath === props.mapPath &&
												styles.optionPathSelected
										)}
									>
										{map.mapPath}
									</code>
								</div>
							)}
						</For>
						<Show when={filteredMaps().length === 0}>
							<p {...stylex.props(styles.empty)}>NO SAVED MAPS MATCH “{query()}”</p>
						</Show>
						<Show when={props.allowCustomPath}>
							<div
								id={`${pickerId}-option-${filteredMaps().length}`}
								role="option"
								aria-selected={customSelected()}
								onMouseEnter={() => setActiveIndex(filteredMaps().length)}
								onClick={selectCustomPath}
								{...stylex.props(
									styles.option,
									styles.customOption,
									activeIndex() === filteredMaps().length && styles.optionActive
								)}
							>
								<span {...stylex.props(styles.optionLabel)}>CUSTOM MAP PATH…</span>
								<code {...stylex.props(styles.optionPath)}>
									Enter a path not present in the project inventory
								</code>
							</div>
						</Show>
					</div>
				</div>
			</Show>

			<Show when={customSelected()}>
				<label {...stylex.props(styles.customPath)}>
					<span>MAP PATH</span>
					<input
						ref={(element) => {
							customPathInput = element;
						}}
						aria-label="Custom map path"
						disabled={props.disabled}
						value={props.mapPath}
						onInput={(event) => props.onMapPathChange(event.currentTarget.value)}
						placeholder={props.customPathPlaceholder ?? "Content/Maps/L_MyMap.umap"}
						{...stylex.props(styles.customInput)}
					/>
				</label>
			</Show>
		</div>
	);
}

const styles = stylex.create({
	picker: {
		position: "relative",
		display: "grid",
		gap: 6,
		minWidth: 220,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	label: { display: "block" },
	backdrop: {
		position: "fixed",
		inset: 0,
		zIndex: 39,
		backgroundColor: "transparent"
	},
	trigger: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		width: "100%",
		minWidth: 220,
		boxSizing: "border-box",
		borderColor: { default: tokens.colorBorder, ":hover": "#4a4e54" },
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "8px 10px",
		fontFamily: tokens.fontMono,
		fontSize: 12,
		textAlign: "left",
		outline: "none",
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		opacity: { default: 1, ":disabled": 0.55 }
	},
	triggerOpen: {
		borderColor: tokens.colorTextSubtle,
		boxShadow: "0 0 0 1px rgba(138, 143, 152, 0.2)"
	},
	triggerText: {
		display: "grid",
		minWidth: 0,
		gap: 3
	},
	triggerPrimary: {
		overflow: "hidden",
		fontSize: 12,
		fontWeight: 500,
		color: tokens.colorTextStrong,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	triggerSecondary: {
		overflow: "hidden",
		color: tokens.colorTextSubtle,
		fontSize: 11,
		fontWeight: 400,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	chevron: { color: tokens.colorTextFaint, fontSize: 14, transform: "translateY(-1px)" },
	chevronOpen: { transform: "rotate(180deg) translateY(-1px)" },
	dropdown: {
		position: "absolute",
		top: "calc(100% + 5px)",
		left: 0,
		zIndex: 40,
		width: "max(100%, 340px)",
		maxWidth: "calc(100vw - 40px)",
		boxSizing: "border-box",
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		boxShadow: tokens.shadowOverlay
	},
	searchShell: {
		display: "flex",
		alignItems: "center",
		gap: 7,
		padding: 8,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: tokens.colorSurfaceRaised,
		borderTopLeftRadius: tokens.radiusControl,
		borderTopRightRadius: tokens.radiusControl
	},
	searchIcon: { color: tokens.colorTextFaint, fontSize: 13, fontWeight: 400 },
	searchInput: {
		width: "100%",
		minWidth: 0,
		boxSizing: "border-box",
		borderStyle: "none",
		borderWidth: 0,
		backgroundColor: "transparent",
		color: tokens.colorTextStrong,
		padding: "5px 2px",
		fontFamily: tokens.fontMono,
		fontSize: 12,
		fontWeight: 400,
		outline: "none"
	},
	options: { maxHeight: 276, overflowY: "auto", padding: 4 },
	option: {
		display: "grid",
		gap: 3,
		padding: "8px 9px",
		borderRadius: tokens.radiusBadge,
		borderLeftColor: "transparent",
		borderLeftStyle: "solid",
		borderLeftWidth: 2,
		color: tokens.colorText,
		cursor: "pointer",
		fontSize: 12
	},
	optionLabel: { fontSize: 12, fontWeight: 500 },
	optionPath: {
		overflow: "hidden",
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		fontWeight: 400,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	optionPathSelected: { color: tokens.colorTextMuted },
	optionActive: {
		backgroundColor: "rgba(255, 255, 255, 0.04)"
	},
	optionSelected: {
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		borderLeftColor: tokens.colorAccent,
		color: tokens.colorTextStrong
	},
	customOption: {
		marginTop: 4,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1
	},
	empty: {
		margin: 0,
		padding: "13px 9px",
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 400
	},
	customPath: {
		display: "grid",
		gap: 6,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	customInput: {
		width: "100%",
		boxSizing: "border-box",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		padding: "8px 9px",
		fontFamily: tokens.fontMono,
		fontSize: 12,
		outline: { default: "none", ":focus": `1px solid ${tokens.colorTextSubtle}` }
	}
});
