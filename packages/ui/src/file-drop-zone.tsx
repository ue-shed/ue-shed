import * as stylex from "@stylexjs/stylex";
import { Button } from "./button.js";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createSignal, onSettled, For, Show } from "solid-js";

export const MAX_ASSET_FILE_BYTES = 64 * 1024 * 1024;

export interface FileDropZoneProps {
	readonly compact: boolean;
	readonly loading: boolean;
	readonly label: string;
	readonly pickerLabel: string;
	readonly dropLabel: string;
	readonly invalidFileCopy: string;
	readonly onOpen: (file: File) => void;
	readonly sampleGroupLabel?: string;
	readonly samples?: readonly { readonly label: string; readonly open: () => void }[];
}

export function FileDropZone(props: FileDropZoneProps) {
	const onOpen = props.onOpen;
	const invalidFileCopy = props.invalidFileCopy;
	const samples = props.samples ?? [];
	const [message, setMessage] = createSignal("");
	const [dragging, setDragging] = createSignal(false);
	const [pickerFocused, setPickerFocused] = createSignal(false);
	let picker: HTMLInputElement | undefined;

	const openPicker = () => {
		if (!props.loading) picker?.click();
	};

	const openFile = (file: File) => {
		if (file.size > MAX_ASSET_FILE_BYTES) {
			setMessage("This file is too large. Choose a .uasset of up to 64 MiB.");
			return;
		}
		if (!file.name.toLowerCase().endsWith(".uasset")) {
			setMessage(invalidFileCopy);
			return;
		}
		setMessage("");
		onOpen(file);
	};

	// Listen on the document while mounted, but handle only drops inside this viewer's main.
	// This also covers the export navigator and detail after the opener moves into the summary row.
	onSettled(() => {
		const insideViewer = (event: DragEvent) =>
			event.target instanceof Node && picker?.closest("main")?.contains(event.target);
		const dragOver = (event: DragEvent) => {
			if (!insideViewer(event) || !event.dataTransfer?.types.includes("Files")) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
			setDragging(true);
		};
		const drop = (event: DragEvent) => {
			if (!insideViewer(event)) return;
			event.preventDefault();
			setDragging(false);
			const file = event.dataTransfer?.files[0];
			if (file !== undefined) openFile(file);
		};
		const dragLeave = (event: DragEvent) => {
			if (!insideViewer(event)) return;
			if (
				event.relatedTarget instanceof Node &&
				picker?.closest("main")?.contains(event.relatedTarget)
			) {
				return;
			}
			setDragging(false);
		};
		const dragEnd = () => setDragging(false);
		document.addEventListener("dragover", dragOver);
		document.addEventListener("drop", drop);
		document.addEventListener("dragleave", dragLeave);
		document.addEventListener("dragend", dragEnd);
		return () => {
			document.removeEventListener("dragover", dragOver);
			document.removeEventListener("drop", drop);
			document.removeEventListener("dragleave", dragLeave);
			document.removeEventListener("dragend", dragEnd);
		};
	});

	return (
		<div
			aria-label={props.label}
			onClick={(event) => {
				if (props.compact) return;
				if (
					event.target instanceof Element &&
					event.target.closest("button, input, select") !== null
				) {
					return;
				}
				openPicker();
			}}
			role="group"
			{...stylex.attrs(
				styles.opener,
				props.compact ? styles.compact : styles.dropZone,
				!props.compact && dragging() && styles.dragging,
				pickerFocused() && styles.focused
			)}
		>
			<input
				accept=".uasset"
				aria-label={props.pickerLabel}
				disabled={props.loading}
				onBlur={() => setPickerFocused(false)}
				onChange={(event) => {
					const file = event.currentTarget.files?.[0];
					event.currentTarget.value = "";
					if (file !== undefined) openFile(file);
				}}
				onFocus={() => setPickerFocused(true)}
				ref={(element) => {
					picker = element;
				}}
				type="file"
				{...stylex.attrs(styles.hiddenInput)}
			/>
			<Show when={!props.compact}>
				<span aria-hidden="true" {...stylex.attrs(styles.glyph)}>
					⇧
				</span>
				<strong {...stylex.attrs(styles.title)}>
					{dragging() ? "Drop to open" : props.dropLabel}
				</strong>
				<div {...stylex.attrs(styles.actions)}>
					<Button
						disabled={props.loading}
						onClick={openPicker}
						tone="primary"
						type="button"
					>
						Choose a .uasset
					</Button>
					<Show when={samples.length > 0}>
						<div
							role="group"
							aria-label={props.sampleGroupLabel ?? "Try a sample asset"}
							{...stylex.attrs(styles.samples)}
						>
							<Show when={props.sampleGroupLabel !== undefined}>
								<span {...stylex.attrs(styles.sampleLabel)}>Try a sample</span>
							</Show>
							<For each={samples}>
								{(sample) => (
									<Button
										disabled={props.loading}
										onClick={() => {
											setMessage("");
											sample.open();
										}}
										tone="secondary"
										type="button"
									>
										{sample.label}
									</Button>
								)}
							</For>
						</div>
					</Show>
				</div>
				<p {...stylex.attrs(styles.copy)}>
					Decoded locally on your machine. Your file is never uploaded. Up to 64 MiB.
				</p>
			</Show>
			<Show when={props.compact}>
				<Button disabled={props.loading} onClick={openPicker} type="button">
					Open another .uasset
				</Button>
			</Show>
			<Show when={message()}>
				<p role="alert" {...stylex.attrs(styles.error)}>
					{message()}
				</p>
			</Show>
		</div>
	);
}

const styles = stylex.create({
	samples: {
		alignItems: "center",
		display: "flex",
		flexWrap: "wrap",
		gap: 6,
		justifyContent: "center"
	},
	sampleLabel: { color: tokens.colorTextSubtle, fontSize: 12, marginRight: 4 },
	opener: { minWidth: 0, position: "relative" },
	dropZone: {
		alignContent: "center",
		backgroundColor: { default: tokens.colorSurface, ":hover": tokens.colorSurfaceHover },
		borderColor: { default: tokens.colorBorderInteractive, ":hover": tokens.colorAccent },
		borderRadius: tokens.radiusPanel,
		borderStyle: "dashed",
		borderWidth: 1,
		cursor: "pointer",
		display: "grid",
		gap: 14,
		justifyItems: "center",
		marginTop: 16,
		minHeight: 220,
		padding: { default: "28px 32px", "@media (max-width: 899px)": "24px 20px" },
		textAlign: "center"
	},
	compact: { display: "grid", gap: 6, flexShrink: 0 },
	dragging: {
		backgroundColor: tokens.colorSurfaceRaised,
		borderColor: tokens.colorAccent,
		borderStyle: "solid"
	},
	focused: {
		outlineColor: tokens.colorAccent,
		outlineOffset: 3,
		outlineStyle: "solid",
		outlineWidth: 2
	},
	glyph: { color: tokens.colorAccent, fontSize: 28, lineHeight: 1 },
	title: { color: tokens.colorTextStrong, fontSize: 16 },
	copy: {
		color: tokens.colorTextSubtle,
		fontSize: 12,
		lineHeight: 1.6,
		margin: 0,
		maxWidth: 520
	},
	actions: {
		alignItems: "center",
		display: "flex",
		flexWrap: "wrap",
		gap: 12,
		justifyContent: "center"
	},
	hiddenInput: {
		// Clipping hides the native control while retaining its label and keyboard focus.
		borderWidth: 0,
		clipPath: "inset(50%)",
		height: 1,
		margin: -1,
		overflow: "hidden",
		padding: 0,
		position: "absolute",
		whiteSpace: "nowrap",
		width: 1
	},
	error: { color: tokens.colorWarning, fontSize: 12, margin: 0, maxWidth: 280 }
});
