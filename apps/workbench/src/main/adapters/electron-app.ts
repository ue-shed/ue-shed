import { Context, Effect, Layer, Ref, Schema } from "effect";

export class ElectronAppError extends Schema.TaggedErrorClass<ElectronAppError>()(
	"Workbench.ElectronAppError",
	{
		causeText: Schema.String,
		message: Schema.String,
		operation: Schema.Literals(["whenReady", "getAppMetrics", "quit", "on"]),
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface ElectronProcessMetric {
	readonly memory: {
		readonly privateBytes?: number;
		readonly workingSetSize: number;
	};
	readonly type: string;
}

export type ElectronAppEvent = "window-all-closed" | "before-quit";

export interface ElectronAppHost {
	readonly getAppMetrics: () => ReadonlyArray<ElectronProcessMetric>;
	readonly on: (event: ElectronAppEvent, listener: (...args: Array<unknown>) => void) => void;
	readonly quit: () => void;
	readonly removeListener: (
		event: ElectronAppEvent,
		listener: (...args: Array<unknown>) => void
	) => void;
	readonly whenReady: () => Promise<unknown>;
}

export interface ElectronAppShape {
	readonly getAppMetrics: () => Effect.Effect<ReadonlyArray<ElectronProcessMetric>>;
	readonly on: (
		event: ElectronAppEvent,
		listener: (event: { readonly preventDefault: () => void }) => void
	) => Effect.Effect<void>;
	readonly quit: () => Effect.Effect<void>;
	readonly whenReady: () => Effect.Effect<void, ElectronAppError>;
}

export class ElectronApp extends Context.Service<ElectronApp, ElectronAppShape>()(
	"@ue-shed/workbench/ElectronApp"
) {}

export interface ElectronAppTestShape extends ElectronAppShape {
	readonly quitCount: () => Effect.Effect<number>;
}

export class ElectronAppTest extends Context.Service<ElectronAppTest, ElectronAppTestShape>()(
	"@ue-shed/workbench/ElectronApp/Test"
) {}

export const electronAppLayer = (app: ElectronAppHost): Layer.Layer<ElectronApp> =>
	Layer.effect(
		ElectronApp,
		Effect.gen(function* () {
			const listeners = yield* Ref.make<
				ReadonlyArray<{
					readonly event: ElectronAppEvent;
					readonly listener: (...args: Array<unknown>) => void;
				}>
			>([]);

			yield* Effect.addFinalizer(() =>
				Ref.get(listeners).pipe(
					Effect.flatMap((registered) =>
						Effect.sync(() => {
							for (const entry of registered) {
								app.removeListener(entry.event, entry.listener);
							}
						})
					)
				)
			);

			return ElectronApp.of({
				whenReady: Effect.fn("Workbench.ElectronApp.whenReady")(() =>
					Effect.tryPromise({
						try: () => app.whenReady(),
						catch: (cause) =>
							new ElectronAppError({
								causeText: cause instanceof Error ? cause.message : String(cause),
								message: "Electron app whenReady failed.",
								operation: "whenReady",
								recovery: "Restart Workbench and check Electron logs.",
								retrySafe: false
							})
					}).pipe(Effect.asVoid)
				),
				getAppMetrics: Effect.fn("Workbench.ElectronApp.getAppMetrics")(() =>
					Effect.sync(() => app.getAppMetrics())
				),
				quit: Effect.fn("Workbench.ElectronApp.quit")(() =>
					Effect.sync(() => {
						app.quit();
					})
				),
				on: Effect.fn("Workbench.ElectronApp.on")(function* (event, listener) {
					const wrapped = listener as (...args: Array<unknown>) => void;
					app.on(event, wrapped);
					yield* Ref.update(listeners, (current) => [
						...current,
						{ event, listener: wrapped }
					]);
				})
			});
		})
	);

export const makeElectronAppTestLayer = (
	overrides: Partial<ElectronAppTestShape> = {}
): Layer.Layer<ElectronApp | ElectronAppTest> =>
	Layer.effectContext(
		Effect.gen(function* () {
			const quitCount = yield* Ref.make(0);
			const service = ElectronAppTest.of({
				getAppMetrics:
					overrides.getAppMetrics ??
					Effect.fn("Workbench.ElectronApp.Test.getAppMetrics")(() =>
						Effect.succeed([
							{
								memory: { privateBytes: 1_024, workingSetSize: 2_048 },
								type: "Browser"
							}
						])
					),
				on: overrides.on ?? Effect.fn("Workbench.ElectronApp.Test.on")(() => Effect.void),
				quit:
					overrides.quit ??
					Effect.fn("Workbench.ElectronApp.Test.quit")(() =>
						Ref.update(quitCount, (count) => count + 1).pipe(Effect.asVoid)
					),
				whenReady:
					overrides.whenReady ??
					Effect.fn("Workbench.ElectronApp.Test.whenReady")(() => Effect.void),
				quitCount: () => Ref.get(quitCount)
			});
			return Context.empty().pipe(
				Context.add(ElectronApp, service),
				Context.add(ElectronAppTest, service)
			);
		})
	);
