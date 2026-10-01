import type { LevelSequenceProjection, SequenceSection } from "@ue-shed/protocol";

export function sectionFrames(
	section: SequenceSection,
	limit = Number.POSITIVE_INFINITY
): readonly number[] {
	const frames = new Set<number>();
	for (const key of section.text_keys) {
		if (frames.size >= limit) return [...frames];
		frames.add(key.frame);
	}
	for (const channel of [
		...section.numeric_channels,
		...section.discrete_channels,
		...section.value_channels
	]) {
		for (const key of channel.keys ?? []) {
			if (frames.size >= limit) return [...frames];
			frames.add(key.frame);
		}
	}
	return [...frames];
}

export function sequenceStats(sequence: LevelSequenceProjection) {
	const tracks = [
		...sequence.root_tracks,
		...sequence.bindings.flatMap((binding) => binding.tracks)
	];
	let sections = 0;
	let keys = 0;
	for (const track of tracks) {
		for (const section of track.sections) {
			sections++;
			keys += sectionKeyCount(section);
		}
	}
	return { tracks: tracks.length, bindings: sequence.bindings.length, sections, keys };
}

export function sectionKeyCount(section: SequenceSection): number {
	return (
		section.text_keys.length +
		[
			...section.numeric_channels,
			...section.discrete_channels,
			...section.value_channels
		].reduce((count, channel) => count + (channel.keys?.length ?? 0), 0)
	);
}

export function displayFrameScale(sequence: LevelSequenceProjection): number {
	const tick = sequence.tick_resolution;
	const display = sequence.display_rate;
	return tick && display && tick.numerator > 0 && display.denominator > 0
		? (tick.denominator / tick.numerator) * (display.numerator / display.denominator)
		: 1;
}
