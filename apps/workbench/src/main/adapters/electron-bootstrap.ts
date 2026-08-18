export interface BeforeQuitEvent {
	readonly preventDefault: () => void;
}

export interface RuntimeDisposalHost {
	readonly onBeforeQuit: (listener: (event: BeforeQuitEvent) => void) => void;
	readonly quit: () => void;
}

export interface RuntimeDisposal {
	readonly disposeAndQuit: () => void;
}

export interface RuntimeDisposalTask {
	readonly finally: (onFinally: () => void) => RuntimeDisposalTask;
}

/**
 * Coordinates Electron's imperative quit handshake with asynchronous runtime finalization.
 * Every quit remains prevented until disposal settles; only the coordinator's final quit is
 * allowed through.
 */
export function installRuntimeDisposal(
	host: RuntimeDisposalHost,
	dispose: () => RuntimeDisposalTask
): RuntimeDisposal {
	let state: "running" | "disposing" | "disposed" = "running";

	const disposeAndQuit = () => {
		if (state !== "running") return;
		state = "disposing";
		void dispose().finally(() => {
			state = "disposed";
			host.quit();
		});
	};

	host.onBeforeQuit((event) => {
		if (state === "disposed") return;
		event.preventDefault();
		disposeAndQuit();
	});

	return { disposeAndQuit };
}
