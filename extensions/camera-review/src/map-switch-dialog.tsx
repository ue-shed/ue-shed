import * as stylex from "@stylexjs/stylex";
import { Portal } from "@solidjs/web";
import { Button } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createUniqueId, onSettled, Show } from "solid-js";

/** Native modal owns focus, Escape and focus restoration; switching always requires a choice. */
export function MapSwitchDialog(props: {
	readonly currentMap?: string | undefined;
	readonly targetMap: string;
	readonly busy: boolean;
	readonly error?: string | undefined;
	readonly onConfirm: () => void;
	readonly onCancel: () => void;
	readonly onBrowseOnly?: (() => void) | undefined;
}) {
	let dialog: HTMLDialogElement | undefined;
	const title = createUniqueId();
	onSettled(() => {
		dialog?.showModal();
		return () => dialog?.close();
	});
	return (
		<Portal>
			<dialog
				ref={(element) => {
					dialog = element;
				}}
				aria-labelledby={title}
				onCancel={(event) => {
					event.preventDefault();
					if (!props.busy) props.onCancel();
				}}
				{...stylex.attrs(styles.dialog)}
			>
				<h2 id={title}>Switch the map in Unreal?</h2>
				<p>
					This review uses a different map. Open it in Unreal to edit cameras or capture
					views.
				</p>
				<dl {...stylex.attrs(styles.maps)}>
					<dt>Open in Unreal</dt>
					<dd>{props.currentMap ?? "Not confirmed"}</dd>
					<dt>Switch to</dt>
					<dd>{props.targetMap}</dd>
				</dl>
				<p>
					Unsaved changes are never discarded. Save them in Unreal and stop Play /
					Simulate before switching.
				</p>
				<Show when={props.busy}>
					<p role="status">
						Opening map in Unreal… Large maps can take several minutes. Waiting does not
						resend the command.
					</p>
				</Show>
				<Show when={props.error}>
					<p role="alert">{props.error}</p>
				</Show>
				<div {...stylex.attrs(styles.actions)}>
					<Button onClick={props.onCancel} disabled={props.busy}>
						Cancel
					</Button>
					<Show when={props.onBrowseOnly}>
						<Button onClick={props.onBrowseOnly} disabled={props.busy}>
							Browse saved review only
						</Button>
					</Show>
					<Button tone="primary" onClick={props.onConfirm} disabled={props.busy}>
						{props.busy ? "Opening…" : "Switch map"}
					</Button>
				</div>
			</dialog>
		</Portal>
	);
}

const styles = stylex.create({
	dialog: {
		width: "min(580px, 90vw)",
		padding: 24,
		color: tokens.colorText,
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		fontFamily: tokens.fontBody,
		boxShadow: tokens.shadowOverlay
	},
	maps: {
		display: "grid",
		gridTemplateColumns: "110px minmax(0, 1fr)",
		gap: 12,
		overflowWrap: "anywhere"
	},
	actions: {
		display: "flex",
		flexWrap: "wrap",
		justifyContent: "flex-end",
		gap: 8,
		marginTop: 24
	}
});
