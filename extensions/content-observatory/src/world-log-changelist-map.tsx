import * as stylex from "@stylexjs/stylex";
import type { PerforceMapRevision } from "@ue-shed/map-history/contract";
import { PointMapCanvas, type PointMapController } from "@ue-shed/ui/point-map";
import { For, Show, createMemo } from "solid-js";
import {
	worldLogChangelistMapOverlay,
	worldLogChangelistToneColor,
	type WorldLogChangelistTone
} from "./world-log-changelist.js";
import { formatSubmittedAt } from "./world-log-format.js";
import { styles } from "./world-log-styles.js";

const tones: readonly WorldLogChangelistTone[] = ["added", "removed", "moved", "changed"];

export function WorldLogChangelistMap(props: {
	readonly onSelectActor: (key: string | undefined) => void;
	readonly revision: PerforceMapRevision;
	readonly selectedActorKey: string | undefined;
}) {
	let pointMap: PointMapController | undefined;
	const overlay = createMemo(() => worldLogChangelistMapOverlay(props.revision));
	const selectedChange = () => props.revision.change;

	return (
		<section aria-label="Selected changelist map diff" {...stylex.props(styles.changelistMap)}>
			<header {...stylex.props(styles.changelistMapHeader)}>
				<div>
					<span {...stylex.props(styles.sectionKicker)}>SELECTED SUBMITTED DIFF</span>
					<h2>CL {selectedChange()} map diff</h2>
					<p>
						{props.revision.user ?? "unknown submitter"} /{" "}
						{formatSubmittedAt(props.revision)}
					</p>
				</div>
				<div {...stylex.props(styles.changelistMapCounts)}>
					<For each={tones}>
						{(tone) => (
							<span>
								<i
									{...stylex.props(styles.changelistMapDot)}
									style={{
										"background-color": worldLogChangelistToneColor(tone)
									}}
								/>
								{tone.toUpperCase()} <b>{overlay().summary[tone]}</b>
							</span>
						)}
					</For>
					<Show when={overlay().summary.unclassified > 0}>
						<span {...stylex.props(styles.changelistMapUnclassified)}>
							UNCLASSIFIED <b>{overlay().summary.unclassified}</b>
						</span>
					</Show>
				</div>
			</header>
			<div {...stylex.props(styles.changelistMapFrame)}>
				<div {...stylex.props(styles.changelistMapLegend)}>
					<span>◌ BEFORE / GHOST</span>
					<span>→ MOVEMENT</span>
					<span>● AFTER</span>
				</div>
				<Show
					when={overlay().points.length > 0}
					fallback={
						<div {...stylex.props(styles.changelistMapEmpty)}>
							This submitted changelist has no actor evidence with a resolved top-down
							position. Package and unclassified evidence remain in the ledger.
						</div>
					}
				>
					<PointMapCanvas
						ariaLabel={`Top-down changelist ${selectedChange()} diff map`}
						class={stylex.props(styles.changelistPointMap).className}
						connections={overlay().connections}
						onController={(controller) => {
							pointMap = controller;
						}}
						onSelect={props.onSelectActor}
						points={overlay().points}
						resetKey={selectedChange()}
						selectedKey={props.selectedActorKey}
						title="Scroll to zoom, drag to pan, click an actor diff point to inspect it"
					/>
				</Show>
				<button
					type="button"
					onClick={() => pointMap?.resetView()}
					{...stylex.props(styles.pointMapReset)}
				>
					RESET VIEW
				</button>
			</div>
		</section>
	);
}
