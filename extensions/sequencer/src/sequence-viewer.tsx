import * as stylex from "@stylexjs/stylex";
import type { JSX } from "@solidjs/web";
import { Button, createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import type { Effect } from "effect";
import { createMemo, createSignal, For, Show, onSettled } from "solid-js";
import type { SequenceReadResult, SequenceReadFailure } from "./contract.js";
import { SectionInspector } from "./section-inspector.js";
import { sequenceStats, sectionFrames, displayFrameScale } from "./sequence-summary.js";
import { SequenceTimeline } from "./sequence-timeline.js";
import { frameRateLabel, playbackLabel } from "./sequence-presentation.js";

export type SequenceReadEffect = Effect.Effect<SequenceReadResult, unknown>;
export type ReadySequenceRead = Extract<SequenceReadResult, { readonly status: "ready" }>;

export interface SequenceOpenerControls {
	readonly open: (read: SequenceReadEffect) => void;
	readonly loading: boolean;
	readonly hasSequence: boolean;
	readonly observeSourceBusy: (read: () => boolean) => void;
}
export interface SequenceFooterControls {
	readonly open: (read: SequenceReadEffect) => void;
	readonly reveal: (objectPath: string) => void;
}
export interface SequenceTransportFailureCopy {
	readonly title: string;
	readonly message: string;
	readonly recovery: string;
}
export interface SequenceViewerProps {
	readonly opener: (controls: SequenceOpenerControls) => JSX.Element;
	readonly initialRead?: SequenceReadEffect | undefined;
	readonly footer?: (read: ReadySequenceRead, controls: SequenceFooterControls) => JSX.Element;
	readonly failureActions?: (failure: SequenceReadFailure) => JSX.Element;
	readonly transportFailureCopy?: SequenceTransportFailureCopy;
}

const leaf = (path: string) => path.split(/[.:]/).at(-1) ?? path;

export function SequenceViewer(props: SequenceViewerProps) {
	const initialRead = props.initialRead;
	const action = createEffectAction();
	const [result, setResult] = createSignal<SequenceReadResult>();
	const [loading, setLoading] = createSignal(false);
	const [transportFailed, setTransportFailed] = createSignal(false);
	const [message, setMessage] = createSignal("");
	const [selected, setSelected] = createSignal<string>();
	const [zoom, setZoom] = createSignal(1);
	let sourceBusy: () => boolean = () => false;
	const ready = createMemo(() => {
		const value = result();
		return value?.status === "ready" ? value : undefined;
	});
	const failure = createMemo(() => {
		const value = result();
		return value?.status === "failed" ? value : undefined;
	});
	const groups = createMemo(() => {
		const value = ready()?.sequence;
		return value === undefined
			? []
			: [
					{ id: "root", name: "Root", tracks: value.root_tracks },
					...value.bindings.map((binding) => ({
						id: binding.id,
						name: binding.name ?? binding.id,
						tracks: binding.tracks
					}))
				];
	});
	const tracks = createMemo(() => groups().flatMap((group) => group.tracks));
	const stats = createMemo(() => {
		const read = ready();
		return read === undefined ? undefined : sequenceStats(read.sequence);
	});
	const section = createMemo(() =>
		tracks()
			.flatMap((track) => track.sections)
			.find((item) => item.object_path === selected())
	);
	const extent = createMemo(() => {
		let min = 0;
		let max = 1;
		const expand = (frame: number) => {
			min = Math.min(min, frame);
			max = Math.max(max, frame);
		};
		for (const track of tracks()) {
			for (const item of track.sections) {
				if (item.range?.lower.kind !== "open" && item.range) expand(item.range.lower.frame);
				if (item.range?.upper.kind !== "open" && item.range) expand(item.range.upper.frame);
				for (const frame of sectionFrames(item)) expand(frame);
			}
		}
		const playback = ready()?.sequence.playback_range;
		if (playback?.lower.kind !== "open" && playback) expand(playback.lower.frame);
		if (playback?.upper.kind !== "open" && playback) expand(playback.upper.frame);
		return { min, max };
	});
	const visibleGroups = createMemo(() => {
		let remaining = 200;
		return groups()
			.slice(0, 201)
			.map((group) => {
				const visible = group.tracks.slice(0, remaining);
				remaining -= visible.length;
				return { ...group, tracks: visible };
			});
	});
	const markers = createMemo(() => {
		let remaining = 2000;
		const values = new Map<string, readonly number[]>();
		for (const group of visibleGroups()) {
			for (const track of group.tracks) {
				for (const item of track.sections.slice(0, 200)) {
					const frames = sectionFrames(item, remaining);
					values.set(item.object_path, frames);
					remaining -= frames.length;
				}
			}
		}
		return { values, limited: remaining === 0 };
	});
	const trackLimitReached = createMemo(
		() =>
			tracks().length > 200 ||
			groups().length > 201 ||
			tracks().some((track) => track.sections.length > 200)
	);
	const coverageCopy = createMemo(() => {
		const read = ready();
		if (read === undefined) return "";
		const gaps =
			read.sequence.coverage_gaps.length +
			read.sequence.reference_coverage_gaps.length +
			read.diagnostics.length;
		return read.outcome === "complete" ? "Fully decoded" : `Partial · ${gaps}`;
	});
	const frameRateCopy = createMemo(() => {
		const rate = ready()?.sequence.display_rate;
		return frameRateLabel(rate ?? null);
	});
	const frameRateTitle = createMemo(() => {
		const rate = ready()?.sequence.display_rate;
		return rate && rate.denominator !== 1
			? `${rate.numerator}/${rate.denominator} fps`
			: undefined;
	});
	const frameScale = createMemo(() => {
		const read = ready();
		return read === undefined ? 1 : displayFrameScale(read.sequence);
	});
	const playbackCopy = createMemo(() => {
		const value = ready()?.sequence;
		return value === undefined ? "" : playbackLabel(value);
	});
	const open = (read: SequenceReadEffect) => {
		setLoading(true);
		setTransportFailed(false);
		setMessage("");
		action.run(read, {
			onSuccess: (value) => {
				setLoading(false);
				if (value.status === "cancelled") {
					setMessage("Open cancelled.");
					return;
				}
				setResult(value);
				setSelected(undefined);
				setZoom(1);
			},
			onFailure: () => {
				setLoading(false);
				setTransportFailed(true);
			}
		});
	};
	const reveal = (path: string) => {
		const found =
			tracks()
				.flatMap((track) => track.sections)
				.find((item) => item.object_path === path) ??
			tracks().find((track) => track.object_path === path)?.sections[0];
		setSelected(found?.object_path);
		setMessage(found ? "" : `Internal reference: ${path}. No section projection is available.`);
	};
	const opener = props.opener({
		open,
		get loading() {
			return loading();
		},
		get hasSequence() {
			return ready() !== undefined;
		},
		observeSourceBusy: (read) => {
			sourceBusy = read;
		}
	});
	const transportCopy = props.transportFailureCopy ?? {
		title: "The sequence request failed",
		message: "The host could not finish reading the saved sequence.",
		recovery: "Retry the request. Unreal does not need to be running."
	};
	onSettled(() => {
		if (initialRead !== undefined) open(initialRead);
	});
	return (
		<main
			aria-busy={loading() || sourceBusy() ? "true" : "false"}
			{...stylex.attrs(styles.page)}
		>
			<header {...stylex.attrs(styles.header)}>
				<div {...stylex.attrs(styles.titleBlock)}>
					<h1 {...stylex.attrs(styles.pageTitle)}>Sequencer</h1>
					<p {...stylex.attrs(styles.intro)}>
						Explore a Level Sequence's saved tracks, sections and keys on a timeline,
						decoded from package bytes without an editor.
					</p>
				</div>
				<span {...stylex.attrs(styles.scopeStamp)}>Read-only · no Unreal required</span>
			</header>
			<section
				aria-label="Sequence coverage"
				{...stylex.attrs(styles.summary, !ready() && styles.emptySummary)}
			>
				<Show when={ready()}>
					{(read) => (
						<>
							<h2 {...stylex.attrs(styles.title)}>
								{leaf(read().sequence.object_path)}
							</h2>
							<span
								{...stylex.attrs(
									styles.chip,
									read().outcome !== "complete" && styles.chipPartial
								)}
							>
								<i
									aria-hidden="true"
									{...stylex.attrs(
										styles.coverageDot,
										read().outcome !== "complete" && styles.coverageDotPartial
									)}
								/>
								{coverageCopy()}
							</span>
						</>
					)}
				</Show>
				{opener}
				<Show when={stats()}>
					{(value) => (
						<span {...stylex.attrs(styles.quiet)}>
							{value().tracks} tracks · {value().bindings} bindings ·{" "}
							{value().sections} sections · {value().keys} keys
						</span>
					)}
				</Show>
				<Show when={ready()}>
					<span title={frameRateTitle()} {...stylex.attrs(styles.quiet)}>
						{frameRateCopy()} · {playbackCopy()}
					</span>
				</Show>
			</section>
			<Show when={loading()}>
				<p role="status">Reading saved sequence…</p>
			</Show>
			<Show when={message()}>
				<p role="status">{message()}</p>
			</Show>
			<Show when={transportFailed()}>
				<div role="alert" {...stylex.attrs(styles.panel)}>
					<strong>{transportCopy.title}</strong>
					<p>{transportCopy.message}</p>
					<p>{transportCopy.recovery}</p>
				</div>
			</Show>
			<Show when={failure()}>
				{(value) => (
					<div role="alert" {...stylex.attrs(styles.panel)}>
						<strong>The saved sequence could not be read</strong>
						<p>{value().message}</p>
						<p>{value().recovery}</p>
						{props.failureActions?.(value())}
					</div>
				)}
			</Show>
			<Show when={ready()}>
				{(read) => (
					<>
						<div
							{...stylex.attrs(
								styles.body,
								section() !== undefined && styles.bodyInspector
							)}
						>
							<section aria-label="Saved timeline" {...stylex.attrs(styles.panel)}>
								<div {...stylex.attrs(styles.toolbar)}>
									<span>Timeline</span>
									<label {...stylex.attrs(styles.zoomControl)}>
										Zoom{" "}
										<input
											aria-label="Timeline zoom"
											type="range"
											min="1"
											max="4"
											step="0.25"
											value={zoom()}
											{...stylex.attrs(styles.zoomSlider)}
											onInput={(event) =>
												setZoom(Number(event.currentTarget.value))
											}
										/>
									</label>
									<output {...stylex.attrs(styles.zoomOutput)}>
										{Math.round(zoom() * 100)}%
									</output>
									<Button tone="quiet" onClick={() => setZoom(1)} type="button">
										<span {...stylex.attrs(styles.fitLabel)}>Fit</span>
									</Button>
								</div>
								<Show when={section() === undefined}>
									<p {...stylex.attrs(styles.quiet)}>
										Select a section to inspect its saved values.
									</p>
								</Show>
								<SequenceTimeline
									groups={visibleGroups()}
									markers={markers().values}
									min={extent().min}
									max={extent().max}
									frameScale={frameScale()}
									zoom={zoom()}
									playbackRange={read().sequence.playback_range}
									selected={selected()}
									onSelect={setSelected}
								/>
								<Show when={tracks().length === 0}>
									<p>No tracks were decoded. Check coverage details.</p>
								</Show>
								<Show when={trackLimitReached()}>
									<p>
										Showing the first 200 tracks and sections per track. Use the
										CLI for the full inventory.
									</p>
								</Show>
								<Show when={markers().limited}>
									<p>Timeline shows up to 2,000 key markers.</p>
								</Show>
							</section>
							<Show when={section()}>
								{(value) => <SectionInspector section={value()} />}
							</Show>
						</div>
						<details {...stylex.attrs(styles.quiet)}>
							<summary>Coverage details</summary>
							<p>
								Saved keys and ranges; interpolation, playback and blending are not
								evaluated.
							</p>
							<For each={read().sequence.coverage_gaps}>
								{(gap) => (
									<p>
										{gap.property_path}: {gap.reason.replaceAll("_", " ")}
									</p>
								)}
							</For>
							<For each={read().sequence.reference_coverage_gaps}>
								{(gap) => (
									<p>
										{gap.property_path}: {gap.reason.replaceAll("_", " ")}
									</p>
								)}
							</For>
							<For each={read().diagnostics}>
								{(diagnostic) => <p>{diagnostic.message}</p>}
							</For>
						</details>
						{props.footer?.(read(), { open, reveal })}
					</>
				)}
			</Show>
		</main>
	);
}

const styles = stylex.create({
	page: {
		padding: { default: "24px 28px", "@media (max-width: 899px)": "20px 16px" },
		boxSizing: "border-box",
		minWidth: 0,
		maxWidth: "100%",
		overflowWrap: "anywhere",
		display: "grid",
		gap: 16,
		color: tokens.colorText,
		fontFamily: tokens.fontBody
	},
	header: {
		display: "flex",
		flexWrap: { default: "nowrap", "@media (max-width: 899px)": "wrap" },
		alignItems: "baseline",
		justifyContent: "space-between",
		gap: { default: 30, "@media (max-width: 899px)": 4 },
		paddingBottom: 16
	},
	titleBlock: { minWidth: 0 },
	pageTitle: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 24,
		fontWeight: 590,
		letterSpacing: "-0.02em"
	},
	intro: { margin: "4px 0 0", color: tokens.colorTextMuted, fontSize: 13, lineHeight: 1.5 },
	scopeStamp: { flexShrink: 0, color: tokens.colorTextSubtle, fontSize: 12 },
	summary: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, minWidth: 0 },
	emptySummary: { display: "block", width: "100%" },
	title: { margin: 0, fontSize: 16, color: tokens.colorTextStrong, overflowWrap: "anywhere" },
	quiet: { color: tokens.colorTextMuted, fontSize: 12, lineHeight: 1.6, margin: 0 },
	chip: {
		display: "inline-flex",
		alignItems: "center",
		gap: 7,
		flexShrink: 0,
		padding: "4px 10px",
		borderRadius: tokens.radiusPill,
		backgroundColor: "rgba(76,183,130,.1)",
		color: tokens.colorSuccess,
		fontSize: 12,
		fontWeight: 510,
		whiteSpace: "nowrap"
	},
	chipPartial: { backgroundColor: "rgba(242,153,74,.1)", color: tokens.colorWarning },
	coverageDot: { width: 6, height: 6, borderRadius: "50%", backgroundColor: tokens.colorSuccess },
	coverageDotPartial: { backgroundColor: tokens.colorWarning },
	toolbar: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: 10,
		minWidth: 0,
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	zoomControl: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 },
	zoomSlider: {
		accentColor: tokens.colorAccent,
		width: { default: 120, "@media (max-width: 599px)": 90 },
		margin: 0,
		cursor: "pointer"
	},
	zoomOutput: { minWidth: 38, fontSize: 12, fontVariantNumeric: "tabular-nums" },
	fitLabel: { fontSize: 12 },
	body: {
		display: "grid",
		gap: 16,
		minWidth: 0,
		alignItems: "start",
		gridTemplateColumns: "minmax(0, 1fr)"
	},
	bodyInspector: {
		gridTemplateColumns: {
			default: "minmax(0, 1fr) minmax(260px, 340px)",
			"@media (max-width: 899px)": "minmax(0, 1fr)"
		}
	},
	panel: {
		padding: 12,
		minWidth: 0,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurfaceInset
	}
});
