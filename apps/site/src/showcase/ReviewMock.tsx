import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createSignal } from "solid-js";
import { WindowFrame } from "./WindowFrame.js";

function CaptureScene(props: { readonly variant: "before" | "after" }) {
	const after = () => props.variant === "after";
	return (
		<svg
			viewBox="0 0 640 300"
			preserveAspectRatio="xMidYMid slice"
			role="img"
			aria-label={`Capture run ${props.variant}`}
			{...stylex.props(styles.scene)}
		>
			<rect width="640" height="300" fill="#0c0f0d" />
			<circle
				cx={after() ? 505 : 470}
				cy={after() ? 96 : 62}
				r="22"
				fill="#b7e26d"
				opacity="0.85"
			/>
			<rect y="196" width="640" height="104" fill="#111412" />
			<line x1="0" y1="196" x2="640" y2="196" stroke="#2c332e" stroke-width="1.5" />
			<line x1="80" y1="196" x2="40" y2="300" stroke="#202720" stroke-width="1" />
			<line x1="240" y1="196" x2="220" y2="300" stroke="#202720" stroke-width="1" />
			<line x1="400" y1="196" x2="420" y2="300" stroke="#202720" stroke-width="1" />
			<line x1="560" y1="196" x2="600" y2="300" stroke="#202720" stroke-width="1" />
			<rect
				x={after() ? 108 : 88}
				y="152"
				width="48"
				height="44"
				fill="#202720"
				stroke="#39413b"
			/>
			<rect x="176" y="136" width="48" height="60" fill="#202720" stroke="#39413b" />
			<rect x="176" y="100" width="48" height="36" fill="#202720" stroke="#39413b" />
			{after() && (
				<rect x="268" y="152" width="48" height="44" fill="#202720" stroke="#39413b" />
			)}
			<line x1="420" y1="196" x2="420" y2="118" stroke="#39413b" stroke-width="4" />
			<circle cx="420" cy="112" r="7" fill={after() ? "#d6a363" : "#303632"} />
			<text x="18" y="30" fill="#59615b" font-family="monospace" font-size="12">
				{after() ? "Run 012 · approved" : "Run 011 · approved"}
			</text>
		</svg>
	);
}

export function ReviewMock() {
	const [split, setSplit] = createSignal(50);

	return (
		<WindowFrame title="Map Review — L_FixtureReview" badge="illustration">
			<div {...stylex.props(styles.stage)}>
				<CaptureScene variant="before" />
				<div
					{...stylex.props(styles.afterLayer)}
					style={{ "clip-path": `inset(0 ${100 - split()}% 0 0)` }}
				>
					<CaptureScene variant="after" />
				</div>
				<div {...stylex.props(styles.divider)} style={{ left: `${split()}%` }} />
				<span {...stylex.props(styles.tagBefore)}>run 011</span>
				<span {...stylex.props(styles.tagAfter)}>run 012</span>
			</div>
			<div {...stylex.props(styles.controls)}>
				<input
					type="range"
					min="0"
					max="100"
					value={split()}
					aria-label="Compare capture runs"
					onInput={(event) => setSplit(Number(event.currentTarget.value))}
					{...stylex.props(styles.slider)}
				/>
			</div>
			<div {...stylex.props(styles.footer)}>
				<span {...stylex.props(styles.chip)}>immutable runs</span>
				<span {...stylex.props(styles.chip)}>1280×720</span>
				<span {...stylex.props(styles.chip)}>approved set</span>
				<span {...stylex.props(styles.footerNote)}>
					Drag to compare. Captures come from a live editor; the scene here is drawn, not
					recorded.
				</span>
			</div>
		</WindowFrame>
	);
}

const styles = stylex.create({
	scene: {
		display: "block",
		height: "100%",
		width: "100%"
	},
	stage: {
		aspectRatio: "64 / 30",
		position: "relative",
		userSelect: "none"
	},
	afterLayer: {
		inset: 0,
		position: "absolute"
	},
	divider: {
		backgroundColor: tokens.colorAccent,
		bottom: 0,
		position: "absolute",
		top: 0,
		width: 2
	},
	tagBefore: {
		backgroundColor: tokens.colorCanvasTranslucent,
		borderRadius: tokens.radiusControl,
		bottom: 10,
		color: tokens.colorTextMuted,
		fontSize: 9,
		left: 10,
		letterSpacing: ".12em",
		padding: "3px 8px",
		position: "absolute",
		textTransform: "uppercase"
	},
	tagAfter: {
		backgroundColor: tokens.colorCanvasTranslucent,
		borderRadius: tokens.radiusControl,
		bottom: 10,
		color: tokens.colorTextMuted,
		fontSize: 9,
		letterSpacing: ".12em",
		padding: "3px 8px",
		position: "absolute",
		right: 10,
		textTransform: "uppercase"
	},
	controls: {
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		padding: "10px 12px"
	},
	slider: {
		accentColor: tokens.colorAccent,
		display: "block",
		width: "100%"
	},
	footer: {
		alignItems: "center",
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		display: "flex",
		flexWrap: "wrap",
		gap: 8,
		padding: "8px 12px"
	},
	chip: {
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 9,
		letterSpacing: ".08em",
		padding: "3px 8px"
	},
	footerNote: {
		color: tokens.colorTextFaint,
		fontSize: 10,
		marginLeft: "auto"
	}
});
