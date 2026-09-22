import * as stylex from "@stylexjs/stylex";
import { AnchoredPopover, createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { TaskProgressModal, type TaskProgress } from "@ue-shed/ui/task-progress";
import { Schedule, Stream } from "effect";
import { For, Show, createEffect, createSignal, onSettled, untrack } from "solid-js";
import type {
	ProjectLaunchMode,
	ProjectLaunchResult,
	WorkbenchRecentProject,
	WorkbenchProjectState
} from "../shared/project-workspace-contract.js";
import type { WorkbenchRendererClient } from "./workbench-client.js";
import { ProjectLaunchError } from "./project-launch-error.js";

export interface ProjectChooserProps {
	readonly revision?: number;
	readonly client: Pick<
		WorkbenchRendererClient,
		| "chooseProject"
		| "launchProject"
		| "openRecentProject"
		| "project"
		| "projectProgress"
		| "recentProjects"
	>;
	readonly onChosen: () => void;
}

export function ProjectChooser(props: ProjectChooserProps) {
	// The directory picker returns focus to this window. Keep its action separate from the
	// focus-triggered refresh: each action intentionally cancels only its own prior request.
	const refreshAction = createEffectAction();
	const chooseAction = createEffectAction();
	const recentAction = createEffectAction();
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
	const [recentProjects, setRecentProjects] = createSignal<readonly WorkbenchRecentProject[]>([]);
	const [launching, setLaunching] = createSignal<ProjectLaunchMode>();
	const [launchResult, setLaunchResult] = createSignal<ProjectLaunchResult>();
	const [launchMenuOpen, setLaunchMenuOpen] = createSignal(false);
	const [recentMenuOpen, setRecentMenuOpen] = createSignal(false);
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
	const refresh = (notifyRoutes: boolean) => {
		if (pending()) return;
		refreshAction.run(props.client.project(), {
			onFailure: () => {
				if (project()?.status !== "failed") setProject(undefined);
			},
			onSuccess: (next) => applyProject(next, notifyRoutes, false)
		});
	};
	const refreshRecent = () =>
		recentAction.run(props.client.recentProjects(), {
			onSuccess: setRecentProjects
		});

	createEffect(
		() => props.revision,
		() => {
			untrack(() => refresh(false));
		}
	);
	onSettled(() => {
		refreshRecent();
		const onFocus = () => refresh(true);
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	});

	const selectProject = (
		selection: ReturnType<ProjectChooserProps["client"]["chooseProject"]>
	) => {
		// A focus event from the native picker must not let an older project refresh replace
		// the explicit selection after it completes. createEffectAction's generation guard also
		// covers refreshes backed by uninterruptible foreign work.
		refreshAction.cancel();
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
		chooseAction.run(selection, {
			onFailure: () => {
				progressSubscription.cancel();
				setPending(false);
				setProject(undefined);
			},
			onSuccess: (next) => {
				progressSubscription.cancel();
				setPending(false);
				applyProject(next, true, true);
				if (next.status === "ready") {
					setRecentMenuOpen(false);
					refreshRecent();
				}
			}
		});
	};
	const choose = () => selectProject(props.client.chooseProject());
	const openRecent = (projectRoot: string) =>
		selectProject(props.client.openRecentProject(projectRoot));

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
				setLaunchMenuOpen(false);
				setLaunchResult({
					status: "failed",
					message: "Workbench could not start the project launcher.",
					recovery: "Retry, or launch the project directly from Unreal."
				});
			},
			onSuccess: (result) => {
				setLaunching(undefined);
				setLaunchResult(result);
				setLaunchMenuOpen(false);
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
	createEffect(
		() => launchResult(),
		(result) => {
			if (result?.status !== "launched") return;
			const timeout = window.setTimeout(() => setLaunchResult(undefined), 5_000);
			return () => window.clearTimeout(timeout);
		}
	);

	return (
		<div {...stylex.attrs(styles.control)}>
			<div {...stylex.attrs(styles.projectSwitchRow)}>
				<button
					type="button"
					title={title()}
					disabled={pending()}
					onClick={choose}
					{...stylex.attrs(styles.chooser)}
				>
					{label()}
				</button>
				<Show when={recentProjects().length > 0}>
					<div {...stylex.attrs(styles.recentControl)}>
						<AnchoredPopover
							ariaLabel="Recently opened projects"
							id="recent-projects-popover"
							onOpenChange={setRecentMenuOpen}
							open={recentMenuOpen()}
							placement="top-end"
							style={styles.recentMenu}
							trigger={(triggerProps) => (
								<button
									{...triggerProps}
									aria-label="Recent projects"
									title="Recent projects"
									type="button"
									{...stylex.attrs(styles.recentSummary)}
								>
									⌃
								</button>
							)}
						>
							<header {...stylex.attrs(styles.recentHeader)}>
								<strong>Recent projects</strong>
								<span>Stored only on this device</span>
							</header>
							<For each={recentProjects()}>
								{(recent) => {
									const current = () => title() === recent.projectRoot;
									return (
										<button
											aria-label={`Open recent project ${recent.projectName}`}
											disabled={pending() || current()}
											onClick={() => openRecent(recent.projectRoot)}
											type="button"
											{...stylex.attrs(styles.recentProject)}
										>
											<span {...stylex.attrs(styles.recentProjectCopy)}>
												<strong>{recent.projectName}</strong>
												<small title={recent.projectRoot}>
													{recent.projectRoot}
												</small>
											</span>
											<span {...stylex.attrs(styles.recentProjectState)}>
												{current() ? "CURRENT" : "OPEN"}
											</span>
										</button>
									);
								}}
							</For>
						</AnchoredPopover>
					</div>
				</Show>
			</div>
			<Show when={project()?.status === "ready"}>
				<div {...stylex.attrs(styles.launchRow)}>
					<span {...stylex.attrs(styles.offline)}>Offline</span>
					<div {...stylex.attrs(styles.launchControl)}>
						<AnchoredPopover
							ariaLabel="Launch project options"
							id="launch-project-popover"
							onOpenChange={setLaunchMenuOpen}
							open={launchMenuOpen()}
							placement="top-end"
							style={styles.launchMenu}
							trigger={(triggerProps) => (
								<button
									{...triggerProps}
									type="button"
									{...stylex.attrs(styles.launchSummary)}
								>
									Launch ▾
								</button>
							)}
						>
							<button
								type="button"
								disabled={launching() !== undefined}
								onClick={() => launch("ue_shed")}
								{...stylex.attrs(styles.launchOption, styles.launchOptionPrimary)}
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
								{...stylex.attrs(styles.launchOption)}
							>
								<strong>
									{launching() === "normal" ? "Opening…" : "Plain editor"}
								</strong>
								<span>No injected plugins or project changes</span>
							</button>
						</AnchoredPopover>
					</div>
				</div>
			</Show>
			<Show when={failure()} keyed>
				{(error) => (
					<div role="alert" {...stylex.attrs(styles.failure)}>
						<strong>{error.message}</strong>
						<span>{error.recovery}</span>
					</div>
				)}
			</Show>
			<Show when={launchResult()?.status === "failed" ? launchResult() : undefined} keyed>
				{(result) =>
					result.status === "failed" ? (
						<ProjectLaunchError
							failure={result}
							onClose={() => setLaunchResult(undefined)}
						/>
					) : null
				}
			</Show>
			<Show when={launchStatus()} keyed>
				{(message) => (
					<div role="status" {...stylex.attrs(styles.launchNotice)}>
						<button
							aria-label="Dismiss launch notice"
							onClick={() => setLaunchResult(undefined)}
							type="button"
							{...stylex.attrs(styles.noticeDismiss)}
						>
							×
						</button>
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
	projectSwitchRow: { display: "flex", gap: 4, minWidth: 0 },
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
		flexGrow: 1,
		minWidth: 0,
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
	recentControl: { flexGrow: 0, flexShrink: 0, position: "relative" },
	recentSummary: {
		display: "grid",
		placeItems: "center",
		width: 30,
		height: 30,
		borderColor: { default: tokens.colorBorderStrong, ":hover": "#4a4e54" },
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		boxSizing: "border-box",
		fontFamily: "inherit",
		backgroundColor: {
			default: "rgba(255, 255, 255, 0.03)",
			":hover": "rgba(255, 255, 255, 0.08)"
		},
		color: tokens.colorTextMuted,
		cursor: "pointer",
		fontSize: 12,
		listStyle: "none",
		padding: 0,
		transitionDuration: tokens.motionFast,
		transitionProperty: "background-color, border-color, color, transform",
		transitionTimingFunction: tokens.motionEaseOut,
		transform: { default: "scale(1)", ":active": "scale(0.96)" }
	},
	recentMenu: {
		backgroundColor: tokens.colorSurfaceRaised,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		boxShadow: tokens.shadowOverlay,
		display: "grid",
		gap: 2,
		width: "min(340px, calc(100vw - 16px))",
		boxSizing: "border-box",
		maxHeight: 360,
		overflowY: "auto",
		padding: 4,
		zIndex: 33
	},
	recentHeader: {
		display: "flex",
		alignItems: "baseline",
		justifyContent: "space-between",
		gap: 12,
		padding: "8px 9px 7px",
		color: tokens.colorTextStrong,
		fontSize: 12
	},
	recentProject: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		minWidth: 0,
		borderLeftColor: { default: "transparent", ":hover": tokens.colorAccent },
		borderLeftStyle: "solid",
		borderLeftWidth: 2,
		borderRadius: tokens.radiusBadge,
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.055)",
			":disabled": "rgba(255, 255, 255, 0.025)"
		},
		color: { default: tokens.colorText, ":disabled": tokens.colorTextMuted },
		cursor: { default: "pointer", ":disabled": "default" },
		padding: "9px 10px",
		textAlign: "left"
	},
	recentProjectCopy: {
		display: "grid",
		gap: 3,
		minWidth: 0,
		fontSize: 12
	},
	recentProjectState: {
		flexShrink: 0,
		color: tokens.colorAccent,
		fontFamily: tokens.fontMono,
		fontSize: 8,
		letterSpacing: ".1em"
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
		fontFamily: "inherit",
		listStyle: "none",
		borderWidth: 0,
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
		width: "min(310px, calc(100vw - 16px))",
		boxSizing: "border-box",
		padding: 4,
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
		boxSizing: "border-box",
		minWidth: 0,
		padding: "10px 34px 10px 12px",
		position: "absolute",
		right: 0,
		top: "calc(100% + 8px)",
		width: "100%",
		zIndex: 31
	},
	noticeDismiss: {
		alignItems: "center",
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.08)" },
		borderStyle: "none",
		borderWidth: 0,
		borderRadius: tokens.radiusBadge,
		color: { default: tokens.colorTextMuted, ":hover": tokens.colorTextStrong },
		cursor: "pointer",
		display: "flex",
		fontFamily: tokens.fontBody,
		fontSize: 16,
		height: 24,
		justifyContent: "center",
		padding: 0,
		position: "absolute",
		right: 5,
		top: 5,
		width: 24
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
		boxSizing: "border-box",
		minWidth: 0,
		padding: "10px 12px",
		position: "absolute",
		top: "calc(100% + 8px)",
		width: "100%",
		zIndex: 30
	}
});
