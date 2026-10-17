import { ErrorGuidanceFields } from "@ue-shed/protocol";
import { Result, Schema } from "effect";
import { MapTilePixelRect, type MapTilePixelRect as PixelRect } from "./map-tile-source.js";

const Dimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 }));

/** Tightly packed, unpremultiplied sRGB RGB plus linear alpha, four bytes per pixel. */
export const MapTileImage = Schema.Struct({
	format: Schema.Literal("rgba8_srgb"),
	width: Dimension,
	height: Dimension,
	pixels: Schema.Uint8Array
}).check(
	Schema.makeFilter((image) =>
		image.pixels.byteLength === image.width * image.height * 4
			? undefined
			: "RGBA8 payload length must equal width * height * 4."
	)
);
export type MapTileImage = typeof MapTileImage.Type;

/** Same ordering as mapTileChildren: top-left, top-right, bottom-left, bottom-right. */
export const MapTileParentImages = Schema.Tuple([
	MapTileImage,
	MapTileImage,
	MapTileImage,
	MapTileImage
]);
export type MapTileParentImages = typeof MapTileParentImages.Type;

/**
 * Map source PNG decode/crop/encode failure with actionable recovery guidance. A failed image
 * must not be published as a valid tile artifact.
 */
export class MapTileImageError extends Schema.TaggedError<MapTileImageError>()(
	"MapTileImageError",
	{
		code: Schema.Literals(["invalid_image", "invalid_crop", "invalid_children"]),
		cause: Schema.optionalKey(Schema.Defect()),
		...ErrorGuidanceFields
	}
) {}

const decodeImage = Schema.decodeUnknownResult(MapTileImage, { onExcessProperty: "error" });
const decodeRect = Schema.decodeUnknownResult(MapTilePixelRect, { onExcessProperty: "error" });
const decodeChildren = Schema.decodeUnknownResult(MapTileParentImages, {
	onExcessProperty: "error"
});

function failure(code: MapTileImageError["code"], message: string, cause?: unknown) {
	return Result.fail(
		new MapTileImageError({
			...(cause === undefined ? undefined : { cause }),
			code,
			message,
			nextStep: "fix_input",
			retrySafe: true,
			recovery:
				"Decode tightly packed RGBA8 sRGB pixels, use an in-bounds crop, and supply four equal even-sized child images in mapTileChildren order."
		})
	);
}

/** A lossless copy; codecs, file IO, concurrency and artifact identities belong to the caller. */
export function cropMapTileImage(
	image: MapTileImage,
	rect: PixelRect
): Result.Result<MapTileImage, MapTileImageError> {
	const input = decodeImage(image);
	if (Result.isFailure(input))
		return failure(
			"invalid_image",
			"The map tile image buffer or dimensions are invalid.",
			input.failure
		);
	const crop = decodeRect(rect);
	if (Result.isFailure(crop))
		return failure("invalid_crop", "The map tile crop rectangle is invalid.", crop.failure);
	const area = crop.success;
	if (
		area.left + area.width > input.success.width ||
		area.top + area.height > input.success.height
	) {
		return failure("invalid_crop", "The crop extends beyond the decoded source image.");
	}
	const pixels = new Uint8Array(area.width * area.height * 4);
	for (let row = 0; row < area.height; row++) {
		const offset = ((area.top + row) * input.success.width + area.left) * 4;
		pixels.set(
			input.success.pixels.subarray(offset, offset + area.width * 4),
			row * area.width * 4
		);
	}
	return Result.succeed({ format: "rgba8_srgb", width: area.width, height: area.height, pixels });
}

// 16-bit linear-light lookup tables bound transfer quantization without per-pixel exponentiation.
const linear = Uint16Array.from({ length: 256 }, (_, value) => {
	const srgb = value / 255;
	return Math.round((srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4) * 65535);
});
const encoded = Uint8Array.from({ length: 65536 }, (_, value) => {
	const light = value / 65535;
	return Math.round(
		255 * (light <= 0.0031308 ? light * 12.92 : 1.055 * light ** (1 / 2.4) - 0.055)
	);
});

/** Derive one parent using a 2x2 linear-light box reduction with premultiplied-alpha weighting. */
export function deriveMapTileParent(
	children: MapTileParentImages
): Result.Result<MapTileImage, MapTileImageError> {
	const decoded = decodeChildren(children);
	if (Result.isFailure(decoded))
		return failure(
			"invalid_children",
			"The map tile child image layout is invalid.",
			decoded.failure
		);
	const [first] = decoded.success;
	const { width, height } = first;
	if (
		width % 2 !== 0 ||
		height % 2 !== 0 ||
		width > 4096 ||
		height > 4096 ||
		decoded.success.some((child) => child.width !== width || child.height !== height)
	) {
		return failure(
			"invalid_children",
			"Four children must have equal even dimensions of at most 4096 pixels per axis."
		);
	}
	const pixels = new Uint8Array(width * height * 4);
	const halfWidth = width / 2,
		halfHeight = height / 2,
		stride = width * 4;
	for (const [quadrant, child] of decoded.success.entries()) {
		const originRow = Math.floor(quadrant / 2) * halfHeight;
		const originColumn = (quadrant % 2) * halfWidth;
		const data = child.pixels;
		for (let row = 0; row < halfHeight; row++)
			for (let column = 0; column < halfWidth; column++) {
				const a = (row * 2 * width + column * 2) * 4;
				const b = a + 4,
					c = a + stride,
					d = c + 4;
				const target = ((originRow + row) * width + originColumn + column) * 4;
				const alphaA = data[a + 3]!,
					alphaB = data[b + 3]!,
					alphaC = data[c + 3]!,
					alphaD = data[d + 3]!;
				const alpha = alphaA + alphaB + alphaC + alphaD;
				pixels[target + 3] = Math.round(alpha / 4);
				if (pixels[target + 3] === 0) continue;
				for (let channel = 0; channel < 3; channel++) {
					const sum =
						linear[data[a + channel]!]! * alphaA +
						linear[data[b + channel]!]! * alphaB +
						linear[data[c + channel]!]! * alphaC +
						linear[data[d + channel]!]! * alphaD;
					pixels[target + channel] = encoded[Math.round(sum / alpha)]!;
				}
			}
	}
	return Result.succeed({ format: "rgba8_srgb", width, height, pixels });
}
