import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createSignal } from "solid-js";

type FieldTone = "neutral" | "x" | "y" | "z";

function clamp(value: number, minimum: number | undefined, maximum: number | undefined): number {
	return Math.min(
		maximum ?? Number.POSITIVE_INFINITY,
		Math.max(minimum ?? Number.NEGATIVE_INFINITY, value)
	);
}

function normalized(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function displayValue(value: number | undefined): number | "" {
	if (value === undefined) return "";
	return Math.round(value * 1_000) / 1_000;
}

function modifierScale(event: Pick<PointerEvent | KeyboardEvent, "altKey" | "shiftKey">): number {
	if (event.shiftKey) return 10;
	if (event.altKey) return 0.1;
	return 1;
}

export function ScrubbableNumberField(props: {
	readonly label: string;
	readonly max?: number | undefined;
	readonly min?: number | undefined;
	readonly onClear?: (() => void) | undefined;
	readonly onClearCommit?: (() => void) | undefined;
	readonly onValueCommit?: ((value: number) => void) | undefined;
	readonly onValueChange: (value: number) => void;
	readonly placeholder?: string | undefined;
	readonly scrubOrigin?: number | undefined;
	readonly scrubStep?: number | undefined;
	readonly step?: number | undefined;
	readonly tone?: FieldTone | undefined;
	readonly unit?: string | undefined;
	readonly value?: number | undefined;
	readonly wide?: boolean | undefined;
}) {
	const [scrubbing, setScrubbing] = createSignal(false);
	const [editing, setEditing] = createSignal(false);
	let scrub:
		| {
				readonly pointerId: number;
				lastX: number;
				value: number;
		  }
		| undefined;
	const inputStep = () => props.step ?? 0.1;
	const scrubStep = () => props.scrubStep ?? inputStep();
	const nextValue = (value: number) => normalized(clamp(value, props.min, props.max));
	const emit = (value: number) => props.onValueChange(nextValue(value));
	const commit = (value: number) => props.onValueCommit?.(nextValue(value));
	const adjust = (direction: -1 | 1, event: KeyboardEvent) => {
		const value =
			(props.value ?? props.scrubOrigin ?? 0) +
			direction * scrubStep() * modifierScale(event);
		emit(value);
		commit(value);
	};
	const toneStyle = () => {
		switch (props.tone) {
			case "x":
				return styles.axisX;
			case "y":
				return styles.axisY;
			case "z":
				return styles.axisZ;
			default:
				return styles.neutral;
		}
	};

	return (
		<label
			{...stylex.props(
				styles.field,
				toneStyle(),
				props.wide && styles.wide,
				scrubbing() && styles.scrubbing
			)}
		>
			<span {...stylex.props(styles.fieldHeader)}>
				<button
					type="button"
					aria-label={`Drag ${props.label} to adjust`}
					title="Drag horizontally · Shift for coarse · Alt for fine"
					onKeyDown={(event) => {
						if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
						event.preventDefault();
						adjust(event.key === "ArrowLeft" ? -1 : 1, event);
					}}
					onPointerDown={(event) => {
						if (event.button !== 0) return;
						event.preventDefault();
						scrub = {
							lastX: event.clientX,
							pointerId: event.pointerId,
							value: props.value ?? props.scrubOrigin ?? 0
						};
						event.currentTarget.setPointerCapture?.(event.pointerId);
						setScrubbing(true);
					}}
					onPointerMove={(event) => {
						if (scrub === undefined || scrub.pointerId !== event.pointerId) return;
						const delta = event.clientX - scrub.lastX;
						if (delta === 0) return;
						scrub.lastX = event.clientX;
						scrub.value = normalized(
							clamp(
								scrub.value + delta * scrubStep() * modifierScale(event),
								props.min,
								props.max
							)
						);
						emit(scrub.value);
					}}
					onPointerUp={(event) => {
						if (scrub?.pointerId !== event.pointerId) return;
						const value = scrub.value;
						event.currentTarget.releasePointerCapture?.(event.pointerId);
						scrub = undefined;
						setScrubbing(false);
						commit(value);
					}}
					onPointerCancel={() => {
						const value = scrub?.value;
						scrub = undefined;
						setScrubbing(false);
						if (value !== undefined) commit(value);
					}}
					{...stylex.props(styles.scrubHandle)}
				>
					<span>{props.label}</span>
					<span aria-hidden="true" {...stylex.props(styles.dragGlyph)}>
						↔
					</span>
				</button>
				{props.unit === undefined ? null : (
					<span {...stylex.props(styles.unit)}>{props.unit}</span>
				)}
			</span>
			<input
				type="number"
				aria-label={props.label}
				value={editing() ? (props.value ?? "") : displayValue(props.value)}
				min={props.min}
				max={props.max}
				step={inputStep()}
				placeholder={props.placeholder}
				onFocus={() => setEditing(true)}
				onBlur={() => setEditing(false)}
				onInput={(event) => {
					if (event.currentTarget.value === "") {
						props.onClear?.();
						return;
					}
					const value = Number(event.currentTarget.value);
					if (Number.isFinite(value)) emit(value);
				}}
				onChange={(event) => {
					if (event.currentTarget.value === "") {
						props.onClearCommit?.();
						return;
					}
					const value = Number(event.currentTarget.value);
					if (Number.isFinite(value)) commit(value);
				}}
				{...stylex.props(styles.input)}
			/>
		</label>
	);
}

const styles = stylex.create({
	field: {
		display: "grid",
		gridTemplateColumns: "minmax(86px, auto) minmax(72px, 1fr)",
		alignItems: "center",
		gap: 10,
		minWidth: 0,
		padding: "8px 10px",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderLeftWidth: 2,
		backgroundColor: tokens.colorSurfaceInset,
		transition:
			"border-color 120ms cubic-bezier(0.23, 1, 0.32, 1), background-color 120ms cubic-bezier(0.23, 1, 0.32, 1)"
	},
	neutral: { borderLeftColor: tokens.colorTextSubtle },
	wide: { gridColumn: "1 / -1" },
	axisX: { borderLeftColor: "#eb5757" },
	axisY: { borderLeftColor: "#4cb782" },
	axisZ: { borderLeftColor: "#6366f1" },
	scrubbing: {
		borderColor: tokens.colorAccent,
		backgroundColor: tokens.colorAccentWash
	},
	fieldHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
		minWidth: 0
	},
	scrubHandle: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		minWidth: 0,
		padding: 0,
		borderStyle: "none",
		borderWidth: 0,
		backgroundColor: "transparent",
		color: {
			default: tokens.colorTextMuted,
			":hover": tokens.colorTextStrong,
			":focus-visible": tokens.colorAccent
		},
		fontFamily: "inherit",
		fontSize: 11,
		fontWeight: 500,
		letterSpacing: 0,
		cursor: "ew-resize",
		userSelect: "none",
		outlineColor: { default: "transparent", ":focus-visible": tokens.colorTextMuted },
		outlineOffset: 2,
		outlineStyle: "solid",
		outlineWidth: 1,
		transition: "color 120ms ease, transform 120ms cubic-bezier(0.23, 1, 0.32, 1)",
		transform: { default: "scale(1)", ":active": "scale(.97)" }
	},
	dragGlyph: { color: tokens.colorTextSubtle, fontSize: 11, letterSpacing: 0 },
	unit: { color: tokens.colorTextSubtle, fontSize: 11, letterSpacing: 0 },
	input: {
		width: "100%",
		boxSizing: "border-box",
		borderStyle: "none",
		borderWidth: 0,
		borderLeftColor: tokens.colorBorder,
		borderLeftStyle: "solid",
		borderLeftWidth: 1,
		backgroundColor: "transparent",
		color: tokens.colorTextStrong,
		padding: "4px 2px 4px 10px",
		fontFamily: "inherit",
		fontSize: 13,
		fontVariantNumeric: "tabular-nums",
		textAlign: "right",
		appearance: "textfield",
		outlineColor: { default: "transparent", ":focus-visible": tokens.colorTextMuted },
		outlineOffset: 2,
		outlineStyle: "solid",
		outlineWidth: 1
	}
});
