import * as stylex from "@stylexjs/stylex";
import {
	ActorExplorer,
	actorExplorerMatches,
	noActorExplorerFilters,
	SavedMapPicker,
	type ActorExplorerFilters
} from "@ue-shed/ui";
import type { SavedWorldActor } from "@ue-shed/protocol";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
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

function actorObjectName(actorPath: string): string {
	return actorPath.split(".").at(-1) ?? actorPath;
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
	const [targetFilters, setTargetFilters] =
		createSignal<ActorExplorerFilters>(noActorExplorerFilters);
	let targetResetKey = "";
	createEffect(() => {
		const nextKey = `${props.mapPath}:${props.fastTargetKind}`;
		if (nextKey === targetResetKey) return;
		targetResetKey = nextKey;
		setTargetFilters(noActorExplorerFilters);
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
	const targetItems = createMemo(() =>
		props.targetActors.map((actor) => ({
			classPath: actor.classPath,
			key: actorKeyFromSavedActor(actor),
			label: actorDisplayName(actor),
			packageName: actor.packageName,
			path: actor.actorPath,
			...(actorObjectName(actor.actorPath) === actorDisplayName(actor)
				? undefined
				: { secondary: actorObjectName(actor.actorPath) }),
			searchFields: {
				class: actor.classPath,
				guid: actor.actorGuid,
				label: actor.label,
				package: actor.packageName,
				path: actor.actorPath
			}
		}))
	);
	const setLimit = (name: WorldLogScanLimitName, raw: string) => {
		const value = Number(raw);
		if (!Number.isSafeInteger(value) || value < 1) return;
		props.onLimitsChange({ [name]: value });
	};

	return (
		<section aria-label="Map history query" {...stylex.props(styles.queryPanel)}>
			<SavedMapPicker
				maps={props.maps}
				mapPath={props.mapPath}
				onMapPathChange={props.onMapPathChange}
				disabled={props.disabled}
				allowCustomPath
			/>
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
					Deep history
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
					Fast history
				</button>
			</div>
			<Show when={props.mode === "fast"}>
				<section aria-label="Fast history target" {...stylex.props(styles.fastTargetPanel)}>
					<div {...stylex.props(styles.fastTargetIntro)}>
						<strong>Target one current actor or class.</strong>
						<p>The list is local. Perforce is read only when you run the scan.</p>
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
						{props.targetLoading
							? "Loading…"
							: props.targetActors.length > 0
								? "Refresh actors"
								: "Load actors"}
					</button>
					<div
						role="group"
						aria-label="Fast history target kind"
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
							Actor
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
							Actor class
						</button>
					</div>
					<Show when={props.targetActors.length > 0 || props.targetLoading}>
						<ActorExplorer
							ariaLabel="Fast history targets"
							classMode={props.fastTargetKind === "actor_class" ? "target" : "filter"}
							classOptions={classTargets()}
							density="compact"
							disabled={props.disabled || props.targetLoading}
							filters={targetFilters()}
							itemListLabel={
								props.fastTargetKind === "actor" ? "Actor targets" : "Class members"
							}
							items={targetItems()}
							label="Targets"
							onClassPathsChange={(classPaths) =>
								setTargetFilters((current) => ({ ...current, classPaths }))
							}
							onClassTargetChange={props.onTargetClassChange}
							onFiltersChange={setTargetFilters}
							onSelect={(key) => {
								if (props.fastTargetKind === "actor") props.onTargetChange(key);
							}}
							queryAriaLabel={
								props.fastTargetKind === "actor" ? "Find an actor" : "Find a class"
							}
							selectedClassPath={props.targetClassPath}
							selectedKey={props.targetKey}
							title={
								props.fastTargetKind === "actor"
									? "Select one actor"
									: "Select a class target"
							}
						/>
					</Show>
					<Show
						when={
							props.targetActors.length > 0 &&
							(props.fastTargetKind === "actor"
								? targetItems().filter((item) =>
										actorExplorerMatches(item, targetFilters())
									).length === 0
								: classTargets().filter((target) => {
										const query = targetFilters().query.toLocaleLowerCase();
										return (
											query.length === 0 ||
											target.classPath.toLocaleLowerCase().includes(query)
										);
									}).length === 0)
						}
					>
						<p {...stylex.props(styles.targetEmpty)}>
							No {props.fastTargetKind === "actor" ? "actors" : "actor classes"} match
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
				<span>Range</span>
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
							{days} day{days === 1 ? "" : "s"}
						</button>
					)}
				</For>
				<button
					type="button"
					disabled={props.disabled}
					aria-controls="world-log-scan-limits"
					aria-expanded={advancedOpen()}
					onClick={() => setAdvancedOpen((current) => !current)}
					{...stylex.props(styles.advancedButton)}
				>
					Advanced limits
				</button>
			</div>
			<Show when={advancedOpen()}>
				<fieldset
					id="world-log-scan-limits"
					aria-label="Advanced limits"
					disabled={props.disabled}
					{...stylex.props(styles.scanLimits)}
				>
					<legend>Limits</legend>
					<label {...stylex.props(styles.scanLimitLabel)}>
						<span>Max changelists</span>
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
						<span>Packages</span>
						<input
							type="number"
							min="1"
							value={props.limits.maxPackages}
							onInput={(event) => setLimit("maxPackages", event.currentTarget.value)}
							{...stylex.props(styles.scanLimitInput)}
						/>
					</label>
					<label {...stylex.props(styles.scanLimitLabel)}>
						<span>Materialized files</span>
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
						<span>Concurrency</span>
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
						<span>Max duration (ms)</span>
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
