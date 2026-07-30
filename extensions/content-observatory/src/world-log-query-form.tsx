import * as stylex from "@stylexjs/stylex";
import { For, Show, createSignal } from "solid-js";
import { styles } from "./world-log-styles.js";

export interface WorldLogScanLimits {
	readonly maxChangelists: number;
	readonly maxConcurrency: number;
	readonly maxDurationMs: number;
	readonly maxMaterializedFiles: number;
	readonly maxPackages: number;
}

type WorldLogScanLimitName = keyof WorldLogScanLimits;

export function WorldLogQueryForm(props: {
	readonly disabled: boolean;
	readonly limits: WorldLogScanLimits;
	readonly maps: ReadonlyArray<{ readonly label: string; readonly mapPath: string }>;
	readonly mapPath: string;
	readonly onLimitsChange: (limits: Partial<WorldLogScanLimits>) => void;
	readonly onMapPathChange: (path: string) => void;
	readonly onRun: () => void;
	readonly rangeDays: number;
	readonly setRangeDays: (days: number) => void;
}) {
	const [advancedOpen, setAdvancedOpen] = createSignal(false);
	const setLimit = (name: WorldLogScanLimitName, raw: string) => {
		const value = Number(raw);
		if (!Number.isSafeInteger(value) || value < 1) return;
		props.onLimitsChange({ [name]: value });
	};

	return (
		<section aria-label="Map history query" {...stylex.props(styles.queryPanel)}>
			<div {...stylex.props(styles.queryLead)}>
				<span {...stylex.props(styles.sectionKicker)}>TARGET / BOUNDED RANGE</span>
				<strong>Read a saved world, not a source-control browser.</strong>
				<p>
					Every result is one map scope reconstructed at submitted changelists.
					Unexplained package edits remain visible below.
				</p>
			</div>
			<label {...stylex.props(styles.mapInputLabel)}>
				<span>MAP PATH</span>
				<input
					disabled={props.disabled}
					value={props.mapPath}
					onInput={(event) => props.onMapPathChange(event.currentTarget.value)}
					placeholder="Content/Maps/L_MyMap.umap"
					{...stylex.props(styles.mapInput)}
				/>
			</label>
			<Show when={props.maps.length > 0}>
				<div {...stylex.props(styles.mapChoices)}>
					<For each={props.maps}>
						{(map) => (
							<button
								type="button"
								disabled={props.disabled}
								aria-pressed={map.mapPath === props.mapPath}
								onClick={() => props.onMapPathChange(map.mapPath)}
								{...stylex.props(
									styles.mapChoice,
									map.mapPath === props.mapPath && styles.mapChoiceActive
								)}
							>
								{map.label}
							</button>
						)}
					</For>
				</div>
			</Show>
			<div {...stylex.props(styles.rangeControls)}>
				<span>LOOK BACK</span>
				<For each={[1, 7, 30]}>
					{(days) => (
						<button
							type="button"
							disabled={props.disabled}
							aria-pressed={days === props.rangeDays}
							onClick={() => props.setRangeDays(days)}
							{...stylex.props(
								styles.rangeButton,
								days === props.rangeDays && styles.rangeButtonActive
							)}
						>
							{days}D
						</button>
					)}
				</For>
				<button
					type="button"
					disabled={props.disabled || props.mapPath.trim().length === 0}
					onClick={props.onRun}
					{...stylex.props(styles.runButton)}
				>
					READ HISTORY <span>↗</span>
				</button>
				<button
					type="button"
					disabled={props.disabled}
					aria-controls="world-log-scan-limits"
					aria-expanded={advancedOpen()}
					onClick={() => setAdvancedOpen((current) => !current)}
					{...stylex.props(styles.advancedButton)}
				>
					ADVANCED LIMITS
				</button>
			</div>
			<Show when={advancedOpen()}>
				<fieldset
					id="world-log-scan-limits"
					aria-label="Advanced scan limits"
					disabled={props.disabled}
					{...stylex.props(styles.scanLimits)}
				>
					<legend>SCAN BOUNDS</legend>
					<label {...stylex.props(styles.scanLimitLabel)}>
						<span>CHANGE LISTS</span>
						<input
							type="number"
							min="1"
							value={props.limits.maxChangelists}
							onInput={(event) =>
								setLimit("maxChangelists", event.currentTarget.value)
							}
							{...stylex.props(styles.scanLimitInput)}
						/>
					</label>
					<label {...stylex.props(styles.scanLimitLabel)}>
						<span>PACKAGES</span>
						<input
							type="number"
							min="1"
							value={props.limits.maxPackages}
							onInput={(event) => setLimit("maxPackages", event.currentTarget.value)}
							{...stylex.props(styles.scanLimitInput)}
						/>
					</label>
					<label {...stylex.props(styles.scanLimitLabel)}>
						<span>MATERIALIZED FILES</span>
						<input
							type="number"
							min="1"
							value={props.limits.maxMaterializedFiles}
							onInput={(event) =>
								setLimit("maxMaterializedFiles", event.currentTarget.value)
							}
							{...stylex.props(styles.scanLimitInput)}
						/>
					</label>
					<label {...stylex.props(styles.scanLimitLabel)}>
						<span>CONCURRENCY</span>
						<input
							type="number"
							min="1"
							value={props.limits.maxConcurrency}
							onInput={(event) =>
								setLimit("maxConcurrency", event.currentTarget.value)
							}
							{...stylex.props(styles.scanLimitInput)}
						/>
					</label>
					<label {...stylex.props(styles.scanLimitLabel)}>
						<span>MAX DURATION (MS)</span>
						<input
							type="number"
							min="1"
							value={props.limits.maxDurationMs}
							onInput={(event) =>
								setLimit("maxDurationMs", event.currentTarget.value)
							}
							{...stylex.props(styles.scanLimitInput)}
						/>
					</label>
				</fieldset>
			</Show>
		</section>
	);
}
