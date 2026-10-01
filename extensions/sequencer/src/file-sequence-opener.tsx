import { FileDropZone, MAX_ASSET_FILE_BYTES } from "@ue-shed/ui";
import type { SequenceOpenerControls, SequenceReadEffect } from "./sequence-viewer.js";

export const MAX_SEQUENCE_FILE_BYTES = MAX_ASSET_FILE_BYTES;

export interface FileSequenceSample {
	readonly label: string;
	readonly load: () => SequenceReadEffect;
}
export interface FileSequenceOpenerProps {
	readonly controls: SequenceOpenerControls;
	readonly readFile: (file: File) => SequenceReadEffect;
	readonly sample?: FileSequenceSample;
}
export function FileSequenceOpener(props: FileSequenceOpenerProps) {
	const controls = props.controls;
	const readFile = props.readFile;
	const sample = props.sample;
	return (
		<FileDropZone
			compact={controls.hasSequence}
			loading={controls.loading}
			label="Open sequence file"
			pickerLabel="Choose a Level Sequence .uasset"
			dropLabel="Drop a Level Sequence .uasset here"
			invalidFileCopy="Choose an uncooked Level Sequence .uasset file."
			onOpen={(file) => controls.open(readFile(file))}
			samples={
				sample === undefined
					? []
					: [{ label: sample.label, open: () => controls.open(sample.load()) }]
			}
		/>
	);
}
