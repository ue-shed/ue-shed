import * as stylex from "@stylexjs/stylex";
import { Portal } from "@solidjs/web";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Show, createUniqueId, onSettled } from "solid-js";
import type { ProjectLaunchFailure } from "../shared/project-workspace-contract.js";

export function ProjectLaunchError(props: {
	readonly failure: typeof ProjectLaunchFailure.Type;
	readonly onClose: () => void;
}) {
	let dialog: HTMLDialogElement | undefined;
	const title = createUniqueId();
	const description = createUniqueId();
	onSettled(() => {
		dialog?.showModal();
		return () => {
			if (dialog?.open) dialog.close();
		};
	});
	return (
		<Portal>
			<dialog
				ref={dialog}
				aria-labelledby={title}
				aria-describedby={description}
				onCancel={(event) => {
					event.preventDefault();
					props.onClose();
				}}
				{...stylex.attrs(styles.dialog)}
			>
				<h2 id={title} {...stylex.attrs(styles.title)}>
					Unreal couldn’t start
				</h2>
				<p id={description}>{props.failure.message}</p>
				<h3 {...stylex.attrs(styles.subtitle)}>What to do next</h3>
				<p>{props.failure.recovery}</p>
				<Show when={props.failure.details}>
					<details>
						<summary {...stylex.attrs(styles.summary)}>Technical details</summary>
						<pre {...stylex.attrs(styles.details)}>{props.failure.details}</pre>
					</details>
				</Show>
				<div {...stylex.attrs(styles.actions)}>
					<button type="button" onClick={props.onClose} {...stylex.attrs(styles.button)}>
						Close
					</button>
				</div>
			</dialog>
		</Portal>
	);
}

const styles = stylex.create({
	dialog: {
		width: "min(640px, calc(100vw - 32px))",
		maxHeight: "calc(100dvh - 48px)",
		boxSizing: "border-box",
		overflowY: "auto",
		overflowWrap: "anywhere",
		margin: "auto",
		padding: 24,
		borderRadius: tokens.radiusPanel,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 14,
		lineHeight: 1.6,
		boxShadow: tokens.shadowOverlay
	},
	title: { marginTop: 0, fontSize: 22, color: tokens.colorTextStrong },
	subtitle: { marginBottom: 0, fontSize: 15, color: tokens.colorTextStrong },
	summary: { cursor: "pointer", color: tokens.colorTextMuted },
	details: {
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere",
		fontFamily: tokens.fontMono,
		fontSize: 12
	},
	actions: { display: "flex", justifyContent: "flex-end", marginTop: 24 },
	button: {
		backgroundColor: tokens.colorAccent,
		color: tokens.colorSurface,
		borderWidth: 0,
		borderRadius: tokens.radiusControl,
		padding: "8px 20px",
		cursor: "pointer",
		fontWeight: 600
	}
});
