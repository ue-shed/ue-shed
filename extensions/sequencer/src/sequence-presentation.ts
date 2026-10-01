import type { LevelSequenceProjection, SequenceRange, SequenceRate } from "@ue-shed/protocol";
import { displayFrameScale } from "./sequence-summary.js";

export function objectName(path: string): string {
	return path.split(/[.:]/).at(-1) ?? path;
}

export function shortSequenceType(path: string, suffix: "Track" | "Section"): string {
	const name = objectName(path).replace(/^MovieScene/, "");
	return name.replace(suffix === "Track" ? /Track$/ : /Section$/, "") || suffix;
}

export function frameRange(range: SequenceRange | null, scale = 1): string {
	if (range === null) return "Range not saved";
	const lower = range.lower.kind === "open" ? "open" : Math.round(range.lower.frame * scale);
	const upper = range.upper.kind === "open" ? "open" : Math.round(range.upper.frame * scale);
	return `${lower} → ${upper}`;
}

export function frameRangeTitle(range: SequenceRange | null): string {
	return range === null
		? "Frame range was not serialized."
		: `${frameRange(range)} frames (${range.lower.kind} → ${range.upper.kind})`;
}

export function frameRateLabel(rate: SequenceRate | null): string {
	if (rate === null) return "Frame rate not saved";
	return `${Number((rate.numerator / rate.denominator).toFixed(2))} fps`;
}

export function playbackLabel(sequence: LevelSequenceProjection): string {
	const range = sequence.playback_range;
	if (range === null) return "Playback range not saved";
	const frames = frameRange(range, displayFrameScale(sequence)).replace(" → ", "–");
	const tick = sequence.tick_resolution;
	if (tick && tick.numerator > 0 && range.lower.kind !== "open" && range.upper.kind !== "open") {
		const seconds = Math.max(
			0,
			((range.upper.frame - range.lower.frame) * tick.denominator) / tick.numerator
		);
		return `${frames} frames · ${seconds.toFixed(1)} s`;
	}
	return `${frames} frames`;
}
