import * as stylex from "@stylexjs/stylex";
import type { SavedWorld } from "@ue-shed/protocol";
import { For, Show, createMemo, createSignal } from "solid-js";
import {
	PointMapCanvas,
	pointMapColorForClass,
	type PointMapController,
	type PointMapPoint
} from "@ue-shed/ui/point-map";
import { actorKeyFromSavedActor } from "./world-log-actors.js";
import { shortClass } from "./world-log-format.js";
import { styles } from "./world-log-styles.js";

export function WorldLogCurrentMap(props: { readonly world: SavedWorld }) {
	let pointMap: PointMapController | undefined;
	const [selectedKey, setSelectedKey] = createSignal<string>();
	const points = createMemo<readonly PointMapPoint[]>(() =>
		props.world.actors.flatMap((actor) => {
			if (actor.position.status !== "resolved") return [];
			return [
				{
					className: actor.classPath,
					key: actorKeyFromSavedActor(actor),
					x: actor.position.location.x,
					y: actor.position.location.y
				}
			];
		})
	);
	const pointClasses = createMemo(() => {
		const counts = new Map<string, number>();
		for (const point of points())
			counts.set(point.className, (counts.get(point.className) ?? 0) + 1);
		return [...counts].toSorted(([left], [right]) => left.localeCompare(right));
	});
	const selectedActor = createMemo(() => {
		const key = selectedKey();
		return key === undefined
			? undefined
			: props.world.actors.find((actor) => actorKeyFromSavedActor(actor) === key);
	});

	return (
		<section aria-label="Current saved map" {...stylex.props(styles.currentMap)}>
			<header {...stylex.props(styles.currentMapHeader)}>
				<div>
					<span {...stylex.props(styles.sectionKicker)}>CURRENT SAVED MAP</span>
					<h2 {...stylex.props(styles.currentMapTitle)}>Map preview</h2>
					<code {...stylex.props(styles.currentMapPath)}>{props.world.mapPath}</code>
				</div>
				<div {...stylex.props(styles.currentMapSummary)}>
					<strong {...stylex.props(styles.currentMapSummaryCount)}>
						{props.world.actors.length.toLocaleString()}
					</strong>
					<span {...stylex.props(styles.currentMapSummaryLabel)}>ACTORS</span>
					<small {...stylex.props(styles.currentMapSummaryDetail)}>
						{points().length.toLocaleString()} RESOLVED ·{" "}
						{props.world.summary.scannedPackages} PACKAGE
						{props.world.summary.scannedPackages === 1 ? "" : "S"}
					</small>
				</div>
			</header>
			<div {...stylex.props(styles.currentMapFrame)}>
				<div {...stylex.props(styles.currentMapNorth)}>N ↑</div>
				<div {...stylex.props(styles.currentMapLegend)}>
					<For each={pointClasses()}>
						{([classPath, count]) => (
							<span title={classPath}>
								<i
									{...stylex.props(styles.pointMapClassDot)}
									style={{ "background-color": pointMapColorForClass(classPath) }}
								/>
								{shortClass(classPath)} <b>{count}</b>
							</span>
						)}
					</For>
				</div>
				<Show
					when={points().length > 0}
					fallback={
						<div {...stylex.props(styles.currentMapEmpty)}>
							No actors with resolved positions are available in this saved map.
						</div>
					}
				>
					<PointMapCanvas
						ariaLabel="Current saved actor map"
						class={stylex.props(styles.currentMapCanvas).className}
						onController={(controller) => {
							pointMap = controller;
						}}
						onSelect={setSelectedKey}
						points={points()}
						resetKey={props.world.mapPath}
						selectedKey={selectedKey()}
						title="Scroll to zoom, drag to pan, click an actor point to inspect it"
					/>
				</Show>
				<button
					type="button"
					onClick={() => pointMap?.resetView()}
					{...stylex.props(styles.currentMapReset)}
				>
					RESET VIEW
				</button>
				<Show when={selectedActor()}>
					{(actor) => (
						<div {...stylex.props(styles.currentMapSelection)}>
							<strong>{actor().label ?? actor().actorPath.split(".").at(-1)}</strong>
							<span {...stylex.props(styles.currentMapSelectionClass)}>
								{shortClass(actor().classPath)}
							</span>
						</div>
					)}
				</Show>
			</div>
		</section>
	);
}
