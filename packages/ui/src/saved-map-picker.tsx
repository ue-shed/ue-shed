import * as stylex from "@stylexjs/stylex";
import { For, Show, createMemo, createSignal } from "solid-js";

export interface SavedMapPickerOption {
	readonly label: string;
	readonly mapPath: string;
}

/**
 * The shared saved-map control used by offline Map Review and World Log acquisition.
 *
 * The component deliberately knows nothing about project configuration or file IO. Hosts own
 * the map inventory and decide what selecting an option should load or invalidate.
 */
export function SavedMapPicker(props: {
	readonly ariaLabel?: string;
	readonly disabled?: boolean;
	readonly allowCustomPath?: boolean;
	readonly label?: string;
	readonly mapPath: string;
	readonly maps: ReadonlyArray<SavedMapPickerOption>;
	readonly onMapPathChange: (mapPath: string) => void;
}) {
	const [customOpen, setCustomOpen] = createSignal(false);
	const knownMap = createMemo(() => props.maps.some((map) => map.mapPath === props.mapPath));
	const customSelected = createMemo(
		() => props.allowCustomPath === true && (customOpen() || !knownMap())
	);
	return (
		<div {...stylex.props(styles.picker)}>
			<label>
				<span {...stylex.props(styles.label)}>{props.label ?? "SAVED MAP"}</span>
				<select
					aria-label={props.ariaLabel ?? "Saved map"}
					disabled={props.disabled || (props.maps.length === 0 && !props.allowCustomPath)}
					value={customSelected() ? "__custom__" : props.mapPath}
					onChange={(event) => {
						if (event.currentTarget.value === "__custom__") {
							setCustomOpen(true);
							return;
						}
						setCustomOpen(false);
						props.onMapPathChange(event.currentTarget.value);
					}}
					{...stylex.props(styles.select)}
				>
					<For each={props.maps}>
						{(map) => (
							<option value={map.mapPath} selected={map.mapPath === props.mapPath}>
								{map.label}
							</option>
						)}
					</For>
					{props.allowCustomPath ? (
						<option value="__custom__">CUSTOM MAP PATH…</option>
					) : null}
					{props.maps.length === 0 ? <option value="">NO SAVED MAPS</option> : null}
				</select>
			</label>
			<Show when={customSelected()}>
				<label {...stylex.props(styles.customPath)}>
					<span>MAP PATH</span>
					<input
						aria-label="Custom map path"
						disabled={props.disabled}
						value={props.mapPath}
						onInput={(event) => props.onMapPathChange(event.currentTarget.value)}
						placeholder="Content/Maps/L_MyMap.umap"
						{...stylex.props(styles.customInput)}
					/>
				</label>
			</Show>
		</div>
	);
}

const styles = stylex.create({
	picker: {
		display: "grid",
		gap: 5,
		minWidth: 180,
		color: "#9aa8a8",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".12em"
	},
	label: { display: "block" },
	select: {
		minWidth: 180,
		boxSizing: "border-box",
		border: "1px solid #445155",
		backgroundColor: "#0a0e0f",
		color: "#e2e8e4",
		padding: "9px 10px",
		fontFamily: "monospace",
		fontSize: 11,
		outline: { default: "none", ":focus": "1px solid #73c7d0" },
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		opacity: { default: 1, ":disabled": 0.55 }
	},
	customPath: { display: "grid", gap: 5, color: "#879294", fontSize: 8, letterSpacing: ".1em" },
	customInput: {
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid #445155",
		backgroundColor: "#0a0e0f",
		color: "#e2e8e4",
		padding: "8px 9px",
		fontFamily: "monospace",
		fontSize: 10,
		outline: { default: "none", ":focus": "1px solid #e1b85e" }
	}
});
