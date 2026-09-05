import { Context, Effect, Layer, Ref, Schema } from "effect";

export class WorkbenchWindowError extends Schema.TaggedErrorClass<WorkbenchWindowError>()(
	"Workbench.WorkbenchWindowError",
	{
		causeText: Schema.String,
		message: Schema.String,
		operation: Schema.Literals([
			"create",
			"load",
			"show",
			"send",
			"destroy",
			"openDialog",
			"saveDialog"
		]),
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface WorkbenchWindowOptions {
	readonly backgroundColor: string;
	readonly height: number;
	readonly htmlPath: string;
	// PNG only: Electron nativeImage supports PNG/JPEG (plus ICO on Windows), not SVG,
	// so the window icon points at the rasterized favicon.png beside the renderer build.
	readonly iconPath?: string;
	readonly minHeight: number;
	readonly minWidth: number;
	readonly preloadPath: string;
	readonly title: string;
	readonly width: number;
}

export type OpenDialogChoice =
	// `paths` carries every selection when the dialog allows multiple; `path` stays the first one so
	// existing single-select callers keep working unchanged.
	| { readonly status: "selected"; readonly path: string; readonly paths?: readonly string[] }
	| { readonly status: "cancelled" };

export interface OpenDialogOptions {
	readonly filters?: ReadonlyArray<{
		readonly extensions: ReadonlyArray<string>;
		readonly name: string;
	}>;
	readonly multiSelections?: boolean;
	readonly properties: ReadonlyArray<"openFile" | "openDirectory">;
	readonly title: string;
}

export type SaveDialogChoice =
	| { readonly status: "selected"; readonly path: string }
	| { readonly status: "cancelled" };

export interface SaveDialogOptions {
	readonly defaultPath?: string;
	readonly filters?: OpenDialogOptions["filters"];
	readonly title: string;
}

export interface WorkbenchWindowApi {
	readonly destroy: () => Effect.Effect<void, WorkbenchWindowError>;
	readonly isDestroyed: () => Effect.Effect<boolean>;
	readonly load: () => Effect.Effect<void, WorkbenchWindowError>;
	readonly openDialog: (
		options: OpenDialogOptions
	) => Effect.Effect<OpenDialogChoice, WorkbenchWindowError>;
	readonly saveDialog: (
		options: SaveDialogOptions
	) => Effect.Effect<SaveDialogChoice, WorkbenchWindowError>;
	readonly send: <Payload>(
		channel: string,
		payload: Payload
	) => Effect.Effect<void, WorkbenchWindowError>;
	readonly show: () => Effect.Effect<void, WorkbenchWindowError>;
}

export class WorkbenchWindow extends Context.Service<WorkbenchWindow, WorkbenchWindowApi>()(
	"@ue-shed/workbench/WorkbenchWindow"
) {}

export interface WorkbenchWindowTestApi extends WorkbenchWindowApi {
	readonly sent: () => Effect.Effect<
		ReadonlyArray<{ readonly channel: string; readonly payload: unknown }>
	>;
	readonly shown: () => Effect.Effect<boolean>;
}

export class WorkbenchWindowTest extends Context.Service<
	WorkbenchWindowTest,
	WorkbenchWindowTestApi
>()("@ue-shed/workbench/WorkbenchWindow/Test") {}

function windowError(
	operation: WorkbenchWindowError["operation"],
	cause: unknown,
	recovery: string
): WorkbenchWindowError {
	return new WorkbenchWindowError({
		causeText: cause instanceof Error ? cause.message : String(cause),
		message: `Workbench window ${operation} failed.`,
		operation,
		recovery,
		retrySafe: false
	});
}

export const workbenchWindowLayer = (
	options: WorkbenchWindowOptions
): Layer.Layer<WorkbenchWindow, WorkbenchWindowError> =>
	Layer.effect(
		WorkbenchWindow,
		Effect.gen(function* () {
			const electron = yield* Effect.tryPromise({
				try: () => import("electron/main"),
				catch: (cause) =>
					windowError(
						"create",
						cause,
						"Restart Workbench and verify Electron can create windows."
					)
			});
			const window = yield* Effect.try({
				try: () =>
					new electron.BrowserWindow({
						backgroundColor: options.backgroundColor,
						height: options.height,
						...(options.iconPath === undefined
							? undefined
							: { icon: options.iconPath }),
						minHeight: options.minHeight,
						minWidth: options.minWidth,
						show: false,
						title: options.title,
						webPreferences: {
							// Map Review must keep consuming and painting the sparse live stream while
							// Unreal is foregrounded for Go to Actor / authoring operations.
							backgroundThrottling: false,
							contextIsolation: true,
							preload: options.preloadPath,
							sandbox: true
						},
						width: options.width
					}),
				catch: (cause) =>
					windowError(
						"create",
						cause,
						"Restart Workbench and verify Electron can create windows."
					)
			});

			yield* Effect.addFinalizer(() =>
				Effect.try({
					try: () => {
						if (!window.isDestroyed()) window.destroy();
					},
					catch: (cause) =>
						windowError("destroy", cause, "Close the Electron process manually.")
				}).pipe(Effect.ignore)
			);

			return WorkbenchWindow.of({
				load: Effect.fn("Workbench.WorkbenchWindow.load")(() =>
					Effect.callback<void, WorkbenchWindowError>((resume) => {
						const onReadyToShow = () => resume(Effect.void);
						window.once("ready-to-show", onReadyToShow);
						void window.loadFile(options.htmlPath).then(
							() => undefined,
							(cause) => {
								window.removeListener("ready-to-show", onReadyToShow);
								resume(
									Effect.fail(
										windowError(
											"load",
											cause,
											"Verify the Workbench renderer build exists beside the main process."
										)
									)
								);
							}
						);
						return Effect.sync(() => {
							window.removeListener("ready-to-show", onReadyToShow);
						});
					})
				),
				show: Effect.fn("Workbench.WorkbenchWindow.show")(() =>
					Effect.try({
						try: () => {
							if (!window.isDestroyed()) window.show();
						},
						catch: (cause) => windowError("show", cause, "Restart Workbench and retry.")
					})
				),
				send: Effect.fn("Workbench.WorkbenchWindow.send")(function* (channel, payload) {
					if (window.isDestroyed()) {
						return yield* Effect.fail(
							windowError(
								"send",
								"Window is destroyed",
								"Ignore late renderer deliveries after shutdown."
							)
						);
					}
					yield* Effect.try({
						try: () => {
							window.webContents.send(channel, payload);
						},
						catch: (cause) =>
							windowError("send", cause, "Retry after the renderer finishes loading.")
					});
				}),
				openDialog: Effect.fn("Workbench.WorkbenchWindow.openDialog")(
					function* (dialogOptions) {
						if (window.isDestroyed()) {
							return yield* Effect.fail(
								windowError(
									"openDialog",
									"Window is destroyed",
									"Reopen Workbench and retry."
								)
							);
						}
						const choice = yield* Effect.tryPromise({
							try: () =>
								electron.dialog.showOpenDialog(window, {
									...(dialogOptions.filters
										? {
												filters: dialogOptions.filters.map((filter) => ({
													extensions: [...filter.extensions],
													name: filter.name
												}))
											}
										: undefined),
									properties: [
										...dialogOptions.properties,
										...(dialogOptions.multiSelections
											? ["multiSelections" as const]
											: [])
									],
									title: dialogOptions.title
								}),
							catch: (cause) =>
								windowError(
									"openDialog",
									cause,
									"Retry the dialog after the window is visible."
								)
						});
						const path = choice.filePaths[0];
						return choice.canceled || !path
							? ({ status: "cancelled" } as const)
							: ({ status: "selected", path, paths: choice.filePaths } as const);
					}
				),
				saveDialog: Effect.fn("Workbench.WorkbenchWindow.saveDialog")(
					function* (dialogOptions) {
						if (window.isDestroyed()) {
							return yield* Effect.fail(
								windowError(
									"saveDialog",
									"Window is destroyed",
									"Reopen Workbench and retry."
								)
							);
						}
						const choice = yield* Effect.tryPromise({
							try: () =>
								electron.dialog.showSaveDialog(window, {
									...(dialogOptions.defaultPath
										? { defaultPath: dialogOptions.defaultPath }
										: undefined),
									...(dialogOptions.filters
										? {
												filters: dialogOptions.filters.map((filter) => ({
													extensions: [...filter.extensions],
													name: filter.name
												}))
											}
										: undefined),
									title: dialogOptions.title
								}),
							catch: (cause) =>
								windowError(
									"saveDialog",
									cause,
									"Retry the dialog after the window is visible."
								)
						});
						return choice.canceled || !choice.filePath
							? ({ status: "cancelled" } as const)
							: ({ status: "selected", path: choice.filePath } as const);
					}
				),
				isDestroyed: Effect.fn("Workbench.WorkbenchWindow.isDestroyed")(() =>
					Effect.sync(() => window.isDestroyed())
				),
				destroy: Effect.fn("Workbench.WorkbenchWindow.destroy")(() =>
					Effect.try({
						try: () => {
							if (!window.isDestroyed()) window.destroy();
						},
						catch: (cause) =>
							windowError("destroy", cause, "Close the Electron process manually.")
					})
				)
			});
		})
	);

export const makeWorkbenchWindowTestLayer = (
	overrides: Partial<WorkbenchWindowTestApi> = {}
): Layer.Layer<WorkbenchWindow | WorkbenchWindowTest> =>
	Layer.effectContext(
		Effect.gen(function* () {
			const destroyed = yield* Ref.make(false);
			const shown = yield* Ref.make(false);
			const sent = yield* Ref.make<
				ReadonlyArray<{ readonly channel: string; readonly payload: unknown }>
			>([]);
			const nextDialog = yield* Ref.make<OpenDialogChoice>({ status: "cancelled" });
			const nextSaveDialog = yield* Ref.make<SaveDialogChoice>({ status: "cancelled" });

			const service = WorkbenchWindowTest.of({
				destroy:
					overrides.destroy ??
					Effect.fn("Workbench.WorkbenchWindow.Test.destroy")(() =>
						Ref.set(destroyed, true)
					),
				isDestroyed:
					overrides.isDestroyed ??
					Effect.fn("Workbench.WorkbenchWindow.Test.isDestroyed")(() =>
						Ref.get(destroyed)
					),
				load:
					overrides.load ??
					Effect.fn("Workbench.WorkbenchWindow.Test.load")(() => Effect.void),
				openDialog:
					overrides.openDialog ??
					Effect.fn("Workbench.WorkbenchWindow.Test.openDialog")(function* () {
						if (yield* Ref.get(destroyed)) {
							return yield* Effect.fail(
								windowError(
									"openDialog",
									"Window is destroyed",
									"Reopen Workbench and retry."
								)
							);
						}
						return yield* Ref.get(nextDialog);
					}),
				saveDialog:
					overrides.saveDialog ??
					Effect.fn("Workbench.WorkbenchWindow.Test.saveDialog")(function* () {
						if (yield* Ref.get(destroyed)) {
							return yield* Effect.fail(
								windowError(
									"saveDialog",
									"Window is destroyed",
									"Reopen Workbench and retry."
								)
							);
						}
						return yield* Ref.get(nextSaveDialog);
					}),
				send:
					overrides.send ??
					Effect.fn("Workbench.WorkbenchWindow.Test.send")(function* (channel, payload) {
						if (yield* Ref.get(destroyed)) {
							return yield* Effect.fail(
								windowError(
									"send",
									"Window is destroyed",
									"Ignore late renderer deliveries after shutdown."
								)
							);
						}
						yield* Ref.update(sent, (current) => [...current, { channel, payload }]);
					}),
				show:
					overrides.show ??
					Effect.fn("Workbench.WorkbenchWindow.Test.show")(() => Ref.set(shown, true)),
				sent: () => Ref.get(sent),
				shown: () => Ref.get(shown)
			});

			return Context.empty().pipe(
				Context.add(WorkbenchWindow, service),
				Context.add(WorkbenchWindowTest, service)
			);
		})
	);
