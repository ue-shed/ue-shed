import * as stylex from "@stylexjs/stylex";
import type { JSX } from "@solidjs/web";
import type {
	SequenceNumericChannel,
	SequenceNumericKey,
	SequenceSection,
	SequenceObjectValue,
	SequenceValueChannel
} from "@ue-shed/protocol";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createMemo, For, Show } from "solid-js";
import {
	frameRange,
	frameRangeTitle,
	objectName,
	shortSequenceType
} from "./sequence-presentation.js";

interface KeyRow {
	readonly frame: number;
	readonly value: string;
	readonly numeric?: SequenceNumericKey;
}

function objectValue(value: SequenceObjectValue | null): string {
	if (value === null) return "not serialized";
	const path = value.soft_path || value.hard_path;
	if (path) return path;
	return value.soft_path === "" ? "null object" : "reference not serialized or unavailable";
}

function valueKeyRows(channel: SequenceValueChannel): readonly KeyRow[] {
	return channel.value_type === "string"
		? (channel.keys ?? [])
				.slice(0, 200)
				.map((key) => ({ frame: key.frame, value: JSON.stringify(key.value) }))
		: (channel.keys ?? [])
				.slice(0, 200)
				.map((key) => ({ frame: key.frame, value: objectValue(key.value) }));
}

const savedFlag = (value: boolean | null) => (value === null ? "not serialized" : String(value));

export function SectionInspector(props: { readonly section: SequenceSection }) {
	return (
		<section aria-label="Section inspector" {...stylex.attrs(styles.panel)}>
			<header {...stylex.attrs(styles.header)}>
				<span title={props.section.class_path} {...stylex.attrs(styles.typeChip)}>
					{shortSequenceType(props.section.class_path, "Section")}
				</span>
				<h2 title={props.section.object_path} {...stylex.attrs(styles.title)}>
					{objectName(props.section.object_path)}
				</h2>
				<span title={frameRangeTitle(props.section.range)} {...stylex.attrs(styles.range)}>
					{frameRange(props.section.range)}
				</span>
			</header>
			<details {...stylex.attrs(styles.disclosure)}>
				<summary {...stylex.attrs(styles.summary)}>Saved section settings</summary>
				<dl {...stylex.attrs(styles.properties)}>
					<For each={Object.entries(props.section.settings)}>
						{([name, value]) => (
							<PropertyRow
								label={name.replaceAll("_", " ")}
								value={value === null ? "not serialized" : JSON.stringify(value)}
							/>
						)}
					</For>
				</dl>
			</details>
			<Show when={props.section.camera_cut}>
				{(cut) => (
					<section aria-label="Camera binding">
						<h3 {...stylex.attrs(styles.subheading)}>Camera binding</h3>
						<dl {...stylex.attrs(styles.properties)}>
							<PropertyRow
								label="GUID"
								value={cut().binding?.guid ?? "unavailable"}
							/>
							<PropertyRow
								label="Sequence ID"
								value={cut().binding?.sequence_id ?? "not serialized"}
							/>
							<PropertyRow
								label="Resolve parent index"
								value={cut().binding?.resolve_parent_index ?? "not serialized"}
							/>
							<PropertyRow
								label="Lock previous camera"
								value={savedFlag(cut().lock_previous_camera)}
							/>
						</dl>
					</section>
				)}
			</Show>
			<Show when={props.section.sequence_path || props.section.shot_display_name}>
				<dl {...stylex.attrs(styles.properties)}>
					<Show when={props.section.sequence_path}>
						<PropertyRow label="Sequence" value={props.section.sequence_path} />
					</Show>
					<Show when={props.section.shot_display_name}>
						<PropertyRow label="Shot" value={props.section.shot_display_name} />
					</Show>
				</dl>
			</Show>
			<Show when={props.section.text_keys.length > 0}>
				<KeysTable
					label="Text keys"
					rows={props.section.text_keys.slice(0, 200).map((key) => ({
						frame: key.frame,
						value: key.source
					}))}
				/>
			</Show>
			<Show
				when={
					props.section.numeric_channels.length > 64 ||
					props.section.discrete_channels.length > 64 ||
					props.section.value_channels.length > 64 ||
					props.section.text_keys.length > 200
				}
			>
				<p {...stylex.attrs(styles.note)}>
					Showing up to 64 channels and 200 text keys. Use the CLI for the full section.
				</p>
			</Show>
			<For each={props.section.numeric_channels.slice(0, 64)}>
				{(channel) => <ChannelInspector channel={channel} />}
			</For>
			<For each={props.section.value_channels.slice(0, 64)}>
				{(channel) => (
					<details open {...stylex.attrs(styles.disclosure)}>
						<summary {...stylex.attrs(styles.summary)}>
							{channel.property_path} · {channel.value_type} ·{" "}
							{channel.keys?.length ?? 0} saved keys
						</summary>
						<dl {...stylex.attrs(styles.properties)}>
							<PropertyRow
								label="Saved default"
								value={
									channel.value_type === "string"
										? channel.default_value === null
											? "not serialized"
											: JSON.stringify(channel.default_value)
										: objectValue(channel.default_value)
								}
							/>
							<Show
								when={
									channel.value_type === "object" ? channel.property_class : null
								}
							>
								{(path) => <PropertyRow label="Property class" value={path()} />}
							</Show>
							<Show when={channel.value_type === "string"}>
								<PropertyRow
									label="Default enabled"
									value={
										channel.value_type === "string"
											? savedFlag(channel.has_default_value)
											: "not serialized"
									}
								/>
							</Show>
						</dl>
						<KeysTable
							label={`${channel.property_path} saved keys`}
							rows={valueKeyRows(channel)}
						/>
						<KeyNotice count={channel.keys?.length ?? null} />
					</details>
				)}
			</For>
			<For each={props.section.discrete_channels.slice(0, 64)}>
				{(channel) => (
					<details open {...stylex.attrs(styles.disclosure)}>
						<summary {...stylex.attrs(styles.summary)}>
							{channel.property_path} · {channel.value_type} ·{" "}
							{channel.keys?.length ?? 0} saved keys
						</summary>
						<dl {...stylex.attrs(styles.properties)}>
							<PropertyRow
								label="Saved default"
								value={
									channel.default_value === null
										? "not serialized"
										: String(channel.default_value)
								}
							/>
							<PropertyRow
								label="Default enabled"
								value={savedFlag(channel.has_default_value)}
							/>
							<Show when={channel.enum_path}>
								<PropertyRow label="Enum" value={channel.enum_path} />
							</Show>
							<PropertyRow
								label="Extrapolation before/after"
								value={
									`${channel.pre_extrapolation ?? "not serialized"} / ` +
									`${channel.post_extrapolation ?? "not serialized"}`
								}
							/>
							<Show when={channel.interpolate_linear_keys !== null}>
								<PropertyRow
									label="Saved linear interpolation flag"
									value={String(channel.interpolate_linear_keys)}
								/>
							</Show>
							<Show when={channel.externally_inverted !== null}>
								<PropertyRow
									label="Saved external inversion flag"
									value={String(channel.externally_inverted)}
								/>
							</Show>
						</dl>
						<KeysTable
							label={`${channel.property_path} saved keys`}
							rows={(channel.keys ?? []).slice(0, 200).map((key) => ({
								frame: key.frame,
								value: String(key.value)
							}))}
						/>
						<KeyNotice count={channel.keys?.length ?? null} />
					</details>
				)}
			</For>
		</section>
	);
}

function PropertyRow(props: { readonly label: string; readonly value: JSX.Element }) {
	return (
		<div {...stylex.attrs(styles.propertyRow)}>
			<dt {...stylex.attrs(styles.propertyName)}>{props.label}: </dt>
			<dd {...stylex.attrs(styles.propertyValue)}>{props.value}</dd>
		</div>
	);
}

function KeysTable(props: { readonly label: string; readonly rows: readonly KeyRow[] }) {
	return (
		<Show when={props.rows.length > 0}>
			<table aria-label={props.label} {...stylex.attrs(styles.keys)}>
				<thead>
					<tr>
						<th scope="col" {...stylex.attrs(styles.keyHeading, styles.frameHeading)}>
							Frame
						</th>
						<th scope="col" {...stylex.attrs(styles.keyHeading)}>
							Value
						</th>
					</tr>
				</thead>
				<tbody>
					<For each={props.rows}>
						{(row) => (
							<tr>
								<td {...stylex.attrs(styles.frameCell)}>
									<code>{row.frame}</code>
									<span
										aria-hidden="true"
										{...stylex.attrs(styles.visuallyHidden)}
									>
										{" · "}
									</span>
								</td>
								<td {...stylex.attrs(styles.valueCell)}>
									<span>{row.value}</span>
									<Show when={row.numeric}>
										{(key) => <NumericKeyDetails savedKey={key()} />}
									</Show>
								</td>
							</tr>
						)}
					</For>
				</tbody>
			</table>
		</Show>
	);
}

function KeyNotice(props: { readonly count: number | null }) {
	return (
		<>
			<Show when={props.count === null}>
				<p {...stylex.attrs(styles.note)}>
					Key arrays were not serialized or could not be decoded; see coverage details.
				</p>
			</Show>
			<Show when={props.count !== null && props.count > 200}>
				<p {...stylex.attrs(styles.note)}>
					Showing the first 200 keys. Use the CLI for the full channel.
				</p>
			</Show>
		</>
	);
}

function NumericKeyDetails(props: { readonly savedKey: SequenceNumericKey }) {
	return (
		<div {...stylex.attrs(styles.keySettings)}>
			<span>
				{props.savedKey.interpolation === 0
					? "Linear"
					: props.savedKey.interpolation === 1
						? "Constant"
						: props.savedKey.interpolation === 2
							? "Cubic"
							: `Unknown (${props.savedKey.interpolation})`}
			</span>
			<span>Tangent mode: {props.savedKey.tangent_mode}</span>
			<span>
				{props.savedKey.arrive_tangent} / {props.savedKey.leave_tangent}
			</span>
			<span>Weight mode: {props.savedKey.tangent_weight_mode}</span>
			<span>
				{props.savedKey.arrive_tangent_weight} / {props.savedKey.leave_tangent_weight}
			</span>
		</div>
	);
}

function ChannelInspector(props: { readonly channel: SequenceNumericChannel }) {
	const points = createMemo(() => {
		const keys = props.channel.keys;
		const minFrame = keys.reduce(
			(value, key) => Math.min(value, key.frame),
			keys[0]?.frame ?? 0
		);
		const maxFrame = keys.reduce((value, key) => Math.max(value, key.frame), minFrame + 1);
		const minValue = keys.reduce(
			(value, key) => Math.min(value, key.value),
			keys[0]?.value ?? 0
		);
		const maxValue = keys.reduce((value, key) => Math.max(value, key.value), minValue + 1);
		return keys.slice(0, 2000).map((key) => ({
			x: 20 + ((key.frame - minFrame) / Math.max(1, maxFrame - minFrame)) * 560,
			y: 140 - ((key.value - minValue) / Math.max(1e-12, maxValue - minValue)) * 120,
			key
		}));
	});
	return (
		<details open {...stylex.attrs(styles.disclosure)}>
			<summary {...stylex.attrs(styles.summary)}>
				{props.channel.property_path} · {props.channel.keys.length} keys ·{" "}
				{props.channel.enabled === null
					? "mask unknown"
					: props.channel.enabled
						? "enabled"
						: "disabled"}
			</summary>
			<dl {...stylex.attrs(styles.properties)}>
				<PropertyRow
					label="Saved default"
					value={props.channel.default_value ?? "not saved"}
				/>
				<PropertyRow label="Channel enabled" value={savedFlag(props.channel.enabled)} />
				<PropertyRow
					label="Extrapolation before/after"
					value={`${props.channel.pre_extrapolation} / ${props.channel.post_extrapolation}`}
				/>
			</dl>
			<svg
				viewBox="0 0 600 160"
				width="600"
				height="160"
				role="img"
				aria-label={`${props.channel.property_path} saved key values`}
				{...stylex.attrs(styles.chart)}
			>
				<For each={points()}>
					{(point) => (
						<circle cx={point.x} cy={point.y} r="3" fill={tokens.colorAccent}>
							<title>
								{point.key.frame}: {point.key.value}
							</title>
						</circle>
					)}
				</For>
			</svg>
			<p {...stylex.attrs(styles.note)}>
				Saved key values; interpolation and blending are not evaluated.
			</p>
			<Show when={props.channel.keys.length > 200}>
				<p {...stylex.attrs(styles.note)}>
					Showing up to 2,000 points and 200 key rows. Use the CLI for all saved keys.
				</p>
			</Show>
			<KeysTable
				label={`${props.channel.property_path} saved keys`}
				rows={props.channel.keys.slice(0, 200).map((key) => ({
					frame: key.frame,
					value: String(key.value),
					numeric: key
				}))}
			/>
		</details>
	);
}

const styles = stylex.create({
	panel: {
		backgroundColor: tokens.colorSurfaceInset,
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		borderStyle: "solid",
		borderWidth: 1,
		padding: 12,
		fontSize: 12,
		minWidth: 0,
		overflowWrap: "anywhere"
	},
	header: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
	typeChip: {
		padding: "2px 6px",
		borderRadius: tokens.radiusBadge,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextMuted,
		fontSize: 11,
		flexShrink: 0
	},
	title: {
		margin: 0,
		fontSize: 13,
		color: tokens.colorTextStrong,
		minWidth: 0,
		flex: "1 1 0",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	range: { color: tokens.colorTextMuted, fontSize: 11, flexShrink: 0, whiteSpace: "nowrap" },
	disclosure: { marginTop: 8 },
	summary: { color: tokens.colorText, cursor: "pointer", fontSize: 12, paddingBlock: 4 },
	subheading: { margin: "12px 0 4px", fontSize: 12, color: tokens.colorTextStrong },
	properties: { margin: "4px 0" },
	propertyRow: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.3fr)",
		gap: 8,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		paddingBlock: 4,
		lineHeight: 1.5
	},
	propertyName: { color: tokens.colorTextMuted, minWidth: 0 },
	propertyValue: { margin: 0, minWidth: 0, fontFamily: tokens.fontMono, fontSize: 11 },
	keys: { width: "100%", tableLayout: "fixed", borderCollapse: "collapse", marginTop: 6 },
	frameHeading: { width: 64 },
	keyHeading: {
		padding: "4px 6px",
		fontSize: 10,
		fontWeight: 500,
		color: tokens.colorTextMuted,
		textAlign: "left",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	frameCell: {
		width: 60,
		padding: "4px 6px",
		verticalAlign: "top",
		fontSize: 11,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	valueCell: {
		padding: "4px 6px",
		verticalAlign: "top",
		fontFamily: tokens.fontMono,
		fontSize: 11,
		lineHeight: 1.5,
		overflowWrap: "anywhere",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	keySettings: {
		color: tokens.colorTextMuted,
		display: "flex",
		flexWrap: "wrap",
		fontSize: 10,
		gap: "2px 8px",
		paddingTop: 2
	},
	chart: { display: "block", maxWidth: "100%", height: "auto" },
	note: { color: tokens.colorTextSubtle, fontSize: 11, lineHeight: 1.5, margin: "6px 0" },
	visuallyHidden: {
		position: "absolute",
		width: 1,
		height: 1,
		overflow: "hidden",
		clipPath: "inset(50%)",
		whiteSpace: "nowrap"
	}
});
