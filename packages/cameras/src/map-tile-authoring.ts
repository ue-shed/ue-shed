import { Schema } from "effect";
import {
	MapCapturePlan,
	type MapCaptureBackend,
	type MapCapturePlan as MapCapturePlanValue
} from "./map-tile-schema.js";

export function mapCaptureBackendIssue(
	plan: MapCapturePlanValue,
	backend: MapCaptureBackend
): string | undefined {
	if (
		backend === "lit_camera_tiles" &&
		(plan.capture.render.profile !== "full_fidelity" ||
			plan.capture.render.lodPolicy !== "natural")
	) {
		return "Lit camera tiles require Full fidelity and Natural LOD. Select those settings or choose Tiled scene capture.";
	}
	if (backend !== "lit_camera_tiles" && plan.capture.render.exposureEV100 !== undefined) {
		return "Manual map exposure requires Lit camera tiles. Disable manual exposure to use another capture engine.";
	}
	return undefined;
}

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const gameMapPathPattern = /^\/Game\/[A-Za-z0-9_./-]+$/;

export function savedMapPathToGameMapPath(savedMapPath: string): string | undefined {
	const normalized = savedMapPath.replaceAll("\\", "/");
	const lower = normalized.toLocaleLowerCase();
	const contentMarker = lower.lastIndexOf("/content/");
	const contentStart = lower.startsWith("content/")
		? "content/".length
		: contentMarker < 0
			? undefined
			: contentMarker + "/content/".length;
	if (contentStart === undefined || !lower.endsWith(".umap")) return undefined;
	const packagePath = `/Game/${normalized.slice(contentStart, -".umap".length)}`;
	return gameMapPathPattern.test(packagePath) ? packagePath : undefined;
}

export function mapCaptureSafeIdentifier(value: string, fallback: string): string {
	const normalized = value
		.trim()
		.replaceAll(/[^A-Za-z0-9._-]+/g, "-")
		.replaceAll(/^[^A-Za-z0-9]+|[^A-Za-z0-9._-]+$/g, "")
		.slice(0, 128);
	return safeIdentifierPattern.test(normalized) ? normalized : fallback;
}

export function makeDefaultMapCapturePlan(args: {
	readonly mapPath?: string;
	readonly projectId: string;
}): MapCapturePlanValue {
	return Schema.decodeUnknownSync(MapCapturePlan)({
		capture: {
			dataLayers: { mode: "unchanged" },
			orientation: { pitch: -90, roll: 0, yaw: 0 },
			render: {
				effects: { fog: false, volumetricFog: false },
				lodPolicy: "natural",
				profile: "full_fidelity"
			},
			z: 5000
		},
		contract: { name: "ue-shed-map-capture-plan", version: { major: 1, minor: 0 } },
		gutterPixels: 16,
		id: "map-overview",
		levels: { coarsestUnitsPerPixel: 4, count: 3 },
		output: { imageFormat: "png", publication: "local_immutable" },
		project: {
			id: mapCaptureSafeIdentifier(args.projectId, "unreal-project"),
			mapPath:
				args.mapPath !== undefined && gameMapPathPattern.test(args.mapPath)
					? args.mapPath
					: "/Game/Maps/L_NewMap"
		},
		requestedBounds: { maxX: 1000, maxY: 1000, minX: -1000, minY: -1000 },
		tilePixelSize: 512
	});
}
