import {
	actorInstanceKey,
	materializeObservedActor,
	StreamActorIndex,
	type ActorId,
	type ObservedActor,
	type WorldActorCatalogEntry,
	type WorldActorSnapshot,
	type WorldObservationSample,
	type WorldTransform
} from "@ue-shed/observatory/presentation";
import type { SavedWorld } from "@ue-shed/protocol";
import {
	pointMapCanvasAspect,
	pointMapClampViewportSize,
	pointMapColorForClass,
	pointMapFitViewportSize,
	pointMapMarkerRadius,
	pointMapMinViewportSize,
	pointMapPanViewportBy,
	pointMapResizeCanvasForDisplay,
	pointMapResizeViewportToSize,
	pointMapStabilizeViewport,
	pointMapViewportSizeLimits,
	pointMapWorldWindowSize,
	pointMapZoomViewportAt,
	type PointMapBounds,
	type PointMapViewport
} from "@ue-shed/ui/point-map-core";

export type WorldScoutBounds = PointMapBounds;
export type WorldScoutViewport = PointMapViewport;
export const worldScoutPickRadiusFraction = 0.06;
export const worldScoutMinViewportSize = pointMapMinViewportSize;
export const worldScoutDefaultActorCoverage = 0.95;
export const fitViewportSize = pointMapFitViewportSize;
export const viewportSizeLimits = pointMapViewportSizeLimits;
export const clampViewportSize = pointMapClampViewportSize;
export const colorForClass = pointMapColorForClass;
export const worldScoutMarkerRadius = pointMapMarkerRadius;
export const zoomViewportAt = pointMapZoomViewportAt;
export const resizeViewportToSize = pointMapResizeViewportToSize;
export const panViewportBy = pointMapPanViewportBy;
export const canvasAspect = pointMapCanvasAspect;
export const worldWindowSize = pointMapWorldWindowSize;
export const resizeCanvasForDisplay = pointMapResizeCanvasForDisplay;

export function formatCoordinate(value: number): string {
	return `${value >= 0 ? "+" : "−"}${Math.abs(Math.round(value)).toLocaleString()}`;
}

export interface WorldScoutActorRecord {
	readonly bounds: WorldActorCatalogEntry["bounds"];
	readonly className: string;
	readonly displayName: string;
	readonly id?: ActorId;
	readonly instanceKey: string;
	readonly packageName?: string;
	readonly path: string;
	readonly streamIndex: number;
}

function growFloat64(source: Float64Array, capacity: number): Float64Array {
	const next = new Float64Array(capacity);
	next.set(source.subarray(0, Math.min(source.length, capacity)));
	return next;
}

function growArray<T>(source: Array<T | undefined>, capacity: number): Array<T | undefined> {
	const next = Array.from<T | undefined>({ length: capacity });
	for (let index = 0; index < source.length; index += 1) next[index] = source[index];
	return next;
}

/**
 * Retained World Scout presentation store. Catalog metadata and transforms live in dense
 * parallel arrays keyed by stream index so transform batches update without allocating
 * ObservedActor / projected point objects per sample.
 *
 * Hot-path scratch buffers (`xs`, `ys`, `visibleIndices`) are reused across paints. Callers must
 * treat them as owned by this store for the duration of a paint/hit-test and not retain aliases
 * across frames.
 */
export class WorldScoutRetainedStore {
	classNames: Array<string | undefined> = [];
	displayNames: Array<string | undefined> = [];
	ids: Array<ActorId | undefined> = [];
	instanceKeys: Array<string | undefined> = [];
	packageNames: Array<string | undefined> = [];
	paths: Array<string | undefined> = [];
	boundCenterX: Float64Array = new Float64Array(0);
	boundCenterY: Float64Array = new Float64Array(0);
	boundExtentX: Float64Array = new Float64Array(0);
	boundExtentY: Float64Array = new Float64Array(0);
	locationX: Float64Array = new Float64Array(0);
	locationY: Float64Array = new Float64Array(0);
	locationZ: Float64Array = new Float64Array(0);
	rotationX: Float64Array = new Float64Array(0);
	rotationY: Float64Array = new Float64Array(0);
	rotationZ: Float64Array = new Float64Array(0);
	capacity = 0;
	count = 0;
	capturedAt: string | undefined;
	mapPath: string | undefined;
	worldKind: "editor" | "pie" | "saved" | undefined;
	worldSeconds = 0;
	viewport: WorldScoutViewport | undefined;
	/** Scratch: CSS-pixel X for visible actors during the current paint/hit pass. */
	xs = new Float64Array(0);
	/** Scratch: CSS-pixel Y for visible actors during the current paint/hit pass. */
	ys = new Float64Array(0);
	/** Scratch: dense stream indices included in the current visible projection. */
	visibleIndices: number[] = [];

	clear(): void {
		this.count = 0;
		this.capturedAt = undefined;
		this.mapPath = undefined;
		this.worldKind = undefined;
		this.worldSeconds = 0;
		this.viewport = undefined;
		this.visibleIndices.length = 0;
	}

	ensureCapacity(next: number): void {
		if (next <= this.capacity) return;
		const grow = Math.max(next, this.capacity === 0 ? 32 : this.capacity * 2);
		this.classNames = growArray(this.classNames, grow);
		this.displayNames = growArray(this.displayNames, grow);
		this.ids = growArray(this.ids, grow);
		this.instanceKeys = growArray(this.instanceKeys, grow);
		this.packageNames = growArray(this.packageNames, grow);
		this.paths = growArray(this.paths, grow);
		this.boundCenterX = growFloat64(this.boundCenterX, grow);
		this.boundCenterY = growFloat64(this.boundCenterY, grow);
		this.boundExtentX = growFloat64(this.boundExtentX, grow);
		this.boundExtentY = growFloat64(this.boundExtentY, grow);
		this.locationX = growFloat64(this.locationX, grow);
		this.locationY = growFloat64(this.locationY, grow);
		this.locationZ = growFloat64(this.locationZ, grow);
		this.rotationX = growFloat64(this.rotationX, grow);
		this.rotationY = growFloat64(this.rotationY, grow);
		this.rotationZ = growFloat64(this.rotationZ, grow);
		this.xs = new Float64Array(grow);
		this.ys = new Float64Array(grow);
		this.capacity = grow;
	}

	installCatalog(sample: WorldObservationSample): void {
		const { catalog, transforms } = sample;
		this.ensureCapacity(catalog.entries.length);
		this.count = catalog.entries.length;
		this.capturedAt = catalog.capturedAt;
		this.mapPath = catalog.mapPath;
		this.worldKind = catalog.worldKind;
		this.worldSeconds = sample.sampleWorldSeconds;
		for (const entry of catalog.entries) {
			this.writeMeta(entry.streamIndex, entry);
			const transform = transforms.get(entry.streamIndex);
			if (transform !== undefined) this.writeTransform(entry.streamIndex, transform);
		}
		this.viewport = undefined;
	}

	installSnapshot(snapshot: WorldActorSnapshot): void {
		this.ensureCapacity(snapshot.actors.length);
		this.count = snapshot.actors.length;
		this.capturedAt = snapshot.capturedAt;
		this.mapPath = snapshot.mapPath;
		this.worldKind = snapshot.worldKind;
		this.worldSeconds = snapshot.worldSeconds;
		for (let index = 0; index < snapshot.actors.length; index += 1) {
			const actor = snapshot.actors[index];
			if (actor === undefined) continue;
			this.writeMeta(index, {
				bounds: actor.bounds,
				className: actor.className,
				displayName: actor.displayName,
				id: actor.id,
				path: actor.path
			});
			this.writeTransform(index, {
				location: actor.location,
				rotation: actor.rotation
			});
		}
		this.viewport = undefined;
	}

	/**
	 * Installs the resolved saved-package projection. Saved actors intentionally have no live
	 * `ActorId`, bounds, or time sample; callers must not turn this data into an editor action.
	 */
	installSavedWorld(world: SavedWorld): void {
		const resolved = world.actors.flatMap((actor) =>
			actor.transform.status === "resolved"
				? [{ actor, location: actor.transform.location }]
				: []
		);
		this.ensureCapacity(resolved.length);
		this.count = resolved.length;
		this.capturedAt = undefined;
		this.mapPath = world.authority.mapPackage;
		this.worldKind = "saved";
		this.worldSeconds = 0;
		for (let index = 0; index < resolved.length; index += 1) {
			const entry = resolved[index];
			if (entry === undefined) continue;
			this.writeMeta(index, {
				bounds: {
					center: { x: entry.location.x, y: entry.location.y, z: entry.location.z },
					extent: { x: 0, y: 0, z: 0 }
				},
				className: terminalPathSegment(entry.actor.classPath),
				displayName: entry.actor.label ?? terminalPathSegment(entry.actor.actorPath),
				instanceKey: entry.actor.actorGuid ?? entry.actor.packageName,
				packageName: entry.actor.packageName,
				path: entry.actor.actorPath
			});
			this.writeTransform(index, {
				location: entry.location,
				rotation: { x: 0, y: 0, z: 0 }
			});
		}
		this.viewport = undefined;
	}

	applyTransforms(
		transforms: ReadonlyArray<{
			readonly streamIndex: number;
			readonly transform: WorldTransform;
		}>,
		worldSeconds: number
	): void {
		this.worldSeconds = worldSeconds;
		for (const entry of transforms) this.writeTransform(entry.streamIndex, entry.transform);
	}

	actorAt(streamIndex: number): WorldScoutActorRecord | undefined {
		if (streamIndex < 0 || streamIndex >= this.count) return undefined;
		const path = this.paths[streamIndex];
		const displayName = this.displayNames[streamIndex];
		const className = this.classNames[streamIndex];
		const instanceKey = this.instanceKeys[streamIndex];
		if (
			path === undefined ||
			displayName === undefined ||
			className === undefined ||
			instanceKey === undefined
		) {
			return undefined;
		}
		return {
			bounds: {
				center: {
					x: this.boundCenterX[streamIndex] ?? 0,
					y: this.boundCenterY[streamIndex] ?? 0,
					z: 0
				},
				extent: {
					x: this.boundExtentX[streamIndex] ?? 0,
					y: this.boundExtentY[streamIndex] ?? 0,
					z: 0
				}
			},
			className,
			displayName,
			...(this.ids[streamIndex] === undefined ? undefined : { id: this.ids[streamIndex] }),
			instanceKey,
			...(this.packageNames[streamIndex] === undefined
				? undefined
				: { packageName: this.packageNames[streamIndex] }),
			path,
			streamIndex
		};
	}

	materialize(streamIndex: number): ObservedActor | undefined {
		const meta = this.actorAt(streamIndex);
		if (meta === undefined || meta.id === undefined) return undefined;
		return materializeObservedActor(
			{
				bounds: meta.bounds,
				className: meta.className,
				displayName: meta.displayName,
				id: meta.id,
				path: meta.path,
				streamIndex: StreamActorIndex.make(streamIndex)
			},
			{
				location: {
					x: this.locationX[streamIndex] ?? 0,
					y: this.locationY[streamIndex] ?? 0,
					z: this.locationZ[streamIndex] ?? 0
				},
				rotation: {
					x: this.rotationX[streamIndex] ?? 0,
					y: this.rotationY[streamIndex] ?? 0,
					z: this.rotationZ[streamIndex] ?? 0
				}
			}
		);
	}

	findByInstanceKey(instanceKey: string): number | undefined {
		for (let index = 0; index < this.count; index += 1) {
			if (this.instanceKeys[index] === instanceKey) return index;
		}
		return undefined;
	}

	classCounts(): Array<[string, number]> {
		const counts = new Map<string, number>();
		for (let index = 0; index < this.count; index += 1) {
			const className = this.classNames[index];
			if (className === undefined) continue;
			counts.set(className, (counts.get(className) ?? 0) + 1);
		}
		return [...counts].toSorted(([left], [right]) => left.localeCompare(right));
	}

	private writeMeta(
		streamIndex: number,
		entry: {
			readonly bounds: WorldActorCatalogEntry["bounds"];
			readonly className: string;
			readonly displayName: string;
			readonly id?: ActorId;
			readonly instanceKey?: string;
			readonly packageName?: string;
			readonly path: string;
		}
	): void {
		this.ids[streamIndex] = entry.id;
		this.packageNames[streamIndex] = entry.packageName;
		this.paths[streamIndex] = entry.path;
		this.displayNames[streamIndex] = entry.displayName;
		this.classNames[streamIndex] = entry.className;
		this.instanceKeys[streamIndex] =
			entry.instanceKey ??
			(entry.id === undefined
				? entry.path
				: actorInstanceKey({ className: entry.className, path: entry.path }));
		this.boundCenterX[streamIndex] = entry.bounds.center.x;
		this.boundCenterY[streamIndex] = entry.bounds.center.y;
		this.boundExtentX[streamIndex] = entry.bounds.extent.x;
		this.boundExtentY[streamIndex] = entry.bounds.extent.y;
		// Seed draw position from catalog bounds so the map is visible before the first
		// transform packet arrives (and when a reconnect leaves transforms sparse).
		this.locationX[streamIndex] = entry.bounds.center.x;
		this.locationY[streamIndex] = entry.bounds.center.y;
		this.locationZ[streamIndex] = entry.bounds.center.z;
	}

	private writeTransform(streamIndex: number, transform: WorldTransform): void {
		if (streamIndex < 0 || streamIndex >= this.capacity) return;
		this.locationX[streamIndex] = transform.location.x;
		this.locationY[streamIndex] = transform.location.y;
		this.locationZ[streamIndex] = transform.location.z;
		this.rotationX[streamIndex] = transform.rotation.x;
		this.rotationY[streamIndex] = transform.rotation.y;
		this.rotationZ[streamIndex] = transform.rotation.z;
	}
}

function terminalPathSegment(path: string): string {
	const separator = Math.max(path.lastIndexOf("."), path.lastIndexOf("/"));
	return separator < 0 ? path : path.slice(separator + 1);
}

export function actorMatchesFilter(
	store: WorldScoutRetainedStore,
	streamIndex: number,
	query: string,
	hiddenClasses: ReadonlySet<string>
): boolean {
	const className = store.classNames[streamIndex];
	const displayName = store.displayNames[streamIndex];
	if (className === undefined || displayName === undefined) return false;
	if (hiddenClasses.has(className)) return false;
	const normalized = query.trim().toLocaleLowerCase();
	if (!normalized) return true;
	return (
		displayName.toLocaleLowerCase().includes(normalized) ||
		className.toLocaleLowerCase().includes(normalized)
	);
}

export function contentBounds(
	store: WorldScoutRetainedStore,
	visibleIndices: ReadonlyArray<number>
):
	| { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number }
	| undefined {
	if (visibleIndices.length === 0) return undefined;
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const index of visibleIndices) {
		const x = store.locationX[index] ?? 0;
		const y = store.locationY[index] ?? 0;
		const extentX = store.boundExtentX[index] ?? 0;
		const extentY = store.boundExtentY[index] ?? 0;
		minX = Math.min(minX, x - extentX);
		maxX = Math.max(maxX, x + extentX);
		minY = Math.min(minY, y - extentY);
		maxY = Math.max(maxY, y + extentY);
	}
	if (!Number.isFinite(minX)) return undefined;
	return { maxX, maxY, minX, minY };
}

function shortestCoveredInterval(
	values: ReadonlyArray<number>,
	coverage: number
): { readonly min: number; readonly max: number } | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	const count = Math.max(1, Math.min(sorted.length, Math.ceil(sorted.length * coverage)));
	let bestStart = 0;
	let bestSpan = Number.POSITIVE_INFINITY;
	for (let start = 0; start <= sorted.length - count; start += 1) {
		const min = sorted[start];
		const max = sorted[start + count - 1];
		if (min === undefined || max === undefined) continue;
		const span = max - min;
		if (span < bestSpan) {
			bestStart = start;
			bestSpan = span;
		}
	}
	return {
		min: sorted[bestStart] ?? 0,
		max: sorted[bestStart + count - 1] ?? 0
	};
}

/**
 * A useful initial window based on the densest interval containing most actor centers on each
 * axis. Full actor bounds remain authoritative for the slider's zoom-out ceiling; this view only
 * chooses a legible default when global sky, ocean, or weather actors report enormous bounds.
 */
export function representativeContentBounds(
	store: WorldScoutRetainedStore,
	visibleIndices: ReadonlyArray<number>,
	coverage = worldScoutDefaultActorCoverage
): WorldScoutBounds | undefined {
	const clampedCoverage = Math.min(1, Math.max(0, coverage));
	const xs: number[] = [];
	const ys: number[] = [];
	for (const index of visibleIndices) {
		const x = store.locationX[index];
		const y = store.locationY[index];
		if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
			continue;
		}
		xs.push(x);
		ys.push(y);
	}
	const x = shortestCoveredInterval(xs, clampedCoverage);
	const y = shortestCoveredInterval(ys, clampedCoverage);
	if (x === undefined || y === undefined) return undefined;
	return { minX: x.min, maxX: x.max, minY: y.min, maxY: y.max };
}

/** Recenter on a selected point with useful context, without backing out of a closer manual view. */
export function focusViewportOnActor(args: {
	readonly actorExtent: number;
	readonly centerX: number;
	readonly centerY: number;
	readonly currentSize: number | undefined;
	readonly fullFitSize: number;
	readonly usefulFitSize: number;
}): WorldScoutViewport {
	const fullFitSize = Math.max(1, args.fullFitSize);
	const usefulFitSize = Math.max(1, Math.min(args.usefulFitSize, fullFitSize));
	const minimumContext = usefulFitSize / 8;
	const boundedExtentContext = Math.min(Math.max(0, args.actorExtent) * 8, usefulFitSize / 2);
	const desiredSize = Math.max(
		Math.min(worldScoutMinViewportSize, fullFitSize),
		minimumContext,
		boundedExtentContext
	);
	const currentSize = Math.max(1, Math.min(args.currentSize ?? fullFitSize, fullFitSize));
	return {
		centerX: args.centerX,
		centerY: args.centerY,
		size: Math.min(currentSize, desiredSize)
	};
}

/**
 * Stable top-down viewport with hysteresis so ordinary actor motion does not make circles pulse.
 * `aspect` is canvas width/height; `size` is the world-space width of the window that fits content
 * at that aspect. Expands promptly when content exceeds the retained window; shrinks only after
 * content fits well inside; recenters only after the content center drifts past a fraction of size.
 */
export function stabilizeViewport(
	previous: WorldScoutViewport | undefined,
	bounds: WorldScoutBounds | undefined,
	aspect = 1,
	paddingRatio = 0.08
): WorldScoutViewport {
	return pointMapStabilizeViewport(previous, bounds, aspect, paddingRatio);
}

export function collectVisibleIndices(
	store: WorldScoutRetainedStore,
	query: string,
	hiddenClasses: ReadonlySet<string>,
	into: number[]
): number[] {
	into.length = 0;
	for (let index = 0; index < store.count; index += 1) {
		if (actorMatchesFilter(store, index, query, hiddenClasses)) into.push(index);
	}
	return into;
}

/** Project visible actors into CSS-pixel scratch buffers using the retained viewport. */
export function projectVisibleActors(
	store: WorldScoutRetainedStore,
	viewport: WorldScoutViewport,
	cssWidth: number,
	cssHeight: number,
	visibleIndices: ReadonlyArray<number>
): void {
	const aspect = canvasAspect(cssWidth, cssHeight);
	const { width: worldWidth, height: worldHeight } = worldWindowSize(viewport, aspect);
	const left = viewport.centerX - worldWidth / 2;
	const top = viewport.centerY + worldHeight / 2;
	const width = Math.max(cssWidth, 1);
	const height = Math.max(cssHeight, 1);
	for (let offset = 0; offset < visibleIndices.length; offset += 1) {
		const index = visibleIndices[offset] ?? 0;
		const x = store.locationX[index] ?? 0;
		const y = store.locationY[index] ?? 0;
		store.xs[offset] = ((x - left) / worldWidth) * width;
		store.ys[offset] = ((top - y) / worldHeight) * height;
	}
}

export function hitTestVisibleActors(
	store: WorldScoutRetainedStore,
	visibleCount: number,
	cssX: number,
	cssY: number,
	cssWidth: number,
	cssHeight: number
): number | undefined {
	const radius = Math.min(cssWidth, cssHeight) * worldScoutPickRadiusFraction;
	let bestIndex: number | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let offset = 0; offset < visibleCount; offset += 1) {
		const dx = (store.xs[offset] ?? 0) - cssX;
		const dy = (store.ys[offset] ?? 0) - cssY;
		const distance = Math.hypot(dx, dy);
		if (distance > radius || distance >= bestDistance) continue;
		bestDistance = distance;
		bestIndex = store.visibleIndices[offset];
	}
	return bestIndex;
}

export function nearestVisibleActor(
	store: WorldScoutRetainedStore,
	fromStreamIndex: number | undefined,
	direction: "next" | "previous" | "nearest"
): number | undefined {
	const visible = store.visibleIndices;
	if (visible.length === 0) return undefined;
	if (direction === "nearest" || fromStreamIndex === undefined) return visible[0];
	const currentOffset = visible.indexOf(fromStreamIndex);
	if (currentOffset < 0) return visible[0];
	if (direction === "next") return visible[(currentOffset + 1) % visible.length];
	return visible[(currentOffset - 1 + visible.length) % visible.length];
}

export type WorldScoutPaintContext = Pick<
	CanvasRenderingContext2D,
	| "arc"
	| "beginPath"
	| "clearRect"
	| "fill"
	| "fillStyle"
	| "lineWidth"
	| "moveTo"
	| "stroke"
	| "strokeStyle"
>;

export function paintWorldScout(
	context: WorldScoutPaintContext,
	store: WorldScoutRetainedStore,
	visibleCount: number,
	selectedStreamIndex: number | undefined,
	cssWidth: number,
	cssHeight: number
): void {
	context.clearRect(0, 0, cssWidth, cssHeight);
	const normalRadius = worldScoutMarkerRadius(visibleCount, cssWidth, cssHeight, false);
	const selectedRadius = worldScoutMarkerRadius(visibleCount, cssWidth, cssHeight, true);
	const offsetsByClass = new Map<string, number[]>();
	let selectedOffset: number | undefined;
	for (let offset = 0; offset < visibleCount; offset += 1) {
		const streamIndex = store.visibleIndices[offset] ?? 0;
		if (streamIndex === selectedStreamIndex) {
			selectedOffset = offset;
			continue;
		}
		const className = store.classNames[streamIndex] ?? "Actor";
		const offsets = offsetsByClass.get(className);
		if (offsets === undefined) offsetsByClass.set(className, [offset]);
		else offsets.push(offset);
	}
	for (const [className, offsets] of offsetsByClass) {
		context.beginPath();
		for (const offset of offsets) {
			const x = store.xs[offset] ?? 0;
			const y = store.ys[offset] ?? 0;
			// Each marker must begin its own subpath. Without moveTo, Canvas joins the
			// previous circle to this one and turns a dense class into a filled web.
			context.moveTo(x + normalRadius, y);
			context.arc(x, y, normalRadius, 0, Math.PI * 2);
		}
		context.fillStyle = colorForClass(className);
		context.fill();
		context.lineWidth = 1;
		context.strokeStyle = "rgba(255, 255, 255, 0.22)";
		context.stroke();
	}
	if (selectedOffset !== undefined) {
		const streamIndex = store.visibleIndices[selectedOffset] ?? 0;
		context.beginPath();
		context.arc(
			store.xs[selectedOffset] ?? 0,
			store.ys[selectedOffset] ?? 0,
			selectedRadius,
			0,
			Math.PI * 2
		);
		context.fillStyle = colorForClass(store.classNames[streamIndex] ?? "Actor");
		context.fill();
		context.lineWidth = 2;
		context.strokeStyle = "#ffffff";
		context.stroke();
	}
}

/**
 * Coalesce presentation paints: multiple dirty marks before the next animation frame become one
 * paint. Tests may replace the scheduler to assert coalescing without a real browser rAF.
 */
export interface WorldScoutPaintGate {
	readonly markDirty: () => void;
	readonly pending: () => boolean;
	readonly flushNow: () => void;
	readonly dispose: () => void;
	readonly scheduledCount: () => number;
}

export function createWorldScoutPaintGate(
	paint: () => void,
	schedule: (callback: () => void) => number = (callback) =>
		requestAnimationFrame(() => callback()),
	cancel: (handle: number) => void = (handle) => cancelAnimationFrame(handle)
): WorldScoutPaintGate {
	let dirty = false;
	let handle: number | undefined;
	let scheduled = 0;
	const run = () => {
		handle = undefined;
		if (!dirty) return;
		dirty = false;
		paint();
	};
	return {
		dispose: () => {
			if (handle !== undefined) cancel(handle);
			handle = undefined;
			dirty = false;
		},
		flushNow: run,
		markDirty: () => {
			dirty = true;
			if (handle !== undefined) return;
			scheduled += 1;
			handle = schedule(run);
		},
		pending: () => dirty || handle !== undefined,
		scheduledCount: () => scheduled
	};
}
