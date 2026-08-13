import {
	MapCapturePlan,
	createMapTileGrid,
	type MapCapturePlan as MapCapturePlanValue,
	type MapTileGrid
} from "@ue-shed/cameras/map-tiles";
import { Schema } from "effect";

export type MapCapturePlanDraft = Omit<MapCapturePlanValue, "id"> & { readonly id: string };

export type MapCapturePlanValidation =
	| { readonly status: "valid"; readonly plan: MapCapturePlanValue }
	| { readonly status: "invalid"; readonly errors: ReadonlyArray<string> };

export interface MapCaptureDraftCenter {
	readonly x: number;
	readonly y: number;
}

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const gameMapPathPattern = /^\/Game\/[A-Za-z0-9_./-]+$/;

export function mapCapturePlanDraft(plan: MapCapturePlanValue): MapCapturePlanDraft {
	return { ...plan, id: plan.id };
}

export function mapCaptureDraftCenter(draft: MapCapturePlanDraft): MapCaptureDraftCenter {
	return {
		x: (draft.requestedBounds.minX + draft.requestedBounds.maxX) / 2,
		y: (draft.requestedBounds.minY + draft.requestedBounds.maxY) / 2
	};
}

export function recenterMapCapturePlanDraft(
	draft: MapCapturePlanDraft,
	center: MapCaptureDraftCenter
): MapCapturePlanDraft {
	const currentCenter = mapCaptureDraftCenter(draft);
	const deltaX = center.x - currentCenter.x;
	const deltaY = center.y - currentCenter.y;
	return {
		...draft,
		requestedBounds: {
			maxX: draft.requestedBounds.maxX + deltaX,
			maxY: draft.requestedBounds.maxY + deltaY,
			minX: draft.requestedBounds.minX + deltaX,
			minY: draft.requestedBounds.minY + deltaY
		}
	};
}

export function mapCaptureDraftSize(draft: MapCapturePlanDraft): number {
	return draft.requestedBounds.maxX - draft.requestedBounds.minX;
}

export function resizeMapCapturePlanDraft(
	draft: MapCapturePlanDraft,
	size: number
): MapCapturePlanDraft {
	const center = mapCaptureDraftCenter(draft);
	const halfSize = size / 2;
	return {
		...draft,
		requestedBounds: {
			maxX: center.x + halfSize,
			maxY: center.y + halfSize,
			minX: center.x - halfSize,
			minY: center.y - halfSize
		}
	};
}

export function setMapCaptureDraftTileSize(
	draft: MapCapturePlanDraft,
	tilePixelSize: number
): MapCapturePlanDraft {
	const tileWorldSize = draft.tilePixelSize * draft.levels.coarsestUnitsPerPixel;
	return {
		...draft,
		levels: {
			...draft.levels,
			coarsestUnitsPerPixel: tileWorldSize / tilePixelSize
		},
		tilePixelSize
	};
}

export function setMapCaptureDraftGridSize(
	draft: MapCapturePlanDraft,
	tilesPerAxis: number
): MapCapturePlanDraft {
	if (!Number.isInteger(tilesPerAxis) || tilesPerAxis < 1) return draft;
	return {
		...draft,
		levels: {
			...draft.levels,
			coarsestUnitsPerPixel: mapCaptureDraftSize(draft) / (draft.tilePixelSize * tilesPerAxis)
		}
	};
}

export function validateMapCapturePlanDraft(draft: MapCapturePlanDraft): MapCapturePlanValidation {
	const errors: string[] = [];
	if (!safeIdentifierPattern.test(draft.id)) {
		errors.push("Plan ID must start with a letter or number and use only . _ or - separators.");
	}
	if (!safeIdentifierPattern.test(draft.project.id)) {
		errors.push("Project ID must be a portable identifier.");
	}
	if (!gameMapPathPattern.test(draft.project.mapPath)) {
		errors.push("Target map must be an Unreal package path beginning with /Game/.");
	}
	const bounds = draft.requestedBounds;
	if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) {
		errors.push("Every world bound must be a finite number.");
	} else if (bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
		errors.push("Maximum X and Y bounds must be greater than their minimums.");
	} else if (bounds.maxX - bounds.minX !== bounds.maxY - bounds.minY) {
		errors.push("Workbench authors square capture areas; set one equal size for X and Y.");
	}
	if (
		!Number.isInteger(draft.tilePixelSize) ||
		draft.tilePixelSize < 64 ||
		draft.tilePixelSize > 4096
	) {
		errors.push("Tile size must be a whole number from 64 to 4096 pixels.");
	}
	if (
		!Number.isInteger(draft.gutterPixels) ||
		draft.gutterPixels < 0 ||
		draft.gutterPixels > 32
	) {
		errors.push("Gutter must be a whole number from 0 to 32 pixels.");
	}
	if (
		!Number.isInteger(draft.levels.count) ||
		draft.levels.count < 1 ||
		draft.levels.count > 24
	) {
		errors.push("Level count must be a whole number from 1 to 24.");
	}
	if (
		!Number.isFinite(draft.levels.coarsestUnitsPerPixel) ||
		draft.levels.coarsestUnitsPerPixel <= 0
	) {
		errors.push("Resolution in world units per pixel must be greater than zero.");
	}
	if (!Number.isFinite(draft.capture.z)) errors.push("Capture Z must be a finite number.");
	if (draft.capture.dataLayers.mode !== "unchanged") {
		errors.push("This editor currently supports the unchanged data-layer policy only.");
	}
	if (draft.capture.render.lodPolicy === "fixed_lod_zero") {
		errors.push("Fixed LOD zero is not supported by the current Unreal capture capability.");
	}
	if (draft.capture.render.lodPolicy === "per_level_distance_scale") {
		const scales = draft.capture.render.lodDistanceScaleByZoom;
		if (scales?.length !== draft.levels.count) {
			errors.push("LOD distance scales must contain one value for every pyramid level.");
		} else if (scales.some((value) => !Number.isFinite(value) || value < 0.1 || value > 100)) {
			errors.push("Every LOD distance scale must be between 0.1 and 100.");
		}
	}
	if (errors.length > 0) return { errors, status: "invalid" };
	try {
		return { plan: Schema.decodeUnknownSync(MapCapturePlan)(draft), status: "valid" };
	} catch {
		return {
			errors: ["The plan does not satisfy the Map Capture Plan v1 contract."],
			status: "invalid"
		};
	}
}

export function mapCaptureDraftGrid(
	validation: MapCapturePlanValidation
): { readonly grid: MapTileGrid; readonly tileCount: number } | undefined {
	if (validation.status !== "valid") return undefined;
	const plan = validation.plan;
	const grid = createMapTileGrid({
		coarsestUnitsPerPixel: plan.levels.coarsestUnitsPerPixel,
		levelCount: plan.levels.count,
		requestedBounds: plan.requestedBounds,
		tilePixelSize: plan.tilePixelSize
	});
	return {
		grid,
		tileCount: grid.levels.reduce((total, level) => total + level.rows * level.columns, 0)
	};
}
