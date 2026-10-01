import { FileDropZone, MAX_ASSET_FILE_BYTES as MAX_FILE_BYTES } from "@ue-shed/ui";
import type { AssetInspectorControls, AssetInspectionReadEffect } from "./asset-inspector.js";

export const MAX_ASSET_FILE_BYTES = MAX_FILE_BYTES;

export interface AssetSample {
	readonly label: string;
	readonly load: () => AssetInspectionReadEffect;
}
export interface FileAssetOpenerProps {
	readonly controls: AssetInspectorControls;
	readonly readFile: (file: File) => AssetInspectionReadEffect;
	readonly samples?: readonly AssetSample[];
}
export function FileAssetOpener(props: FileAssetOpenerProps) {
	const controls = props.controls;
	const readFile = props.readFile;
	const samples = props.samples ?? [];
	return (
		<FileDropZone
			compact={controls.hasInspection}
			loading={controls.loading}
			label="Open asset file"
			pickerLabel="Choose a .uasset to inspect"
			dropLabel="Drop any .uasset here"
			invalidFileCopy="Choose an uncooked .uasset file."
			onOpen={(file) => controls.open(readFile(file))}
			sampleGroupLabel="Try a sample asset"
			samples={samples.map((sample) => ({
				label: sample.label,
				open: () => controls.open(sample.load())
			}))}
		/>
	);
}
