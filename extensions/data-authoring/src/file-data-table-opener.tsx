import { FileDropZone } from "@ue-shed/ui";
import type { AuthoringOpenerControls, AuthoringReadEffect } from "./data-table-viewer.js";

export interface FileDataTableOpenerProps<E = never> {
	readonly controls: AuthoringOpenerControls;
	readonly readFile: (file: File) => AuthoringReadEffect<E>;
	readonly sample?: { readonly label: string; readonly load: () => AuthoringReadEffect<E> };
}

export function FileDataTableOpener<E = never>(props: FileDataTableOpenerProps<E>) {
	const controls = props.controls;
	const readFile = props.readFile;
	const sample = props.sample;
	return (
		<FileDropZone
			compact={controls.hasTable}
			loading={controls.loading}
			label="Open DataTable file"
			pickerLabel="Choose a DataTable .uasset"
			dropLabel="Drop a DataTable .uasset here"
			invalidFileCopy="Choose an uncooked DataTable .uasset file."
			onOpen={(file) => controls.open(readFile(file))}
			samples={
				sample === undefined
					? []
					: [{ label: sample.label, open: () => controls.open(sample.load()) }]
			}
		/>
	);
}
