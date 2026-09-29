import * as stylex from "@stylexjs/stylex";
import type { SequenceNumericChannel, SequenceSection } from "@ue-shed/protocol";
import type { SavedReviewAsset } from "@ue-shed/unreal-assets/saved-review";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createMemo, createSignal, For, Show, onSettled } from "solid-js";
import type { SavedReviewInventory, SequenceReadResult } from "../shared/saved-review-contract.js";
import type { SavedReviewClient } from "./saved-review-client.js";
import type { WorkbenchRendererClient } from "./workbench-client.js";
import { SavedReviewPanel } from "./saved-review-panel.js";

const leaf = (path: string) => path.split(/[.:]/).at(-1) ?? path;
export function SequenceViewer(props: {
	readonly client: SavedReviewClient;
	readonly blueprintClient: Pick<WorkbenchRendererClient, "readBlueprint">;
	readonly initialAssetPath?: string | undefined;
	readonly onOpen: (asset: SavedReviewAsset) => void;
}) {
	const readAction = createEffectAction();
	const catalogAction = createEffectAction();
	const [path, setPath] = createSignal(props.initialAssetPath ?? "");
	const [query, setQuery] = createSignal("");
	const [result, setResult] = createSignal<SequenceReadResult>();
	const [inventory, setInventory] = createSignal<SavedReviewInventory>();
	const [loading, setLoading] = createSignal(false);
	const [message, setMessage] = createSignal("");
	const [selected, setSelected] = createSignal<string>();
	const [zoom, setZoom] = createSignal(1);
	const ready = createMemo(() => {
		const value = result();
		return value?.status === "ready" ? value : undefined;
	});
	const sequence = createMemo(() => ready()?.sequence);
	const failure = createMemo(() => {
		const value = result();
		return value?.status === "failed" ? value : undefined;
	});
	const tracks = createMemo(() => {
		const value = sequence();
		return value
			? [
					...value.root_tracks.map((track) => ({ owner: "Root", track })),
					...value.bindings.flatMap((binding) =>
						binding.tracks.map((track) => ({
							owner: binding.name ?? binding.id,
							track
						}))
					)
				]
			: [];
	});
	const visibleTracks = createMemo(() => tracks().slice(0, 200));
	const section = createMemo(() =>
		tracks()
			.flatMap(({ track }) => track.sections)
			.find((item) => item.object_path === selected())
	);
	const candidates = createMemo(() => {
		const value = inventory();
		return value?.status === "ready"
			? value.assets
					.filter(
						(asset) =>
							asset.kind === "level_sequence" &&
							asset.packageName.toLowerCase().includes(query().toLowerCase())
					)
					.slice(0, 50)
			: [];
	});
	const extent = createMemo(() => {
		let min = 0,
			max = 1;
		const expand = (frame: number | undefined) => {
			if (frame !== undefined) {
				min = Math.min(min, frame);
				max = Math.max(max, frame);
			}
		};
		for (const { track } of tracks())
			for (const item of track.sections) {
				if (item.range?.lower.kind !== "open") expand(item.range?.lower.frame);
				if (item.range?.upper.kind !== "open") expand(item.range?.upper.frame);
				for (const key of item.text_keys) expand(key.frame);
				for (const channel of item.numeric_channels)
					for (const key of channel.keys) expand(key.frame);
				for (const channel of item.discrete_channels)
					for (const key of channel.keys ?? []) expand(key.frame);
			}
		const range = sequence()?.playback_range;
		if (range?.lower.kind !== "open") expand(range?.lower.frame);
		if (range?.upper.kind !== "open") expand(range?.upper.frame);
		return { min, max: Math.max(max, min + 1) };
	});
	const markers = createMemo(() => {
		let remaining = 2000;
		const values = new Map<string, readonly number[]>();
		for (const { track } of visibleTracks())
			for (const item of track.sections.slice(0, 200)) {
				const frames = new Set<number>();
				if (remaining > 0) {
					for (const key of item.text_keys) {
						frames.add(key.frame);
						if (frames.size >= remaining) break;
					}
					for (const channel of [...item.numeric_channels, ...item.discrete_channels]) {
						if (frames.size >= remaining) break;
						for (const key of channel.keys ?? []) {
							frames.add(key.frame);
							if (frames.size >= remaining) break;
						}
					}
				}
				values.set(item.object_path, [...frames]);
				remaining -= frames.size;
			}
		return { values, limited: remaining === 0 };
	});
	const x = (frame: number) =>
		200 + ((frame - extent().min) / (extent().max - extent().min)) * 780;
	const formatFrame = (frame: number) => {
		const rate = sequence()?.tick_resolution;
		return rate && rate.numerator > 0
			? `${frame} · ${((frame * rate.denominator) / rate.numerator).toFixed(3)} s`
			: `${frame} ticks`;
	};
	const run = (effect: ReturnType<SavedReviewClient["readSequence"]>) => {
		setLoading(true);
		setMessage("");
		readAction.run(effect, {
			onSuccess: (value) => {
				setLoading(false);
				if (value.status === "cancelled") {
					setMessage("Open cancelled.");
					return;
				}
				setResult(value);
				setSelected(undefined);
				setZoom(1);
				if (value.status === "ready") setPath(value.assetPath);
			},
			onFailure: () => {
				setLoading(false);
				setResult(undefined);
				setMessage(
					"Sequence could not be read. Verify the file path and configured reader, then retry."
				);
			}
		});
	};
	const open = (asset: SavedReviewAsset) =>
		asset.kind === "level_sequence"
			? run(props.client.readSequence(asset.assetPath))
			: props.onOpen(asset);
	const loadInventory = () =>
		catalogAction.run(props.client.inventory(), {
			onSuccess: setInventory,
			onFailure: () =>
				setInventory({
					status: "failed",
					message: "Project inventory unavailable.",
					recovery: "Choose a project and refresh its index."
				})
		});
	onSettled(() => {
		loadInventory();
		if (props.initialAssetPath) run(props.client.readSequence(props.initialAssetPath));
	});
	return (
		<main {...stylex.attrs(styles.page)}>
			<header>
				<p {...stylex.attrs(styles.eyebrow)}>SAVED ASSET REVIEW</p>
				<h1>Sequencer</h1>
				<p>
					Inspect saved tracks, section ranges, keys and references. Times use the saved
					tick resolution; playback and blending are not evaluated.
				</p>
			</header>
			<section aria-label="Open sequence" {...stylex.attrs(styles.panel)}>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (path().trim()) run(props.client.readSequence(path().trim()));
					}}
					{...stylex.attrs(styles.toolbar)}
				>
					<label {...stylex.attrs(styles.grow)}>
						Sequence asset path
						<input
							aria-label="Sequence asset path"
							value={path()}
							onInput={(event) => setPath(event.currentTarget.value)}
							{...stylex.attrs(styles.input)}
						/>
					</label>
					<button
						type="submit"
						disabled={loading() || !path().trim()}
						{...stylex.attrs(styles.button)}
					>
						Open sequence
					</button>
					<button
						type="button"
						disabled={loading()}
						onClick={() => run(props.client.chooseSequence())}
						{...stylex.attrs(styles.button)}
					>
						Choose file
					</button>
				</form>
				<details>
					<summary>Sequences in the selected project</summary>
					<label>
						Filter sequences
						<input
							aria-label="Filter sequences"
							value={query()}
							onInput={(event) => setQuery(event.currentTarget.value)}
							{...stylex.attrs(styles.input)}
						/>
					</label>
					<button type="button" onClick={loadInventory} {...stylex.attrs(styles.button)}>
						Refresh list
					</button>
					<Show when={inventory()?.status === "failed"}>
						<p>
							Select a project and refresh its index to browse saved sequences.
							Opening a file works without a project.
						</p>
					</Show>
					<ul>
						<For each={candidates()}>
							{(asset) => (
								<li>
									<button
										type="button"
										{...stylex.attrs(styles.link)}
										onClick={() => open(asset)}
									>
										{asset.packageName}
									</button>
								</li>
							)}
						</For>
					</ul>
					<p>Up to 50 matches shown.</p>
				</details>
			</section>
			<Show when={loading()}>
				<p role="status">Reading saved sequence…</p>
			</Show>
			<Show when={message()}>
				<p role="status">{message()}</p>
			</Show>
			<Show when={failure()}>
				{(value) => (
					<p role="alert">
						{value().message} {value().recovery}
					</p>
				)}
			</Show>
			<Show when={ready()}>
				{(read) => (
					<>
						<section aria-label="Sequence coverage" {...stylex.attrs(styles.panel)}>
							<strong>
								{read().outcome === "partial"
									? "Partial saved evidence"
									: "Saved evidence decoded"}
							</strong>
							<code {...stylex.attrs(styles.path)}>
								{read().sequence.object_path}
							</code>
							<p>
								{tracks().length} tracks · {read().sequence.bindings.length}{" "}
								bindings · Display rate{" "}
								{read().sequence.display_rate
									? `${read().sequence.display_rate?.numerator}/${read().sequence.display_rate?.denominator} fps`
									: "not saved"}{" "}
								· Tick resolution{" "}
								{read().sequence.tick_resolution
									? `${read().sequence.tick_resolution?.numerator}/${read().sequence.tick_resolution?.denominator}`
									: "not saved"}
							</p>
							<details>
								<summary>Coverage details</summary>
								<ul>
									<For each={read().sequence.coverage_gaps}>
										{(gap) => (
											<li>
												{gap.object_path} · {gap.property_path}:{" "}
												{gap.reason.replaceAll("_", " ")}
											</li>
										)}
									</For>
									<For each={read().sequence.reference_coverage_gaps}>
										{(gap) => (
											<li>
												{gap.owner_path} · {gap.property_path}:{" "}
												{gap.reason.replaceAll("_", " ")}
											</li>
										)}
									</For>
									<For each={read().diagnostics}>
										{(item) => <li>{item.message}</li>}
									</For>
								</ul>
							</details>
						</section>
						<section aria-label="Saved timeline" {...stylex.attrs(styles.panel)}>
							<div {...stylex.attrs(styles.toolbar)}>
								<h2>Timeline</h2>
								<label>
									Zoom{" "}
									<input
										aria-label="Timeline zoom"
										type="range"
										min="1"
										max="4"
										step="0.25"
										value={zoom()}
										onInput={(event) =>
											setZoom(Number(event.currentTarget.value))
										}
									/>
								</label>
								<span>
									{formatFrame(extent().min)} — {formatFrame(extent().max)}
								</span>
							</div>
							<div {...stylex.attrs(styles.timeline)}>
								<svg
									role="img"
									aria-label="Saved sequence tracks and sections"
									viewBox={`0 0 1000 ${50 + visibleTracks().length * 58}`}
									width={1000 * zoom()}
									height={50 + visibleTracks().length * 58}
								>
									<For each={[0, 0.25, 0.5, 0.75, 1]}>
										{(fraction) => (
											<g>
												<line
													x1={200 + fraction * 780}
													x2={200 + fraction * 780}
													y1="24"
													y2={50 + visibleTracks().length * 58}
													stroke="currentColor"
													opacity="0.15"
												/>
												<text
													x={200 + fraction * 780}
													y="15"
													fill="currentColor"
													font-size="10"
													text-anchor={fraction === 1 ? "end" : "start"}
												>
													{Math.round(
														extent().min +
															fraction * (extent().max - extent().min)
													)}
												</text>
											</g>
										)}
									</For>
									<For each={visibleTracks()}>
										{({ owner, track }, index) => (
											<g>
												<text
													x="8"
													y={48 + index() * 58}
													fill="currentColor"
													font-size="11"
												>
													{owner.slice(0, 22)}
												</text>
												<text
													x="8"
													y={64 + index() * 58}
													fill="currentColor"
													font-size="10"
												>
													{(
														track.property_path ??
														leaf(track.class_path)
													).slice(0, 27)}
												</text>
												<For each={track.sections.slice(0, 200)}>
													{(item) => {
														const lower = () =>
															item.range &&
															item.range.lower.kind !== "open"
																? item.range.lower.frame
																: extent().min;
														const upper = () =>
															item.range &&
															item.range.upper.kind !== "open"
																? item.range.upper.frame
																: extent().max;
														return (
															<g
																role="button"
																tabindex="0"
																aria-label={`Inspect ${leaf(item.object_path)}`}
																onClick={() =>
																	setSelected(item.object_path)
																}
																onKeyDown={(event) => {
																	if (
																		event.key === "Enter" ||
																		event.key === " "
																	) {
																		event.preventDefault();
																		setSelected(
																			item.object_path
																		);
																	}
																}}
															>
																<title>
																	{item.object_path} ·{" "}
																	{track.content.replaceAll(
																		"_",
																		" "
																	)}
																</title>
																<rect
																	x={x(lower())}
																	y={32 + index() * 58}
																	width={Math.max(
																		3,
																		x(upper()) - x(lower())
																	)}
																	height="36"
																	rx="4"
																	fill={
																		selected() ===
																		item.object_path
																			? "#ab82f5"
																			: track.content ===
																				  "structure_only"
																				? "#6c7483"
																				: "#477b9c"
																	}
																	opacity="0.85"
																/>
																<For
																	each={
																		markers().values.get(
																			item.object_path
																		) ?? []
																	}
																>
																	{(frame) => (
																		<circle
																			cx={x(frame)}
																			cy={50 + index() * 58}
																			r="3"
																			fill="#ffffff"
																		/>
																	)}
																</For>
															</g>
														);
													}}
												</For>
											</g>
										)}
									</For>
								</svg>
							</div>
							<Show when={!tracks().length}>
								<p>
									No tracks were decoded. Check coverage details for missing
									evidence.
								</p>
							</Show>
							<Show
								when={
									tracks().length > 200 ||
									tracks().some(({ track }) => track.sections.length > 200)
								}
							>
								<p>
									Showing the first 200 tracks and sections per track. Use the CLI
									for the full saved inventory.
								</p>
							</Show>
							<Show when={markers().limited}>
								<p>
									Timeline shows up to 2,000 key markers. Select a section for its
									key values.
								</p>
							</Show>
							<ul aria-label="Sections">
								<For each={visibleTracks()}>
									{({ owner, track }) => (
										<li>
											<strong>
												{owner} ·{" "}
												{track.property_path ?? leaf(track.class_path)}
											</strong>{" "}
											· {track.content.replaceAll("_", " ")}
											<For each={track.sections.slice(0, 200)}>
												{(item) => (
													<button
														type="button"
														{...stylex.attrs(styles.button)}
														onClick={() =>
															setSelected(item.object_path)
														}
													>
														{leaf(item.object_path)}
													</button>
												)}
											</For>
										</li>
									)}
								</For>
							</ul>
						</section>
						<Show
							when={section()}
							fallback={<p>Select a section to inspect its saved values.</p>}
						>
							{(value) => <SectionInspector section={value()} />}
						</Show>
						<SavedReviewPanel
							review={{ kind: "level_sequence", read: read() }}
							client={props.client}
							blueprintClient={props.blueprintClient}
							onOpen={open}
							onInternal={(target) => {
								const track = tracks().find(
									(item) => item.track.object_path === target
								)?.track;
								const found =
									tracks()
										.flatMap((item) => item.track.sections)
										.find((item) => item.object_path === target) ??
									track?.sections[0];
								setSelected(found?.object_path);
								setMessage(
									found
										? ""
										: `Internal reference: ${target}. No section projection is available for this object.`
								);
							}}
						/>
					</>
				)}
			</Show>
		</main>
	);
}

function SectionInspector(props: { readonly section: SequenceSection }) {
	return (
		<section aria-label="Section inspector" {...stylex.attrs(styles.panel)}>
			<h2>{leaf(props.section.object_path)}</h2>
			<code {...stylex.attrs(styles.path)}>{props.section.class_path}</code>
			<p>
				Range:{" "}
				{props.section.range
					? `${props.section.range.lower.kind} ${props.section.range.lower.frame} → ${props.section.range.upper.kind} ${props.section.range.upper.frame}`
					: "not saved"}
			</p>
			<Show when={props.section.sequence_path}>
				<p>Sequence: {props.section.sequence_path}</p>
			</Show>
			<Show when={props.section.shot_display_name}>
				<p>Shot: {props.section.shot_display_name}</p>
			</Show>
			<For each={props.section.text_keys.slice(0, 200)}>
				{(key) => (
					<p>
						<code>{key.frame}</code> · {key.source}
					</p>
				)}
			</For>
			<Show
				when={
					props.section.numeric_channels.length > 64 ||
					props.section.discrete_channels.length > 64 ||
					props.section.text_keys.length > 200
				}
			>
				<p>
					Showing up to 64 channels and 200 text keys. Use the CLI for the full section.
				</p>
			</Show>
			<For each={props.section.numeric_channels.slice(0, 64)}>
				{(channel) => <ChannelInspector channel={channel} />}
			</For>
			<For each={props.section.discrete_channels.slice(0, 64)}>
				{(channel) => (
					<details open>
						<summary>
							{channel.property_path} · {channel.value_type} ·{" "}
							{channel.keys?.length ?? 0} saved keys
						</summary>
						<p>
							Saved default:{" "}
							{channel.default_value === null
								? "not serialized"
								: String(channel.default_value)}{" "}
							· Default enabled:{" "}
							{channel.has_default_value === null
								? "not serialized"
								: String(channel.has_default_value)}
						</p>
						<Show when={channel.enum_path}>
							<p>
								Enum: <code>{channel.enum_path}</code>
							</p>
						</Show>
						<p>
							Extrapolation before/after:{" "}
							{channel.pre_extrapolation ?? "not serialized"} /{" "}
							{channel.post_extrapolation ?? "not serialized"}
						</p>
						<Show when={channel.interpolate_linear_keys !== null}>
							<p>
								Saved linear interpolation flag:{" "}
								{String(channel.interpolate_linear_keys)}
							</p>
						</Show>
						<Show when={channel.externally_inverted !== null}>
							<p>
								Saved external inversion flag: {String(channel.externally_inverted)}
							</p>
						</Show>
						<Show when={channel.keys === null}>
							<p>
								Key arrays were not serialized or could not be decoded; see coverage
								details.
							</p>
						</Show>
						<For each={(channel.keys ?? []).slice(0, 200)}>
							{(key) => (
								<p>
									<code>{key.frame}</code> · {String(key.value)}
								</p>
							)}
						</For>
						<Show when={(channel.keys?.length ?? 0) > 200}>
							<p>Showing the first 200 keys. Use the CLI for the full channel.</p>
						</Show>
					</details>
				)}
			</For>
		</section>
	);
}
function ChannelInspector(props: { readonly channel: SequenceNumericChannel }) {
	const points = createMemo(() => {
		const keys = props.channel.keys;
		const minFrame = keys.reduce(
				(value, key) => Math.min(value, key.frame),
				keys[0]?.frame ?? 0
			),
			maxFrame = keys.reduce((value, key) => Math.max(value, key.frame), minFrame + 1);
		const minValue = keys.reduce(
				(value, key) => Math.min(value, key.value),
				keys[0]?.value ?? 0
			),
			maxValue = keys.reduce((value, key) => Math.max(value, key.value), minValue + 1);
		return keys.slice(0, 2000).map((key) => ({
			x: 20 + ((key.frame - minFrame) / Math.max(1, maxFrame - minFrame)) * 560,
			y: 140 - ((key.value - minValue) / Math.max(1e-12, maxValue - minValue)) * 120,
			key
		}));
	});
	return (
		<details open>
			<summary>
				{props.channel.property_path} · {props.channel.keys.length} keys ·{" "}
				{props.channel.enabled === null
					? "mask unknown"
					: props.channel.enabled
						? "enabled"
						: "disabled"}
			</summary>
			<p>
				Default: {props.channel.default_value ?? "not saved"} · Extrapolation before/after:{" "}
				{props.channel.pre_extrapolation}/{props.channel.post_extrapolation}
			</p>
			<svg
				viewBox="0 0 600 160"
				width="600"
				height="160"
				role="img"
				aria-label={`${props.channel.property_path} saved key values`}
			>
				<For each={points()}>
					{(point) => (
						<circle cx={point.x} cy={point.y} r="3" fill="#ab82f5">
							<title>
								{point.key.frame}: {point.key.value}
							</title>
						</circle>
					)}
				</For>
			</svg>
			<p>Saved key values; interpolation and blending are not evaluated.</p>
			<Show when={props.channel.keys.length > 200}>
				<p>Showing up to 2,000 points and 200 key rows. Use the CLI for all saved keys.</p>
			</Show>
			<div {...stylex.attrs(styles.timeline)}>
				<table {...stylex.attrs(styles.table)}>
					<thead>
						<tr>
							<th {...stylex.attrs(styles.cell)}>Tick</th>
							<th {...stylex.attrs(styles.cell)}>Value</th>
							<th {...stylex.attrs(styles.cell)}>Interpolation</th>
							<th {...stylex.attrs(styles.cell)}>Tangent mode</th>
							<th {...stylex.attrs(styles.cell)}>Arrive / leave tangent</th>
							<th {...stylex.attrs(styles.cell)}>Weight mode</th>
							<th {...stylex.attrs(styles.cell)}>Arrive / leave weight</th>
						</tr>
					</thead>
					<tbody>
						<For each={props.channel.keys.slice(0, 200)}>
							{(key) => (
								<tr>
									<td {...stylex.attrs(styles.cell)}>{key.frame}</td>
									<td {...stylex.attrs(styles.cell)}>{key.value}</td>
									<td {...stylex.attrs(styles.cell)}>
										{key.interpolation === 0
											? "Linear"
											: key.interpolation === 1
												? "Constant"
												: key.interpolation === 2
													? "Cubic"
													: `Unknown (${key.interpolation})`}
									</td>
									<td {...stylex.attrs(styles.cell)}>{key.tangent_mode}</td>
									<td {...stylex.attrs(styles.cell)}>
										{key.arrive_tangent} / {key.leave_tangent}
									</td>
									<td {...stylex.attrs(styles.cell)}>
										{key.tangent_weight_mode}
									</td>
									<td {...stylex.attrs(styles.cell)}>
										{key.arrive_tangent_weight} / {key.leave_tangent_weight}
									</td>
								</tr>
							)}
						</For>
					</tbody>
				</table>
			</div>
		</details>
	);
}

const styles = stylex.create({
	table: { borderCollapse: "collapse", fontSize: 12, width: "100%" },
	cell: {
		padding: "10px 12px",
		textAlign: "left",
		whiteSpace: "nowrap",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	page: {
		padding: 28,
		display: "grid",
		gap: 18,
		color: tokens.colorText,
		fontFamily: tokens.fontBody
	},
	eyebrow: { color: tokens.colorTextMuted, fontSize: 11, letterSpacing: 2 },
	panel: {
		padding: 18,
		display: "grid",
		gap: 12,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		minWidth: 0
	},
	toolbar: { display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" },
	grow: { flexGrow: 1 },
	input: {
		display: "block",
		width: "100%",
		minWidth: 180,
		padding: 9,
		color: tokens.colorText,
		backgroundColor: tokens.colorSurface,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl
	},
	button: {
		padding: "8px 12px",
		marginInlineEnd: 6,
		borderRadius: tokens.radiusControl,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		color: tokens.colorText,
		backgroundColor: tokens.colorSurface,
		cursor: "pointer"
	},
	link: {
		color: tokens.colorText,
		borderWidth: 0,
		backgroundColor: "transparent",
		cursor: "pointer",
		textAlign: "left",
		padding: 6
	},
	timeline: { overflow: "auto", maxHeight: 600 },
	path: { overflowWrap: "anywhere", fontFamily: tokens.fontMono, fontSize: 12 }
});
