import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createUniqueId, onSettled, Show } from "solid-js";
import { Portal } from "@solidjs/web";

export interface TaskProgress {
	readonly cacheHits?: number;
	readonly completed: number;
	readonly phase: "idle" | "enumerating" | "scanning" | "ready" | "failed";
	readonly stage: "project_index" | "texture_audit" | "game_text";
	readonly total: number;
}

export interface TaskProgressModalProps {
	readonly detail: string;
	readonly open: boolean;
	readonly progress: TaskProgress;
	readonly title: string;
}

function stageLabel(progress: TaskProgress): string {
	if (progress.stage === "project_index") {
		return progress.phase === "enumerating" ? "Discovering saved packages" : "Indexing project";
	}
	if (progress.stage === "texture_audit") return "Inspecting texture packages";
	return "Inspecting text-bearing packages";
}

export function TaskProgressModal(props: TaskProgressModalProps) {
	return (
		<Show when={props.open}>
			<OpenTaskProgressModal {...props} />
		</Show>
	);
}

function OpenTaskProgressModal(props: TaskProgressModalProps) {
	let dialogElement: HTMLDialogElement | undefined;
	onSettled(() => {
		const dialog = dialogElement;
		dialog?.showModal();
		return () => dialog?.close();
	});
	const titleId = createUniqueId();
	const detailId = createUniqueId();
	const determinate = () => props.progress.total > 0;
	const percent = () =>
		determinate()
			? Math.min(100, Math.round((props.progress.completed / props.progress.total) * 100))
			: 0;
	const count = () =>
		determinate()
			? `${props.progress.completed.toLocaleString()} / ${props.progress.total.toLocaleString()}`
			: "Preparing…";

	return (
		<Portal>
			<dialog
				ref={(dialog) => {
					dialogElement = dialog;
				}}
				onCancel={(event) => event.preventDefault()}
				aria-labelledby={titleId}
				aria-describedby={detailId}
				aria-busy="true"
				{...stylex.attrs(styles.backdrop)}
			>
				<section tabindex={-1} {...stylex.attrs(styles.modal)}>
					<p {...stylex.attrs(styles.kicker)}>{stageLabel(props.progress)}</p>
					<h2 id={titleId} {...stylex.attrs(styles.title)}>
						{props.title}
					</h2>
					<p id={detailId} {...stylex.attrs(styles.detail)}>
						{props.detail}
					</p>
					<div
						role="progressbar"
						aria-label={stageLabel(props.progress)}
						aria-valuemin={determinate() ? 0 : undefined}
						aria-valuemax={determinate() ? props.progress.total : undefined}
						aria-valuenow={determinate() ? props.progress.completed : undefined}
						{...stylex.attrs(styles.track)}
					>
						<span
							{...(determinate()
								? stylex.attrs(styles.fill)
								: stylex.attrs(styles.fill, styles.fillIndeterminate))}
							style={determinate() ? { width: `${percent()}%` } : undefined}
						/>
					</div>
					<div {...stylex.attrs(styles.readout)}>
						<strong {...stylex.attrs(styles.readoutValue)}>
							{determinate() ? `${percent()}%` : "SCANNING"}
						</strong>
						<span>{determinate() ? `${count()} packages` : count()}</span>
						<Show when={(props.progress.cacheHits ?? 0) > 0}>
							<small {...stylex.attrs(styles.cacheHits)}>
								{props.progress.cacheHits} cache hits
							</small>
						</Show>
					</div>
					<p {...stylex.attrs(styles.locked)}>
						Workbench controls are paused until this operation finishes.
					</p>
				</section>
			</dialog>
		</Portal>
	);
}

const styles = stylex.create({
	backdrop: {
		position: "fixed",
		inset: 0,
		margin: 0,
		borderWidth: 0,
		width: "100%",
		height: "100%",
		maxWidth: "none",
		maxHeight: "none",
		boxSizing: "border-box",
		overflowY: "auto",
		display: "grid",
		placeItems: "center",
		padding: tokens.space5,
		backgroundColor: "rgba(8, 9, 10, 0.72)",
		backdropFilter: "blur(8px)"
	},
	modal: {
		width: "min(520px, calc(100vw - 48px))",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPanel,
		padding: "26px 28px 22px",
		backgroundColor: tokens.colorSurface,
		boxShadow: `${tokens.shadowOverlay}, ${tokens.shadowCard}`,
		color: tokens.colorText
	},
	kicker: {
		margin: 0,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	title: {
		margin: "10px 0 8px",
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 20,
		fontWeight: 590,
		letterSpacing: "-0.012em",
		lineHeight: 1.3
	},
	detail: {
		maxWidth: 440,
		margin: 0,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontBody,
		fontSize: 13,
		lineHeight: 1.6
	},
	track: {
		position: "relative",
		height: 4,
		marginTop: tokens.space4,
		overflow: "hidden",
		borderRadius: tokens.radiusPill,
		backgroundColor: "rgba(255, 255, 255, 0.06)"
	},
	fill: {
		display: "block",
		height: "100%",
		borderRadius: "inherit",
		backgroundColor: tokens.colorAccent,
		transitionDuration: tokens.motionStandard,
		transitionProperty: "width",
		transitionTimingFunction: "ease-out"
	},
	fillIndeterminate: {
		width: "32%",
		animationName: stylex.keyframes({
			from: { transform: "translateX(-110%)" },
			to: { transform: "translateX(320%)" }
		}),
		animationDuration: "1200ms",
		animationIterationCount: "infinite",
		animationTimingFunction: "ease-in-out"
	},
	readout: {
		display: "grid",
		gridTemplateColumns: "auto 1fr auto",
		alignItems: "baseline",
		gap: tokens.space3,
		marginTop: tokens.space2,
		fontFamily: tokens.fontBody,
		fontSize: 12,
		color: tokens.colorTextMuted
	},
	readoutValue: { color: tokens.colorTextStrong, fontSize: 12 },
	cacheHits: { color: tokens.colorTextSubtle, fontSize: 11 },
	locked: {
		margin: "20px 0 0",
		paddingTop: tokens.space3,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontBody,
		fontSize: 11,
		lineHeight: 1.5
	}
});
