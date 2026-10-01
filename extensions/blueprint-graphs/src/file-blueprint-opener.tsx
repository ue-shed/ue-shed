import { FileDropZone, MAX_ASSET_FILE_BYTES } from "@ue-shed/ui";
import type {
	BlueprintGraphOpenerControls,
	BlueprintGraphReadEffect
} from "./blueprint-graph-viewer.js";

export const MAX_BLUEPRINT_FILE_BYTES = MAX_ASSET_FILE_BYTES;

export interface FileBlueprintSample {
	readonly label: string;
	readonly load: () => BlueprintGraphReadEffect;
}
export interface FileBlueprintOpenerProps {
	readonly controls: BlueprintGraphOpenerControls;
	readonly readFile: (file: File) => BlueprintGraphReadEffect;
	readonly sample?: FileBlueprintSample;
}
export function FileBlueprintOpener(props: FileBlueprintOpenerProps) {
	const controls = props.controls;
	const readFile = props.readFile;
	const sample = props.sample;
	return (
		<FileDropZone
			compact={controls.hasBlueprint}
			loading={controls.loading}
			label="Open Blueprint file"
			pickerLabel="Choose a Blueprint .uasset"
			dropLabel="Drop a Blueprint .uasset here"
			invalidFileCopy="Choose an uncooked Blueprint .uasset file."
			onOpen={(file) => controls.open(readFile(file))}
			samples={
				sample === undefined
					? []
					: [{ label: sample.label, open: () => controls.open(sample.load()) }]
			}
		/>
	);
}
