import { Context, Effect, Layer, Ref, Schema } from "effect";

export class WorkbenchWindowError extends Schema.TaggedErrorClass<WorkbenchWindowError>()(
	"Workbench.WorkbenchWindowError",
	{
		causeText: Schema.String,
		message: Schema.String,
		operation: Schema.Literals(["create", "load", "show", "send", "destroy", "openDialog"]),
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface WorkbenchWindowOptions {
	readonly backgroundColor: string;
	readonly height: number;
	readonly htmlPath: string;
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

export interface WorkbenchWindowShape {
	readonly destroy: () => Effect.Effect<void, WorkbenchWindowError>;
	readonly isDestroyed: () => Effect.Effect<boolean>;
	readonly load: () => Effect.Effect<void, WorkbenchWindowError>;
	readonly openDialog: (
		options: OpenDialogOptions
	) => Effect.Effect<OpenDialogChoice, WorkbenchWindowError>;
	readonly send: (channel: string, payload: unknown) => Effect.Effect<void, WorkbenchWindowError>;
	readonly show: () => Effect.Effect<void, WorkbenchWindowError>;
}

export class WorkbenchWindow extends Context.Service<WorkbenchWindow, WorkbenchWindowShape>()(
	"@ue-shed/workbench/WorkbenchWindow"
) {}

export interface WorkbenchWindowTestShape extends WorkbenchWindowShape {
	readonly sent: () => Effect.Effect<
		ReadonlyArray<{ readonly channel: string; readonly payload: unknown }>
	>;
	readonly shown: () => Effect.Effect<boolean>;
}

export class WorkbenchWindowTest extends Context.Service<
	WorkbenchWindowTest,
	WorkbenchWindowTestShape
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
										: {}),
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
	overrides: Partial<WorkbenchWindowTestShape> = {}
): Layer.Layer<WorkbenchWindow | WorkbenchWindowTest> =>
	Layer.effectContext(
		Effect.gen(function* () {
			const destroyed = yield* Ref.make(false);
			const shown = yield* Ref.make(false);
			const sent = yield* Ref.make<
				ReadonlyArray<{ readonly channel: string; readonly payload: unknown }>
			>([]);
			const nextDialog = yield* Ref.make<OpenDialogChoice>({ status: "cancelled" });

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
