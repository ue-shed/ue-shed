import * as stylex from "@stylexjs/stylex";
import {
	pointMapColorForClass,
	pointMapMarkerRadius,
	pointMapResizeCanvasForDisplay
} from "@ue-shed/ui/point-map-core";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import {
	createMapTileGrid,
	mapTileKeyId,
	resolveAvailableMapTiles,
	selectMapTiles,
	type MapTileKey,
	type MapTilePyramidManifestValue
} from "@ue-shed/cameras/map-tiles";
import type { Effect } from "effect";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import {
	fitMapTileViewport,
	mapTileScreenPoint,
	mapTileScreenRect,
	mapTileViewportBounds,
	type MapTileViewport
} from "./map-tile-viewer-model.js";

export interface MapTileActorMarker {
	readonly className: string;
	readonly key: string;
	readonly label: string;
	readonly worldX: number;
	readonly worldY: number;
}

export interface MapTilePyramidViewerController {
	readonly focusActor: (key: string) => void;
	readonly resetView: () => void;
}

export interface MapTilePyramidViewerProps {
	readonly actorMarkers?: ReadonlyArray<MapTileActorMarker> | undefined;
	readonly manifest: MapTilePyramidManifestValue;
	readonly onActorSelect?: ((key: string | undefined) => void) | undefined;
	readonly onController?:
		| ((controller: MapTilePyramidViewerController | undefined) => void)
		| undefined;
	readonly selectedActorKey?: string | undefined;
	readonly loadTile: (
		key: MapTileKey,
		relativePath: string
	) => Effect.Effect<Uint8Array, unknown>;
	readonly maximumCacheEntries?: number;
}

/** Reads a Solid input solely to register it as a paint dependency. */
function observeMapTileInput<Value>(_value: Value): void {}

function MapTileRequest(props: {
	readonly keyValue: MapTileKey;
	readonly load: () => Effect.Effect<Uint8Array, unknown>;
	readonly onFailed: (key: MapTileKey) => void;
	readonly onLoaded: (key: MapTileKey, bytes: Uint8Array) => void;
}) {
	const action = createEffectAction();
	onMount(() => {
		action.run(props.load(), {
			onFailure: () => props.onFailed(props.keyValue),
			onSuccess: (bytes) => props.onLoaded(props.keyValue, bytes)
		});
	});
	onCleanup(() => action.cancel());
	return null;
}

export function MapTilePyramidViewer(props: MapTilePyramidViewerProps) {
	let surface: HTMLDivElement | undefined;
	let actorCanvas: HTMLCanvasElement | undefined;
	let drag:
		| {
				centerX: number;
				centerY: number;
				moved: boolean;
				pointerId: number;
				x: number;
				y: number;
		  }
		| undefined;
	const grid = createMemo(() =>
		createMapTileGrid({
			coarsestUnitsPerPixel: props.manifest.levels[0]!.unitsPerPixel,
			levelCount: props.manifest.levels.length,
			requestedBounds: props.manifest.grid.requestedBounds,
			tilePixelSize: props.manifest.tilePixelSize
		})
	);
	const artifactPaths = createMemo(
		() =>
			new Map(props.manifest.tiles.map((tile) => [mapTileKeyId(tile.key), tile.relativePath]))
	);
	const [viewport, setViewport] = createSignal<MapTileViewport>(
		fitMapTileViewport({ bounds: props.manifest.grid.snappedBounds, height: 600, width: 900 })
	);
	const [currentLevel, setCurrentLevel] = createSignal<number>();
	const [tileUrls, setTileUrls] = createSignal<ReadonlyMap<string, string>>(new Map());
	const [failed, setFailed] = createSignal<ReadonlySet<string>>(new Set());
	const cacheLimit = () => props.maximumCacheEntries ?? 256;

	const selection = createMemo(() => {
		const retainedLevel = currentLevel();
		const selected = selectMapTiles({
			...(retainedLevel === undefined ? undefined : { currentLevel: retainedLevel }),
			grid: grid(),
			hysteresisLevels: 0.15,
			maximumCacheEntries: props.maximumCacheEntries ?? 256,
			prefetchRing: 1,
			screenPixelsPerWorldUnit: viewport().pixelsPerWorldUnit,
			viewportBounds: mapTileViewportBounds(viewport())
		});
		return selected;
	});
	createEffect(() => setCurrentLevel(selection().level));
	const requests = createMemo<ReadonlyArray<MapTileKey>>((previous = []) => {
		const selected = selection();
		const previousById = new Map(previous.map((key) => [mapTileKeyId(key), key]));
		return [
			...new Map(
				[...selected.ancestors, ...selected.visible, ...selected.prefetch].map((key) => [
					mapTileKeyId(key),
					previousById.get(mapTileKeyId(key)) ?? key
				])
			).values()
		];
	}, []);
	const renderTiles = createMemo(() =>
		resolveAvailableMapTiles({
			available: new Set(tileUrls().keys()),
			desired: selection().visible
		}).render.toSorted((left, right) => left.zoom - right.zoom)
	);
	const pendingRequests = createMemo(() =>
		requests().filter((key) => {
			const identity = mapTileKeyId(key);
			return !tileUrls().has(identity) && !failed().has(identity);
		})
	);
	const loadingCount = () => pendingRequests().length;
	const captureCoverageVisible = createMemo(() => {
		const visible = mapTileViewportBounds(viewport());
		const capture = props.manifest.grid.snappedBounds;
		return (
			visible.minX < capture.maxX &&
			visible.maxX > capture.minX &&
			visible.minY < capture.maxY &&
			visible.maxY > capture.minY
		);
	});

	function resize() {
		if (!surface) return;
		const bounds = surface.getBoundingClientRect();
		const nextHeight = Math.max(1, bounds.height);
		const nextWidth = Math.max(1, bounds.width);
		setViewport((current) => {
			const previousFit = fitMapTileViewport({
				bounds: props.manifest.grid.snappedBounds,
				height: current.height,
				width: current.width
			});
			const nextFit = fitMapTileViewport({
				bounds: props.manifest.grid.snappedBounds,
				height: nextHeight,
				width: nextWidth
			});
			return {
				...current,
				height: nextHeight,
				pixelsPerWorldUnit:
					nextFit.pixelsPerWorldUnit *
					(current.pixelsPerWorldUnit / previousFit.pixelsPerWorldUnit),
				width: nextWidth
			};
		});
	}

	function resetView() {
		if (!surface) return;
		const bounds = surface.getBoundingClientRect();
		setViewport(
			fitMapTileViewport({
				bounds: props.manifest.grid.snappedBounds,
				height: Math.max(1, bounds.height),
				width: Math.max(1, bounds.width)
			})
		);
	}

	function focusActor(key: string) {
		const actor = props.actorMarkers?.find((candidate) => candidate.key === key);
		if (actor === undefined) return;
		setViewport((current) => {
			const fit = fitMapTileViewport({
				bounds: props.manifest.grid.snappedBounds,
				height: current.height,
				width: current.width
			});
			return {
				...current,
				centerX: actor.worldX,
				centerY: actor.worldY,
				pixelsPerWorldUnit: Math.max(current.pixelsPerWorldUnit, fit.pixelsPerWorldUnit * 6)
			};
		});
	}

	function paintActorOverlay() {
		if (actorCanvas === undefined) return;
		const current = viewport();
		const context = pointMapResizeCanvasForDisplay(
			actorCanvas,
			current.width,
			current.height,
			globalThis.window?.devicePixelRatio || 1
		);
		if (context === undefined) return;
		context.clearRect(0, 0, current.width, current.height);
		const markers = props.actorMarkers ?? [];
		const radius = pointMapMarkerRadius(markers.length, current.width, current.height);
		for (const marker of markers) {
			const point = mapTileScreenPoint({
				viewport: current,
				worldX: marker.worldX,
				worldY: marker.worldY
			});
			if (
				point.left < -radius ||
				point.left > current.width + radius ||
				point.top < -radius ||
				point.top > current.height + radius
			) {
				continue;
			}
			const selected = marker.key === props.selectedActorKey;
			context.beginPath();
			context.arc(point.left, point.top, selected ? radius + 2 : radius, 0, Math.PI * 2);
			context.fillStyle = pointMapColorForClass(marker.className);
			context.fill();
			context.lineWidth = selected ? 2 : 1;
			context.strokeStyle = selected ? "#ffffff" : "rgba(255, 255, 255, 0.34)";
			context.stroke();
		}
	}

	function selectActorAt(clientX: number, clientY: number) {
		if (surface === undefined || props.onActorSelect === undefined) return;
		const bounds = surface.getBoundingClientRect();
		const current = viewport();
		const markers = props.actorMarkers ?? [];
		const pickRadius = Math.max(
			8,
			pointMapMarkerRadius(markers.length, current.width, current.height) + 4
		);
		let closestKey: string | undefined;
		let closestDistance = Number.POSITIVE_INFINITY;
		for (const marker of markers) {
			const point = mapTileScreenPoint({
				viewport: current,
				worldX: marker.worldX,
				worldY: marker.worldY
			});
			const distance = Math.hypot(
				point.left - (clientX - bounds.left),
				point.top - (clientY - bounds.top)
			);
			if (distance <= pickRadius && distance < closestDistance) {
				closestDistance = distance;
				closestKey = marker.key;
			}
		}
		props.onActorSelect(closestKey);
	}

	onMount(() => {
		resize();
		const observer = new ResizeObserver(resize);
		if (surface) observer.observe(surface);
		props.onController?.({ focusActor, resetView });
		onCleanup(() => {
			observer.disconnect();
			props.onController?.(undefined);
		});
	});
	createEffect(() => {
		observeMapTileInput(viewport());
		observeMapTileInput(props.actorMarkers);
		observeMapTileInput(props.selectedActorKey);
		paintActorOverlay();
	});

	function markLoaded(key: MapTileKey, bytes: Uint8Array) {
		const identity = mapTileKeyId(key);
		const ownedBytes = new Uint8Array(bytes.byteLength);
		ownedBytes.set(bytes);
		const url = URL.createObjectURL(new Blob([ownedBytes.buffer], { type: "image/png" }));
		setTileUrls((current) => {
			const replaced = current.get(identity);
			if (replaced !== undefined) URL.revokeObjectURL(replaced);
			const entries = [
				...Array.from(current).filter(([item]) => item !== identity),
				[identity, url] as const
			];
			const retained = entries.slice(-cacheLimit());
			const retainedIds = new Set(retained.map(([item]) => item));
			for (const [item, evictedUrl] of entries) {
				if (!retainedIds.has(item)) URL.revokeObjectURL(evictedUrl);
			}
			return new Map(retained);
		});
		setFailed((current) => {
			const next = new Set(current);
			next.delete(identity);
			return next;
		});
	}

	function markFailed(key: MapTileKey) {
		const identity = mapTileKeyId(key);
		setTileUrls((current) => {
			const url = current.get(identity);
			if (url === undefined) return current;
			URL.revokeObjectURL(url);
			const next = new Map(current);
			next.delete(identity);
			return next;
		});
		setFailed((current) => new Set([...current, identity].slice(-cacheLimit())));
	}

	onCleanup(() => {
		for (const url of tileUrls().values()) URL.revokeObjectURL(url);
	});

	function pan(event: PointerEvent) {
		if (!drag) return;
		if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 3) drag.moved = true;
		const pixelsPerWorldUnit = viewport().pixelsPerWorldUnit;
		setViewport((current) => ({
			...current,
			centerX: drag!.centerX + (event.clientY - drag!.y) / pixelsPerWorldUnit,
			centerY: drag!.centerY - (event.clientX - drag!.x) / pixelsPerWorldUnit
		}));
	}

	function zoom(event: WheelEvent) {
		event.preventDefault();
		if (!surface) return;
		const rect = surface.getBoundingClientRect();
		const current = viewport();
		const pointerX =
			current.centerX -
			(event.clientY - rect.top - rect.height / 2) / current.pixelsPerWorldUnit;
		const pointerY =
			current.centerY +
			(event.clientX - rect.left - rect.width / 2) / current.pixelsPerWorldUnit;
		const nextScale = Math.max(
			1e-6,
			current.pixelsPerWorldUnit * Math.exp(-event.deltaY * 0.0015)
		);
		setViewport({
			...current,
			centerX: pointerX + (event.clientY - rect.top - rect.height / 2) / nextScale,
			centerY: pointerY - (event.clientX - rect.left - rect.width / 2) / nextScale,
			pixelsPerWorldUnit: nextScale
		});
	}

	return (
		<section {...stylex.props(styles.frame)} aria-label="Map tile pyramid viewer">
			<header {...stylex.props(styles.header)}>
				<div>
					<p {...stylex.props(styles.eyebrow)}>
						CAPTURE PROOF / EXACT{" "}
						{props.manifest.state === "complete" ? "PUBLISHED" : "ATTEMPT"} PNG
					</p>
					<h2 {...stylex.props(styles.title)}>{props.manifest.planId}</h2>
				</div>
				<div {...stylex.props(styles.readout)}>
					<span>Z{String(selection().level).padStart(2, "0")}</span>
					<span>{selection().visible.length} VISIBLE</span>
					<span>{loadingCount()} QUEUED</span>
					<span>{failed().size} ERRORS</span>
					<Show when={(props.actorMarkers?.length ?? 0) > 0}>
						<span>{props.actorMarkers!.length.toLocaleString()} ACTORS</span>
					</Show>
				</div>
			</header>
			<div
				ref={(element) => {
					surface = element;
				}}
				{...stylex.props(styles.surface)}
				onPointerDown={(event) => {
					event.currentTarget.setPointerCapture(event.pointerId);
					const current = viewport();
					drag = {
						centerX: current.centerX,
						centerY: current.centerY,
						moved: false,
						pointerId: event.pointerId,
						x: event.clientX,
						y: event.clientY
					};
				}}
				onPointerMove={pan}
				onPointerUp={(event) => {
					const completed = drag;
					drag = undefined;
					if (completed !== undefined && !completed.moved) {
						selectActorAt(event.clientX, event.clientY);
					}
				}}
				onPointerCancel={() => (drag = undefined)}
				onWheel={zoom}
			>
				<div {...stylex.props(styles.grid)} />
				<For each={renderTiles()}>
					{(key) => {
						const rect = () =>
							mapTileScreenRect({ grid: grid(), key, viewport: viewport() });
						const path = () => artifactPaths().get(mapTileKeyId(key));
						return (
							<Show when={path()}>
								<img
									{...stylex.props(styles.tile)}
									alt={`Map tile z${key.zoom} row ${key.row} column ${key.column}`}
									draggable={false}
									src={tileUrls().get(mapTileKeyId(key))}
									onError={() => markFailed(key)}
									style={{
										height: `${rect().height}px`,
										left: `${rect().left}px`,
										top: `${rect().top}px`,
										width: `${rect().width}px`,
										"z-index": key.zoom + 1
									}}
								/>
							</Show>
						);
					}}
				</For>
				<canvas
					ref={(element) => {
						actorCanvas = element;
						paintActorOverlay();
					}}
					aria-hidden="true"
					{...stylex.props(styles.actorOverlay)}
				/>
				<div {...stylex.props(styles.preload)} aria-hidden="true">
					<For each={pendingRequests()}>
						{(key) => {
							const path = artifactPaths().get(mapTileKeyId(key));
							return path ? (
								<MapTileRequest
									keyValue={key}
									load={() => props.loadTile(key, path)}
									onFailed={markFailed}
									onLoaded={markLoaded}
								/>
							) : null;
						}}
					</For>
				</div>
				<Show when={renderTiles().length === 0}>
					<div {...stylex.props(styles.loading)}>
						{captureCoverageVisible()
							? "SEEKING COARSE COVERAGE…"
							: "OUTSIDE CAPTURE COVERAGE"}
					</div>
				</Show>
				<div {...stylex.props(styles.axisNorth)}>+X / NORTH</div>
				<div {...stylex.props(styles.axisEast)}>+Y / EAST</div>
			</div>
			<footer {...stylex.props(styles.footer)}>
				<span>WUP {grid().levels[selection().level]!.unitsPerPixel.toPrecision(5)}</span>
				<span>CACHE ≤ {selection().recommendedCacheEntries}</span>
				<span>DRAG TO PAN · WHEEL TO ZOOM</span>
			</footer>
		</section>
	);
}

const styles = stylex.create({
	frame: {
		display: "grid",
		gridTemplateRows: "auto minmax(320px, 1fr) auto",
		minHeight: 520,
		backgroundColor: tokens.colorSurface,
		border: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorText,
		fontFamily: tokens.fontMono,
		overflow: "hidden"
	},
	header: {
		display: "flex",
		alignItems: "end",
		justifyContent: "space-between",
		gap: 24,
		padding: "14px 18px 12px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface
	},
	eyebrow: { margin: 0, color: tokens.colorWarning, fontSize: 11, letterSpacing: 0 },
	title: {
		margin: "4px 0 0",
		fontFamily: tokens.fontDisplay,
		fontSize: 17,
		fontWeight: 590,
		letterSpacing: "-0.01em"
	},
	readout: {
		display: "flex",
		flexWrap: "wrap",
		justifyContent: "end",
		gap: "6px 14px",
		color: "#02b8cc",
		fontSize: 11,
		letterSpacing: 0
	},
	surface: {
		position: "relative",
		overflow: "hidden",
		cursor: "grab",
		backgroundColor: tokens.colorSurfaceInset,
		userSelect: "none",
		touchAction: "none"
	},
	grid: {
		position: "absolute",
		inset: 0,
		backgroundImage:
			"linear-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.04) 1px, transparent 1px)",
		backgroundSize: "32px 32px",
		boxShadow: "inset 0 0 120px rgba(8, 9, 10, 0.7)"
	},
	tile: {
		position: "absolute",
		display: "block",
		objectFit: "fill",
		pointerEvents: "none",
		imageRendering: "auto"
	},
	actorOverlay: {
		position: "absolute",
		zIndex: 30,
		inset: 0,
		width: "100%",
		height: "100%",
		pointerEvents: "none"
	},
	preload: { position: "absolute", width: 0, height: 0, overflow: "hidden", opacity: 0 },
	loading: {
		position: "absolute",
		left: "50%",
		top: "50%",
		transform: "translate(-50%, -50%)",
		padding: "10px 14px",
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: "rgba(8, 9, 10, 0.9)",
		color: tokens.colorWarning,
		fontSize: 11,
		letterSpacing: 0
	},
	axisNorth: { position: "absolute", top: 12, left: 14, color: "#02b8cc", fontSize: 11 },
	axisEast: { position: "absolute", right: 14, bottom: 12, color: "#02b8cc", fontSize: 11 },
	footer: {
		display: "flex",
		justifyContent: "space-between",
		gap: 16,
		padding: "8px 18px",
		borderTop: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: 0
	}
});
