import * as stylex from "@stylexjs/stylex";
import type { SequenceRange, SequenceSection, SequenceTrack } from "@ue-shed/protocol";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createMemo, For, Show } from "solid-js";
import { frameRangeTitle, objectName, shortSequenceType } from "./sequence-presentation.js";
import { sectionKeyCount } from "./sequence-summary.js";

interface TimelineGroup {
	readonly name: string;
	readonly tracks: readonly SequenceTrack[];
}

interface SequenceTimelineProps {
	readonly groups: readonly TimelineGroup[];
	readonly markers: ReadonlyMap<string, readonly number[]>;
	readonly min: number;
	readonly max: number;
	readonly frameScale: number;
	readonly zoom: number;
	readonly playbackRange: SequenceRange | null;
	readonly selected: string | undefined;
	readonly onSelect: (path: string) => void;
}

function markerPosition(frame: number, lower: number, upper: number): string {
	const fraction = (frame - lower) / Math.max(1, upper - lower);
	return `left:calc(${fraction * 100}% + ${4 - fraction * 8}px)`;
}

function tickPosition(fraction: number): string {
	return `left:${fraction * 100}%;transform:translateX(-${fraction * 100}%)`;
}

function trackTitle(owner: string, track: SequenceTrack): string {
	return [
		`${owner} · ${track.property_path ?? objectName(track.class_path)}`,
		track.class_path,
		track.object_path
	].join("\n");
}

export function SequenceTimeline(props: SequenceTimelineProps) {
	const onSelect = props.onSelect;
	const percent = (frame: number) => ((frame - props.min) / (props.max - props.min)) * 100;
	const playbackStyle = createMemo(() => {
		const range = props.playbackRange;
		const lower = range && range.lower.kind !== "open" ? range.lower.frame : props.min;
		const upper = range && range.upper.kind !== "open" ? range.upper.frame : props.max;
		return `left:${percent(lower)}%;width:${Math.max(0, percent(upper) - percent(lower))}%`;
	});
	return (
		<div {...stylex.attrs(styles.scroll)}>
			<div style={`--sequencer-zoom:${props.zoom}`} {...stylex.attrs(styles.timeline)}>
				<div
					role="img"
					aria-label="Saved sequence tracks and sections"
					{...stylex.attrs(styles.row, styles.ruler)}
				>
					<span {...stylex.attrs(styles.labelCell, styles.rulerLabel)}>Frame</span>
					<div {...stylex.attrs(styles.lane)}>
						<For each={[0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]}>
							{(fraction) => (
								<span style={tickPosition(fraction)} {...stylex.attrs(styles.tick)}>
									{Math.round(
										(props.min + fraction * (props.max - props.min)) *
											props.frameScale
									)}
									<span aria-hidden="true" {...stylex.attrs(styles.tickLine)} />
								</span>
							)}
						</For>
					</div>
				</div>
				<div role="list" aria-label="Sections">
					<For each={props.groups}>
						{(group) => (
							<Show
								when={group.tracks.length > 0}
								fallback={
									<div
										role="group"
										aria-label={group.name}
										{...stylex.attrs(styles.emptyBinding)}
									>
										<span
											title={group.name}
											{...stylex.attrs(styles.bindingName)}
										>
											{group.name}
										</span>
										<span {...stylex.attrs(styles.noTracks)}>no tracks</span>
									</div>
								}
							>
								<details open {...stylex.attrs(styles.group)}>
									<summary {...stylex.attrs(styles.groupTitle)}>
										{group.name} · {group.tracks.length} tracks
									</summary>
									<For each={group.tracks}>
										{(track) => (
											<TrackRow
												owner={group.name}
												track={track}
												min={props.min}
												max={props.max}
												selected={props.selected}
												markers={props.markers}
												playbackStyle={playbackStyle()}
												onSelect={onSelect}
											/>
										)}
									</For>
								</details>
							</Show>
						)}
					</For>
				</div>
			</div>
		</div>
	);
}

function TrackRow(props: {
	readonly owner: string;
	readonly track: SequenceTrack;
	readonly min: number;
	readonly max: number;
	readonly selected: string | undefined;
	readonly markers: ReadonlyMap<string, readonly number[]>;
	readonly playbackStyle: string;
	readonly onSelect: (path: string) => void;
}) {
	const onSelect = props.onSelect;
	return (
		<div role="listitem" {...stylex.attrs(styles.row)}>
			<span {...stylex.attrs(styles.visuallyHidden)}>
				{props.owner} · {props.track.property_path ?? objectName(props.track.class_path)}
			</span>
			<span
				aria-hidden="true"
				title={trackTitle(props.owner, props.track)}
				{...stylex.attrs(styles.labelCell)}
			>
				<span {...stylex.attrs(styles.trackName)}>
					{props.track.property_path ||
						shortSequenceType(props.track.class_path, "Track")}
				</span>
			</span>
			<div {...stylex.attrs(styles.lane)}>
				<div
					aria-hidden="true"
					style={props.playbackStyle}
					{...stylex.attrs(styles.playback)}
				/>
				<For each={props.track.sections.slice(0, 200)}>
					{(section) => (
						<SectionBar
							section={section}
							min={props.min}
							max={props.max}
							selected={props.selected}
							frames={props.markers.get(section.object_path) ?? []}
							onSelect={onSelect}
						/>
					)}
				</For>
			</div>
		</div>
	);
}

function SectionBar(props: {
	readonly section: SequenceSection;
	readonly min: number;
	readonly max: number;
	readonly selected: string | undefined;
	readonly frames: readonly number[];
	readonly onSelect: (path: string) => void;
}) {
	const onSelect = props.onSelect;
	const selected = createMemo(() => props.selected === props.section.object_path);
	const bounds = createMemo(() => {
		const range = props.section.range;
		return {
			lower: range && range.lower.kind !== "open" ? range.lower.frame : props.min,
			upper: range && range.upper.kind !== "open" ? range.upper.frame : props.max
		};
	});
	const position = createMemo(() => {
		const { lower, upper } = bounds();
		const left = ((lower - props.min) / (props.max - props.min)) * 100;
		const width = (Math.max(0, upper - lower) / (props.max - props.min)) * 100;
		// Four pixels around the saved range keep diamonds at its edges fully inside the bar.
		return `left:calc(${left}% - 4px);width:calc(${width}% + 8px)`;
	});
	const label = createMemo(() => {
		const type = shortSequenceType(props.section.class_path, "Section");
		const count = sectionKeyCount(props.section);
		return count === 0 ? type : `${type} · ${count} ${count === 1 ? "key" : "keys"}`;
	});
	return (
		<button
			data-sequence-section=""
			type="button"
			aria-label={objectName(props.section.object_path)}
			title={`${props.section.object_path}\n${frameRangeTitle(props.section.range)}`}
			onClick={() => onSelect(props.section.object_path)}
			aria-pressed={selected() ? "true" : "false"}
			style={position()}
			{...stylex.attrs(styles.bar, selected() && styles.selected)}
		>
			<span aria-hidden="true" {...stylex.attrs(styles.barText)}>
				{label()}
			</span>
			<For each={props.frames}>
				{(frame) => (
					<span
						aria-hidden="true"
						style={markerPosition(frame, bounds().lower, bounds().upper)}
						{...stylex.attrs(styles.marker)}
					/>
				)}
			</For>
		</button>
	);
}

const styles = stylex.create({
	scroll: { overflow: "auto", maxHeight: 600, maxWidth: "100%", marginTop: 12 },
	timeline: {
		position: "relative",
		width: {
			// The fixed part includes the label cell and eight pixels at each lane edge.
			default: "calc(180px + (100% - 180px) * var(--sequencer-zoom))",
			"@media (max-width: 599px)": "calc(136px + (100% - 136px) * var(--sequencer-zoom))"
		}
	},
	row: {
		display: "grid",
		gridTemplateColumns: {
			default: "164px minmax(0, 1fr)",
			"@media (max-width: 599px)": "120px minmax(0, 1fr)"
		},
		height: 44,
		minWidth: 0,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	lane: { position: "relative", minWidth: 0, marginInline: 8 },
	labelCell: {
		position: "sticky",
		left: 0,
		display: "flex",
		alignItems: "center",
		minWidth: 0,
		padding: "0 8px",
		backgroundColor: tokens.colorSurfaceInset,
		fontSize: 11,
		zIndex: 2,
		boxSizing: "border-box"
	},
	trackName: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
	ruler: { height: 32, color: tokens.colorTextMuted },
	rulerLabel: { color: tokens.colorTextSubtle },
	tick: { position: "absolute", top: 4, fontSize: 10, whiteSpace: "nowrap" },
	tickLine: {
		position: "absolute",
		top: 16,
		height: 12,
		left: "50%",
		borderLeftWidth: 1,
		borderLeftStyle: "solid",
		borderLeftColor: tokens.colorBorder
	},
	playback: {
		position: "absolute",
		top: 0,
		bottom: 0,
		backgroundColor: tokens.colorAccent,
		opacity: 0.08,
		pointerEvents: "none"
	},
	group: { position: "relative" },
	groupTitle: {
		position: "sticky",
		left: 0,
		width: "fit-content",
		maxWidth: "100%",
		height: 32,
		boxSizing: "border-box",
		padding: "0 8px",
		lineHeight: "32px",
		fontSize: 11,
		color: tokens.colorTextMuted,
		backgroundColor: tokens.colorSurfaceInset,
		cursor: "pointer",
		whiteSpace: "nowrap",
		zIndex: 3
	},
	emptyBinding: {
		position: "sticky",
		left: 0,
		width: "fit-content",
		maxWidth: "100%",
		height: 32,
		display: "flex",
		alignItems: "center",
		gap: 8,
		padding: "0 8px",
		boxSizing: "border-box",
		fontSize: 11,
		color: tokens.colorTextMuted,
		backgroundColor: tokens.colorSurfaceInset
	},
	bindingName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
	noTracks: { color: tokens.colorTextSubtle, flexShrink: 0, fontSize: 10 },
	bar: {
		position: "absolute",
		top: 7,
		height: 30,
		minWidth: 12,
		boxSizing: "border-box",
		overflow: "hidden",
		padding: 0,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorText,
		textAlign: "left",
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 10
	},
	selected: {
		borderColor: tokens.colorAccent,
		outlineColor: tokens.colorAccent,
		outlineStyle: "solid",
		outlineWidth: 1
	},
	barText: {
		display: "block",
		position: "relative",
		zIndex: 1,
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
		padding: "0 5px",
		lineHeight: "16px"
	},
	marker: {
		position: "absolute",
		top: 20,
		width: 5,
		height: 5,
		transform: "translateX(-50%) rotate(45deg)",
		backgroundColor: tokens.colorAccent,
		pointerEvents: "none"
	},
	visuallyHidden: {
		position: "absolute",
		width: 1,
		height: 1,
		padding: 0,
		margin: -1,
		overflow: "hidden",
		clipPath: "inset(50%)",
		whiteSpace: "nowrap"
	}
});
