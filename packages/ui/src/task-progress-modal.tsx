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
					<div {...stylex.props(styles.signal)} aria-hidden="true">
						<span {...stylex.props(styles.signalBar)} />
						<span {...stylex.props(styles.signalBar, styles.signalBarSecond)} />
						<span {...stylex.props(styles.signalBar, styles.signalBarThird)} />
					</div>
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
		backgroundColor: tokens.colorCanvasTranslucent,
		backdropFilter: "blur(7px)"
	},
	modal: {
		width: "min(560px, calc(100vw - 48px))",
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderTopColor: tokens.colorAccent,
		borderTopWidth: 3,
		borderRadius: tokens.radiusPanel,
		padding: "30px 32px 24px",
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: "0 28px 90px #00000090",
		color: tokens.colorText
	},
	signal: {
		display: "flex",
		alignItems: "center",
		gap: 4,
		height: 16,
		marginBottom: tokens.space4
	},
	signalBar: {
		width: 3,
		height: 14,
		backgroundColor: tokens.colorAccent,
		animationName: stylex.keyframes({
			"0%, 100%": { opacity: 0.28, transform: "scaleY(.45)" },
			"50%": { opacity: 1, transform: "scaleY(1)" }
		}),
		animationDuration: "900ms",
		animationIterationCount: "infinite",
		animationTimingFunction: "ease-in-out"
	},
	signalBarSecond: { animationDelay: "120ms" },
	signalBarThird: { animationDelay: "240ms" },
	kicker: {
		margin: 0,
		color: tokens.colorAccent,
		fontFamily: tokens.fontBody,
		fontSize: 9,
		letterSpacing: ".17em",
		textTransform: "uppercase"
	},
	title: {
		margin: "8px 0 10px",
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 28,
		fontWeight: 500,
		letterSpacing: "-.02em"
	},
	detail: {
		maxWidth: 440,
		margin: 0,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontBody,
		fontSize: 10,
		lineHeight: 1.65
	},
	track: {
		position: "relative",
		height: 8,
		marginTop: tokens.space5,
		overflow: "hidden",
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurfaceInset
	},
	fill: {
		display: "block",
		height: "100%",
		backgroundColor: tokens.colorAccent,
		boxShadow: "0 0 18px #b7e26d66",
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
		marginTop: tokens.space3,
		fontFamily: tokens.fontBody,
		fontSize: 9,
		color: tokens.colorTextMuted
	},
	readoutValue: { color: tokens.colorTextStrong, fontSize: 12 },
	cacheHits: { color: tokens.colorTextFaint, fontSize: 8 },
	locked: {
		margin: "22px 0 0",
		paddingTop: tokens.space3,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontBody,
		fontSize: 8,
		letterSpacing: ".08em",
		textTransform: "uppercase"
	}
});
