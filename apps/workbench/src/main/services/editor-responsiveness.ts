import {
	EditorForegroundResponsiveness,
	editorForegroundBackoffMs,
	isLoopbackEndpoint,
	type EditorForegroundLease
} from "@ue-shed/engine";
import {
	Clock,
	Context,
	Duration,
	Effect,
	Exit,
	Layer,
	Ref,
	Result,
	Schema,
	Scope,
	Semaphore
} from "effect";
import { join } from "node:path";
import type { EditorResponsivenessSettings } from "../../shared/ipc-contracts.js";
import { ElectronApp } from "../adapters/electron-app.js";
import { LocalFiles, type LocalFilesError } from "../adapters/local-files.js";
import { WorkbenchUnrealConnection } from "./unreal-connection.js";

const PREFERENCE_MAX_BYTES = 4 * 1_024;
/** How often the selected endpoint and preference are compared with the lease being held. */
const RECONCILE_EVERY = Duration.seconds(1);
/** An editor without the capability rarely gains it; look again slowly. */
const UNSUPPORTED_RETRY_MS = 30_000;

const PreferenceDocument = Schema.Struct({
	keepUnrealResponsive: Schema.Boolean,
	schemaVersion: Schema.Literal(1)
});

export interface EditorResponsivenessPreferenceStore {
	/** The saved preference; on by default. */
	readonly load: Effect.Effect<boolean>;
	readonly save: (enabled: boolean) => Effect.Effect<void, LocalFilesError>;
}

export interface WorkbenchEditorResponsivenessApi {
	readonly settings: () => Effect.Effect<EditorResponsivenessSettings>;
	/** Applies at once; a failed save is logged and the choice still holds for this run. */
	readonly setEnabled: (enabled: boolean) => Effect.Effect<EditorResponsivenessSettings>;
}

/**
 * Keeps the selected local editor responsive while Workbench is in the foreground, by holding one
 * engine foreground lease for the main process. Unreal checks the foreground itself, so focus
 * changes need no messages.
 */
export class WorkbenchEditorResponsiveness extends Context.Service<
	WorkbenchEditorResponsiveness,
	WorkbenchEditorResponsivenessApi
>()("@ue-shed/workbench/WorkbenchEditorResponsiveness") {}

type Holding =
	| { readonly _tag: "Idle" }
	| {
			readonly _tag: "Held";
			readonly endpoint: string;
			readonly scope: Scope.Closeable;
			readonly lease: EditorForegroundLease;
	  }
	| {
			readonly _tag: "Waiting";
			readonly endpoint: string;
			readonly state: "connecting" | "remote" | "unsupported";
			readonly detail: string;
			readonly failures: number;
			readonly retryAt: number;
	  };

const details = {
	active: "Unreal stays responsive while Workbench is in front.",
	connecting: "Waiting for a local editor with UE Shed Core.",
	lapsed: "Lost contact with Unreal; retrying.",
	off: "Unreal's own background setting applies.",
	remote: "Only available for an editor on this computer."
} as const;

export function makeWorkbenchEditorResponsivenessLayer(options: {
	readonly clientProcessId: number;
	readonly platform: NodeJS.Platform;
	readonly store: EditorResponsivenessPreferenceStore;
}) {
	return Layer.effect(
		WorkbenchEditorResponsiveness,
		Effect.gen(function* () {
			const connection = yield* WorkbenchUnrealConnection;
			const responsiveness = yield* EditorForegroundResponsiveness;
			const store = options.store;
			const enabled = yield* Ref.make(yield* store.load);
			const holding = yield* Ref.make<Holding>({ _tag: "Idle" });
			const gate = yield* Semaphore.make(1);

			const wait = (
				endpoint: string,
				state: "connecting" | "remote" | "unsupported",
				detail: string,
				failures: number,
				retryAt: number
			) => Ref.set(holding, { _tag: "Waiting", endpoint, state, detail, failures, retryAt });

			const releaseHeld = Effect.gen(function* () {
				const current = yield* Ref.getAndSet(holding, { _tag: "Idle" });
				if (current._tag === "Held") yield* Scope.close(current.scope, Exit.void);
			});

			/** Bring the held lease in line with the preference and the selected endpoint. */
			const reconcile = gate
				.withPermits(1)(
					Effect.gen(function* () {
						const endpoint = (yield* Ref.get(enabled))
							? yield* connection.endpoint()
							: undefined;
						const current = yield* Ref.get(holding);
						const now = yield* Clock.currentTimeMillis;
						if (current._tag !== "Idle" && current.endpoint === endpoint) {
							if (current._tag === "Held" || now < current.retryAt) return;
						}
						yield* releaseHeld;
						if (endpoint === undefined) return;
						if (!isLoopbackEndpoint(endpoint))
							return yield* wait(endpoint, "remote", details.remote, 0, Infinity);
						if (options.platform !== "win32")
							return yield* wait(
								endpoint,
								"unsupported",
								"Available on Windows only.",
								0,
								Infinity
							);
						const failures =
							current._tag === "Waiting" && current.endpoint === endpoint
								? current.failures + 1
								: 1;
						const scope = yield* Scope.make();
						const result = yield* responsiveness
							.hold({ endpoint, clientProcessId: options.clientProcessId })
							.pipe(Scope.provide(scope), Effect.result);
						if (Result.isSuccess(result))
							return yield* Ref.set(holding, {
								_tag: "Held",
								endpoint,
								scope,
								lease: result.success
							});
						yield* Scope.close(scope, Exit.void);
						const error = result.failure;
						const unsupported =
							error.reason === "capability_missing" || error.reason === "unsupported";
						if (failures === 1)
							yield* Effect.logInfo("Unreal foreground responsiveness unavailable", {
								endpoint,
								reason: error.reason,
								message: error.message
							});
						yield* wait(
							endpoint,
							unsupported ? "unsupported" : "connecting",
							unsupported ? `${error.message} ${error.recovery}` : details.connecting,
							failures,
							now +
								(unsupported
									? UNSUPPORTED_RETRY_MS
									: editorForegroundBackoffMs(failures))
						);
					})
				)
				.pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("Unreal foreground responsiveness check failed", cause)
					)
				);

			const settings = Effect.fn("Workbench.EditorResponsiveness.settings")(function* () {
				if (!(yield* Ref.get(enabled)))
					return { enabled: false, state: "off", detail: details.off } as const;
				const current = yield* Ref.get(holding);
				if (current._tag === "Waiting")
					return { enabled: true, state: current.state, detail: current.detail } as const;
				const lease = current._tag === "Held" ? yield* current.lease.state : undefined;
				if (lease?._tag === "Held")
					return { enabled: true, state: "active", detail: details.active } as const;
				if (lease?._tag === "Lapsed")
					return { enabled: true, state: "lapsed", detail: details.lapsed } as const;
				return { enabled: true, state: "connecting", detail: details.connecting } as const;
			});

			const setEnabled = Effect.fn("Workbench.EditorResponsiveness.setEnabled")(function* (
				next: boolean
			) {
				yield* Ref.set(enabled, next);
				yield* reconcile;
				yield* store
					.save(next)
					.pipe(
						Effect.catch((error) =>
							Effect.logWarning(
								"Could not save the Unreal responsiveness preference",
								error
							)
						)
					);
				return yield* settings();
			});

			yield* Effect.addFinalizer(() => gate.withPermits(1)(releaseHeld));
			yield* Effect.forkScoped(
				Effect.forever(reconcile.pipe(Effect.andThen(Effect.sleep(RECONCILE_EVERY))))
			);
			return WorkbenchEditorResponsiveness.of({ settings, setEnabled });
		})
	);
}

/** The preference document beside project history in Electron's user data directory. */
export const editorResponsivenessPreferenceFile = Effect.gen(function* () {
	const app = yield* ElectronApp;
	const files = yield* LocalFiles;
	const path = join(yield* app.getPath("userData"), "editor-responsiveness-v1.json");
	return {
		load: files.readFile(path, { maxBytes: PREFERENCE_MAX_BYTES }).pipe(
			Effect.flatMap((bytes) =>
				Effect.try(() => JSON.parse(new TextDecoder().decode(bytes)))
			),
			Effect.flatMap(Schema.decodeUnknownEffect(PreferenceDocument)),
			Effect.map((document) => document.keepUnrealResponsive),
			Effect.catch(() => Effect.succeed(true))
		),
		save: (keepUnrealResponsive: boolean) =>
			files.writeFile(
				path,
				new TextEncoder().encode(
					JSON.stringify({ keepUnrealResponsive, schemaVersion: 1 }, undefined, "\t") +
						"\n"
				),
				{ maxBytes: PREFERENCE_MAX_BYTES }
			)
	} satisfies EditorResponsivenessPreferenceStore;
});

export const WorkbenchEditorResponsivenessLive = Layer.unwrap(
	editorResponsivenessPreferenceFile.pipe(
		// Without a user data directory the preference still works for this run.
		Effect.orElseSucceed(
			(): EditorResponsivenessPreferenceStore => ({
				load: Effect.succeed(true),
				save: () => Effect.void
			})
		),
		Effect.map((store) =>
			makeWorkbenchEditorResponsivenessLayer({
				clientProcessId: process.pid,
				platform: process.platform,
				store
			})
		)
	)
);

export function makeEditorResponsivenessPreferenceTestStore(initial = true) {
	return Effect.map(Ref.make(initial), (saved) => ({
		saved: Ref.get(saved),
		store: {
			load: Ref.get(saved),
			save: (enabled: boolean) => Ref.set(saved, enabled)
		} satisfies EditorResponsivenessPreferenceStore
	}));
}

/** A fixed answer for IPC registration tests. */
export const makeWorkbenchEditorResponsivenessTestLayer = (
	initial: EditorResponsivenessSettings = {
		enabled: true,
		state: "active",
		detail: details.active
	}
) =>
	Layer.effect(
		WorkbenchEditorResponsiveness,
		Effect.map(Ref.make(initial), (current) =>
			WorkbenchEditorResponsiveness.of({
				settings: () => Ref.get(current),
				setEnabled: (enabled) =>
					Ref.updateAndGet(current, (value) =>
						enabled
							? { ...value, enabled }
							: { enabled, state: "off" as const, detail: details.off }
					)
			})
		)
	);
