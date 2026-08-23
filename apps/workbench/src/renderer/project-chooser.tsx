import * as stylex from "@stylexjs/stylex";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { TaskProgressModal, type TaskProgress } from "@ue-shed/ui/task-progress";
import { Schedule, Stream } from "effect";
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type {
	ProjectLaunchMode,
	ProjectLaunchResult,
	WorkbenchProjectState
} from "../main/project-workspace-contract.js";
import type { WorkbenchRendererClient } from "./workbench-client.js";

export interface ProjectChooserProps {
	readonly client: Pick<
		WorkbenchRendererClient,
		"chooseProject" | "launchProject" | "project" | "projectProgress"
	>;
	readonly onChosen: () => void;
}

export function ProjectChooser(props: ProjectChooserProps) {
	// The directory picker returns focus to this window. Keep its action separate from the
	// focus-triggered refresh: each action intentionally cancels only its own prior request.
	const refreshAction = createEffectAction();
	const chooseAction = createEffectAction();
	const launchAction = createEffectAction();
	const progressSubscription = createEffectSubscription();
	const [pending, setPending] = createSignal(false);
	const [progress, setProgress] = createSignal<TaskProgress>({
		completed: 0,
		phase: "idle",
		stage: "project_index",
		total: 0
	});
	const [project, setProject] = createSignal<WorkbenchProjectState>();
	const [launching, setLaunching] = createSignal<ProjectLaunchMode>();
	const [launchResult, setLaunchResult] = createSignal<ProjectLaunchResult>();
	const [launchMenu, setLaunchMenu] = createSignal<HTMLDetailsElement>();
	const applyProject = (
		next: WorkbenchProjectState,
		notifyRoutes: boolean,
		replaceFailure: boolean
	) => {
		const previous = project();
		if (!replaceFailure && previous?.status === "failed" && next.status !== "ready") return;
		setProject(next);
		if (
			notifyRoutes &&
			next.status === "ready" &&
			(previous?.status !== "ready" ||
				previous.project.projectRoot !== next.project.projectRoot)
		) {
			props.onChosen();
		}
	};
	const refresh = (notifyRoutes: boolean) =>
		refreshAction.run(props.client.project(), {
			onFailure: () => {
				if (project()?.status !== "failed") setProject(undefined);
			},
			onSuccess: (next) => applyProject(next, notifyRoutes, false)
		});

	onMount(() => {
		refresh(false);
		const onFocus = () => refresh(true);
		window.addEventListener("focus", onFocus);
		onCleanup(() => window.removeEventListener("focus", onFocus));
	});

	const choose = () => {
		setPending(true);
		// A deliberate retry starts a new lifecycle. The prior failure must not remain visible
		// behind the progress presentation, but a resulting failure remains after it closes.
		setProject(undefined);
		setProgress({ completed: 0, phase: "idle", stage: "project_index", total: 0 });
		progressSubscription.subscribe(
			Stream.fromEffectSchedule(
				props.client.projectProgress(),
				Schedule.spaced("100 millis")
			),
			{ onValue: setProgress }
		);
		chooseAction.run(props.client.chooseProject(), {
			onFailure: () => {
				progressSubscription.cancel();
				setPending(false);
				setProject(undefined);
			},
			onSuccess: (next) => {
				progressSubscription.cancel();
				setPending(false);
				applyProject(next, true, true);
			}
		});
	};

	const label = () => {
		const current = project();
		if (pending()) return "Indexing project…";
		if (current?.status === "ready") return current.project.projectName;
		if (current?.status === "failed") return "Retry project…";
		return "Choose project…";
	};
	const title = () => {
		const current = project();
		return current?.status === "ready" ? current.project.projectRoot : undefined;
	};
	const failure = () => {
		const current = project();
		return current?.status === "failed" ? current.error : undefined;
	};
	const launch = (mode: ProjectLaunchMode) => {
		setLaunching(mode);
		setLaunchResult(undefined);
		launchAction.run(props.client.launchProject(mode), {
			onFailure: () => {
				setLaunching(undefined);
				setLaunchResult({
					status: "failed",
					message: "Workbench could not start the project launcher.",
					recovery: "Retry, or launch the project directly from Unreal."
				});
			},
			onSuccess: (result) => {
				setLaunching(undefined);
				setLaunchResult(result);
				if (result.status === "launched" && launchMenu()) launchMenu()!.open = false;
			}
		});
	};
	const launchStatus = () => {
		const result = launchResult();
		if (result?.status === "launched") {
			return result.mode === "ue_shed"
				? "Unreal launched with the UE Shed plugin suite."
				: "Unreal launched normally.";
		}
		return undefined;
	};

	return (
		<div {...stylex.props(styles.control)}>
			<button
				type="button"
				title={title()}
				disabled={pending()}
				onClick={choose}
				{...stylex.props(styles.chooser)}
			>
				{label()}
			</button>
			<Show when={project()?.status === "ready"}>
				<div {...stylex.props(styles.launchRow)}>
					<span {...stylex.props(styles.offline)}>Offline</span>
					<details ref={setLaunchMenu} {...stylex.props(styles.launchControl)}>
						<summary {...stylex.props(styles.launchSummary)}>Launch ▾</summary>
						<div {...stylex.props(styles.launchMenu)}>
							<button
								type="button"
								disabled={launching() !== undefined}
								onClick={() => launch("ue_shed")}
								{...stylex.props(styles.launchOption, styles.launchOptionPrimary)}
							>
								<strong>
									{launching() === "ue_shed"
										? "Preparing plugins…"
										: "With plugin suite"}
								</strong>
								<span>
									Core · Authoring · Cameras · Observatory · Asset Audits ·
									Scenarios
								</span>
							</button>
							<button
								type="button"
								disabled={launching() !== undefined}
								onClick={() => launch("normal")}
								{...stylex.props(styles.launchOption)}
							>
								<strong>
									{launching() === "normal" ? "Opening…" : "Plain editor"}
								</strong>
								<span>No injected plugins or project changes</span>
							</button>
						</div>
					</details>
				</div>
			</Show>
			<Show when={failure()} keyed>
				{(error) => (
					<div role="alert" {...stylex.props(styles.failure)}>
						<strong>{error.message}</strong>
						<span>{error.recovery}</span>
					</div>
				)}
			</Show>
			<Show when={launchResult()?.status === "failed" ? launchResult() : undefined} keyed>
				{(result) =>
					result.status === "failed" ? (
						<div
							role="alert"
							{...stylex.props(styles.launchNotice, styles.launchFailure)}
						>
							<strong>{result.message}</strong>
							<span>{result.recovery}</span>
						</div>
					) : null
				}
			</Show>
			<Show when={launchStatus()} keyed>
				{(message) => (
					<div role="status" {...stylex.props(styles.launchNotice)}>
						{message}
					</div>
				)}
			</Show>
			<TaskProgressModal
				open={pending()}
				progress={progress()}
				title="Indexing the selected project"
				detail="Workbench is building one shared package inventory for every saved-asset route. The project will unlock when the index is ready."
			/>
		</div>
	);
}

const styles = stylex.create({
	control: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		position: "relative"
	},
	chooser: {
		borderColor: { default: tokens.colorBorderStrong, ":hover": "#4a4e54" },
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.04)",
			":active": "rgba(255, 255, 255, 0.08)"
		},
		color: { default: tokens.colorTextStrong, ":disabled": tokens.colorTextSubtle },
		cursor: { default: "pointer", ":disabled": "wait" },
		fontSize: 12,
		fontWeight: 500,
		width: "100%",
		overflow: "hidden",
		padding: "6px 10px",
		textAlign: "left",
		textOverflow: "ellipsis",
		transitionDuration: tokens.motionFast,
		transitionProperty: "background-color, border-color, color, opacity, transform",
		transitionTimingFunction: tokens.motionEaseOut,
		transform: { default: "scale(1)", ":active": "scale(0.97)", ":disabled": "scale(1)" },
		whiteSpace: "nowrap"
	},
	launchRow: {
		alignItems: "center",
		display: "flex",
		gap: 6
	},
	offline: {
		color: tokens.colorTextFaint,
		fontSize: 11,
		fontWeight: 500
	},
	launchControl: { marginLeft: "auto", position: "relative" },
	launchSummary: {
		alignItems: "center",
		backgroundColor: {
			default: "rgba(255, 255, 255, 0.05)",
			":hover": "rgba(255, 255, 255, 0.09)"
		},
		color: tokens.colorText,
		cursor: "pointer",
		display: "flex",
		fontSize: 12,
		fontWeight: 500,
		listStyle: "none",
		borderRadius: tokens.radiusControl,
		padding: "4px 8px",
		transitionDuration: tokens.motionFast,
		transitionProperty: "background-color, transform",
		transitionTimingFunction: tokens.motionEaseOut,
		transform: { default: "scale(1)", ":active": "scale(0.97)" },
		whiteSpace: "nowrap"
	},
	launchMenu: {
		backgroundColor: tokens.colorSurfaceRaised,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		boxShadow: tokens.shadowOverlay,
		display: "grid",
		gap: 2,
		minWidth: 310,
		padding: 4,
		position: "absolute",
		right: 0,
		top: "calc(100% + 7px)",
		zIndex: 32
	},
	launchOption: {
		alignItems: "flex-start",
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.05)",
			":disabled": "transparent"
		},
		borderLeftColor: "transparent",
		borderLeftStyle: "solid",
		borderLeftWidth: 2,
		borderRadius: tokens.radiusBadge,
		color: { default: tokens.colorText, ":disabled": tokens.colorTextSubtle },
		cursor: { default: "pointer", ":disabled": "wait" },
		display: "flex",
		flexDirection: "column",
		fontFamily: "inherit",
		fontSize: 12,
		gap: 3,
		padding: "9px 11px",
		textAlign: "left",
		transitionDuration: tokens.motionFast,
		transitionProperty: "background-color, border-color, color, opacity, transform",
		transitionTimingFunction: tokens.motionEaseOut,
		transform: { default: "scale(1)", ":active": "scale(0.98)", ":disabled": "scale(1)" }
	},
	launchOptionPrimary: {
		borderLeftColor: tokens.colorAccent,
		color: tokens.colorTextStrong
	},
	launchNotice: {
		backgroundColor: tokens.colorSurfaceRaised,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		boxShadow: tokens.shadowOverlay,
		color: tokens.colorTextMuted,
		display: "flex",
		flexDirection: "column",
		fontSize: 12,
		gap: 5,
		lineHeight: 1.5,
		maxWidth: 420,
		minWidth: 280,
		padding: "10px 12px",
		position: "absolute",
		right: 0,
		top: "calc(100% + 8px)",
		zIndex: 31
	},
	launchFailure: {
		backgroundColor: "rgba(235, 87, 87, 0.08)",
		borderColor: "rgba(235, 87, 87, 0.35)",
		color: "#f2a9a1"
	},
	failure: {
		backgroundColor: "rgba(235, 87, 87, 0.08)",
		borderColor: "rgba(235, 87, 87, 0.35)",
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		boxShadow: tokens.shadowOverlay,
		color: "#f2a9a1",
		display: "flex",
		flexDirection: "column",
		fontSize: 12,
		gap: 5,
		right: 0,
		lineHeight: 1.5,
		maxWidth: 420,
		minWidth: 280,
		padding: "10px 12px",
		position: "absolute",
		top: "calc(100% + 8px)",
		zIndex: 30
	}
});
