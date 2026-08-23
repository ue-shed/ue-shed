import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Show } from "solid-js";

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
		<Show when={props.open}>
			<div {...stylex.props(styles.backdrop)}>
				<section
					role="dialog"
					aria-modal="true"
					aria-labelledby="task-progress-title"
					aria-describedby="task-progress-detail"
					aria-busy="true"
					{...stylex.props(styles.modal)}
				>
					<p {...stylex.props(styles.kicker)}>{stageLabel(props.progress)}</p>
					<h2 id="task-progress-title" {...stylex.props(styles.title)}>
						{props.title}
					</h2>
					<p id="task-progress-detail" {...stylex.props(styles.detail)}>
						{props.detail}
					</p>
					<div
						role="progressbar"
						aria-label={stageLabel(props.progress)}
						aria-valuemin={determinate() ? 0 : undefined}
						aria-valuemax={determinate() ? props.progress.total : undefined}
						aria-valuenow={determinate() ? props.progress.completed : undefined}
						{...stylex.props(styles.track)}
					>
						<span
							{...(determinate()
								? stylex.props(styles.fill)
								: stylex.props(styles.fill, styles.fillIndeterminate))}
							style={determinate() ? { width: `${percent()}%` } : undefined}
						/>
					</div>
					<div {...stylex.props(styles.readout)}>
						<strong {...stylex.props(styles.readoutValue)}>
							{determinate() ? `${percent()}%` : "SCANNING"}
						</strong>
						<span>{determinate() ? `${count()} packages` : count()}</span>
						<Show when={(props.progress.cacheHits ?? 0) > 0}>
							<small {...stylex.props(styles.cacheHits)}>
								{props.progress.cacheHits} cache hits
							</small>
						</Show>
					</div>
					<p {...stylex.props(styles.locked)}>
						Workbench controls are paused until this operation finishes.
					</p>
				</section>
			</div>
		</Show>
	);
}

const styles = stylex.create({
	backdrop: {
		position: "fixed",
		inset: 0,
		zIndex: 1000,
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
