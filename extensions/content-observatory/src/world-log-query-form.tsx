import * as stylex from "@stylexjs/stylex";
import type { SavedWorldActor } from "@ue-shed/protocol";
import { For, Show, createMemo, createSignal } from "solid-js";
import { actorKeyFromSavedActor } from "./world-log-actors.js";
import { styles } from "./world-log-styles.js";

export interface WorldLogScanLimits {
	readonly maxChangelists: number;
	readonly maxConcurrency: number;
	readonly maxDurationMs: number;
	readonly maxMaterializedFiles: number;
	readonly maxPackages: number;
}

export type WorldLogHistoryMode = "deep" | "fast";
export type WorldLogFastTargetKind = "actor" | "actor_class";

function actorDisplayName(actor: SavedWorldActor): string {
	return actor.label?.trim() || actor.actorPath.split(".").at(-1) || actor.actorPath;
}

type WorldLogScanLimitName = keyof WorldLogScanLimits;

export function WorldLogQueryForm(props: {
	readonly disabled: boolean;
	readonly mode: WorldLogHistoryMode;
	readonly limits: WorldLogScanLimits;
	readonly maps: ReadonlyArray<{ readonly label: string; readonly mapPath: string }>;
	readonly mapPath: string;
	readonly onLimitsChange: (limits: Partial<WorldLogScanLimits>) => void;
	readonly onMapPathChange: (path: string) => void;
	readonly onModeChange: (mode: WorldLogHistoryMode) => void;
	readonly onLoadTargets: () => void;
	readonly onRun: () => void;
	readonly onFastTargetKindChange: (kind: WorldLogFastTargetKind) => void;
	readonly onTargetClassChange: (classPath: string | undefined) => void;
	readonly onTargetChange: (actorKey: string | undefined) => void;
	readonly rangeDays: number;
	readonly setRangeDays: (days: number) => void;
	readonly targetActors: ReadonlyArray<SavedWorldActor>;
	readonly targetError: string | undefined;
	readonly targetClassPath: string | undefined;
	readonly targetKey: string | undefined;
	readonly fastTargetKind: WorldLogFastTargetKind;
	readonly targetLoading: boolean;
}) {
	const [advancedOpen, setAdvancedOpen] = createSignal(false);
	const [targetQuery, setTargetQuery] = createSignal("");
	const filteredTargets = createMemo(() => {
		const query = targetQuery().trim().toLocaleLowerCase();
		if (query.length === 0) return props.targetActors;
		return props.targetActors.filter((actor) =>
			[
				actor.label,
				actor.actorPath,
				actor.classPath,
				actor.packageName,
				actor.actorGuid
			].some((value) => value?.toLocaleLowerCase().includes(query) ?? false)
		);
	});
	const classTargets = createMemo(() => {
		const counts = new Map<string, number>();
		for (const actor of props.targetActors) {
			counts.set(actor.classPath, (counts.get(actor.classPath) ?? 0) + 1);
		}
		return [...counts.entries()]
			.map(([classPath, count]) => ({ classPath, count }))
			.toSorted((left, right) => left.classPath.localeCompare(right.classPath));
	});
	const filteredClasses = createMemo(() => {
		const query = targetQuery().trim().toLocaleLowerCase();
		if (query.length === 0) return classTargets();
		return classTargets().filter((target) =>
			target.classPath.toLocaleLowerCase().includes(query)
		);
	});
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
			<div role="group" aria-label="History mode" {...stylex.props(styles.historyModes)}>
				<button
					type="button"
					disabled={props.disabled}
					aria-pressed={props.mode === "deep"}
					onClick={() => props.onModeChange("deep")}
					{...stylex.props(
						styles.historyModeButton,
						props.mode === "deep" && styles.historyModeButtonActive
					)}
				>
					DEEP HISTORY
				</button>
				<button
					type="button"
					disabled={props.disabled}
					aria-pressed={props.mode === "fast"}
					onClick={() => props.onModeChange("fast")}
					{...stylex.props(
						styles.historyModeButton,
						props.mode === "fast" && styles.historyModeButtonActive
					)}
				>
					FAST HISTORY
				</button>
			</div>
			<Show when={props.mode === "fast"}>
				<section aria-label="Fast History target" {...stylex.props(styles.fastTargetPanel)}>
					<div>
						<span {...stylex.props(styles.sectionKicker)}>FAST HISTORY TARGET</span>
						<strong>
							Choose one current actor or actor class before reading its history.
						</strong>
						<p>
							This reads the selected map's saved actor list locally. It does not scan
							Perforce until you press READ FAST HISTORY.
						</p>
					</div>
					<button
						type="button"
						disabled={
							props.disabled ||
							props.mapPath.trim().length === 0 ||
							props.targetLoading
						}
						onClick={props.onLoadTargets}
						{...stylex.props(styles.loadTargetsButton)}
					>
						{props.targetLoading ? "LOADING ACTORS…" : "LOAD CURRENT ACTORS"}
					</button>
					<div
						role="group"
						aria-label="Fast History target kind"
						{...stylex.props(styles.fastTargetModes)}
					>
						<button
							type="button"
							disabled={props.disabled}
							aria-pressed={props.fastTargetKind === "actor"}
							onClick={() => props.onFastTargetKindChange("actor")}
							{...stylex.props(
								styles.fastTargetMode,
								props.fastTargetKind === "actor" && styles.fastTargetModeActive
							)}
						>
							ACTOR
						</button>
						<button
							type="button"
							disabled={props.disabled}
							aria-pressed={props.fastTargetKind === "actor_class"}
							onClick={() => props.onFastTargetKindChange("actor_class")}
							{...stylex.props(
								styles.fastTargetMode,
								props.fastTargetKind === "actor_class" &&
									styles.fastTargetModeActive
							)}
						>
							ACTOR CLASS
						</button>
					</div>
					<Show when={props.targetActors.length > 0 || props.targetLoading}>
						<label {...stylex.props(styles.targetSearchLabel)}>
							<span>
								{props.fastTargetKind === "actor" ? "FIND ACTOR" : "FIND CLASS"}
							</span>
							<input
								disabled={props.disabled || props.targetLoading}
								value={targetQuery()}
								onInput={(event) => setTargetQuery(event.currentTarget.value)}
								placeholder={
									props.fastTargetKind === "actor"
										? "label, class, path, or GUID"
										: "exact actor class path"
								}
								aria-label={
									props.fastTargetKind === "actor"
										? "Find current actor"
										: "Find actor class"
								}
								{...stylex.props(styles.targetSearchInput)}
							/>
						</label>
						<Show
							when={props.fastTargetKind === "actor"}
							fallback={
								<ul
									aria-label="Current actor class targets"
									{...stylex.props(styles.targetList)}
								>
									<For each={filteredClasses()}>
										{(target) => (
											<li>
												<button
													type="button"
													disabled={props.disabled}
													aria-pressed={
														props.targetClassPath === target.classPath
													}
													onClick={() =>
														props.onTargetClassChange(target.classPath)
													}
													{...stylex.props(
														styles.targetClassRow,
														props.targetClassPath ===
															target.classPath &&
															styles.targetRowActive
													)}
												>
													<strong>{target.classPath}</strong>
													<small {...stylex.props(styles.targetRowSmall)}>
														{target.count} current actor
														{target.count === 1 ? "" : "s"}
													</small>
												</button>
											</li>
										)}
									</For>
								</ul>
							}
						>
							<ul
								aria-label="Current actor targets"
								{...stylex.props(styles.targetList)}
							>
								<For each={filteredTargets()}>
									{(actor) => {
										const actorKey = actorKeyFromSavedActor(actor);
										return (
											<li>
												<button
													type="button"
													disabled={props.disabled}
													aria-pressed={props.targetKey === actorKey}
													onClick={() => props.onTargetChange(actorKey)}
													{...stylex.props(
														styles.targetRow,
														props.targetKey === actorKey &&
															styles.targetRowActive
													)}
												>
													<strong>{actorDisplayName(actor)}</strong>
													<small {...stylex.props(styles.targetRowSmall)}>
														{actor.classPath}
													</small>
													<small {...stylex.props(styles.targetRowSmall)}>
														{actor.actorPath}
													</small>
												</button>
											</li>
										);
									}}
								</For>
							</ul>
						</Show>
					</Show>
					<Show
						when={
							props.targetActors.length > 0 &&
							(props.fastTargetKind === "actor"
								? filteredTargets().length === 0
								: filteredClasses().length === 0)
						}
					>
						<p {...stylex.props(styles.targetEmpty)}>
							No current{" "}
							{props.fastTargetKind === "actor" ? "actors" : "actor classes"} match
							that search.
						</p>
					</Show>
					<Show when={props.targetError !== undefined}>
						<p role="alert" {...stylex.props(styles.targetError)}>
							{props.targetError}
						</p>
					</Show>
				</section>
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
					disabled={
						props.disabled ||
						props.mapPath.trim().length === 0 ||
						(props.mode === "fast" &&
							(props.fastTargetKind === "actor"
								? props.targetKey === undefined
								: props.targetClassPath === undefined))
					}
					onClick={props.onRun}
					{...stylex.props(styles.runButton)}
				>
					{props.mode === "fast" ? "READ FAST HISTORY" : "READ DEEP HISTORY"}{" "}
					<span>↗</span>
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
