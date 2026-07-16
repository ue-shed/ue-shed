import { Context, Effect, Layer } from "effect";
import {
	WorkbenchWindow,
	WorkbenchWindowError,
	type OpenDialogChoice,
	type OpenDialogOptions
} from "./electron-window.js";

export type DialogChoice = OpenDialogChoice;

export interface ChooseFileOptions {
	readonly filters?: OpenDialogOptions["filters"];
	readonly title: string;
}

export interface ChooseDirectoryOptions {
	readonly title: string;
}

export interface ElectronDialogShape {
	readonly chooseDirectory: (
		options: ChooseDirectoryOptions
	) => Effect.Effect<DialogChoice, WorkbenchWindowError>;
	readonly chooseFile: (
		options: ChooseFileOptions
	) => Effect.Effect<DialogChoice, WorkbenchWindowError>;
}

export class ElectronDialog extends Context.Service<ElectronDialog, ElectronDialogShape>()(
	"@ue-shed/workbench/ElectronDialog"
) {}

export const ElectronDialogLive = Layer.effect(
	ElectronDialog,
	Effect.gen(function* () {
		const window = yield* WorkbenchWindow;

		const chooseDirectory = Effect.fn("Workbench.ElectronDialog.chooseDirectory")(function* (
			options: ChooseDirectoryOptions
		) {
			return yield* window.openDialog({
				properties: ["openDirectory"],
				title: options.title
			});
		});

		const chooseFile = Effect.fn("Workbench.ElectronDialog.chooseFile")(function* (
			options: ChooseFileOptions
		) {
			return yield* window.openDialog({
				...(options.filters ? { filters: options.filters } : {}),
				properties: ["openFile"],
				title: options.title
			});
		});

		return ElectronDialog.of({ chooseDirectory, chooseFile });
	})
);

export const makeElectronDialogTestLayer = Layer.effect(
	ElectronDialog,
	Effect.gen(function* () {
		const window = yield* WorkbenchWindow;
		return ElectronDialog.of({
			chooseDirectory: Effect.fn("Workbench.ElectronDialog.Test.chooseDirectory")((options) =>
				window.openDialog({ properties: ["openDirectory"], title: options.title })
			),
			chooseFile: Effect.fn("Workbench.ElectronDialog.Test.chooseFile")((options) =>
				window.openDialog({
					...(options.filters ? { filters: options.filters } : {}),
					properties: ["openFile"],
					title: options.title
				})
			)
		});
	})
);
