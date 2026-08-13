import * as stylex from "@stylexjs/stylex";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
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
	let launchMenu: HTMLDetailsElement | undefined;
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
		if (pending()) return "INDEXING PROJECT…";
		if (current?.status === "ready") return current.project.projectName;
		if (current?.status === "failed") return "RETRY PROJECT…";
		return "CHOOSE PROJECT…";
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
				if (result.status === "launched" && launchMenu) launchMenu.open = false;
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
				<span {...stylex.props(styles.offline)}>OFFLINE</span>
				<details ref={launchMenu} {...stylex.props(styles.launchControl)}>
					<summary {...stylex.props(styles.launchSummary)}>LAUNCH ▾</summary>
					<div {...stylex.props(styles.launchMenu)}>
						<button
							type="button"
							disabled={launching() !== undefined}
							onClick={() => launch("ue_shed")}
							{...stylex.props(styles.launchOption, styles.launchOptionPrimary)}
						>
							<strong>
								{launching() === "ue_shed" ? "PREPARING PLUGINS…" : "WITH UE SHED"}
							</strong>
							<span>
								Core · Authoring · Cameras · Observatory · Asset Audits · Scenarios
							</span>
						</button>
						<button
							type="button"
							disabled={launching() !== undefined}
							onClick={() => launch("normal")}
							{...stylex.props(styles.launchOption)}
						>
							<strong>{launching() === "normal" ? "OPENING…" : "NORMALLY"}</strong>
							<span>No injected plugins or project changes</span>
						</button>
					</div>
				</details>
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
		alignItems: "center",
		display: "flex",
		position: "relative"
	},
	chooser: {
		border: "1px solid #a7da45",
		backgroundColor: { default: "#19220d", ":hover": "#273713", ":disabled": "#13180f" },
		color: { default: "#d5f59c", ":disabled": "#67704f" },
		cursor: { default: "pointer", ":disabled": "wait" },
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".1em",
		maxWidth: 180,
		overflow: "hidden",
		padding: "7px 9px",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	offline: {
		alignSelf: "stretch",
		display: "flex",
		alignItems: "center",
		borderBottom: "1px solid #343a36",
		borderTop: "1px solid #343a36",
		color: "#69736c",
		fontSize: 7,
		fontWeight: 700,
		letterSpacing: ".12em",
		padding: "0 7px"
	},
	launchControl: { position: "relative" },
	launchSummary: {
		alignItems: "center",
		backgroundColor: { default: "#1a1f1c", ":hover": "#242a26" },
		border: "1px solid #505a53",
		color: "#c6cdc8",
		cursor: "pointer",
		display: "flex",
		fontSize: 8,
		fontWeight: 700,
		letterSpacing: ".08em",
		listStyle: "none",
		padding: "7px 8px",
		whiteSpace: "nowrap"
	},
	launchMenu: {
		backgroundColor: "#151916",
		border: "1px solid #505a53",
		boxShadow: "0 12px 30px #00000077",
		display: "grid",
		minWidth: 310,
		padding: 5,
		position: "absolute",
		right: 0,
		top: "calc(100% + 7px)",
		zIndex: 32
	},
	launchOption: {
		alignItems: "flex-start",
		backgroundColor: {
			default: "transparent",
			":hover": "#222824",
			":disabled": "transparent"
		},
		border: 0,
		borderLeft: "2px solid transparent",
		color: { default: "#cbd2cd", ":disabled": "#646b66" },
		cursor: { default: "pointer", ":disabled": "wait" },
		display: "flex",
		flexDirection: "column",
		fontFamily: "inherit",
		fontSize: 9,
		gap: 4,
		padding: "10px 11px",
		textAlign: "left"
	},
	launchOptionPrimary: { borderLeftColor: "#a7da45" },
	launchNotice: {
		backgroundColor: "#172015",
		border: "1px solid #607e40",
		boxShadow: "0 10px 28px #00000066",
		color: "#cde9a9",
		display: "flex",
		flexDirection: "column",
		fontSize: 10,
		gap: 5,
		lineHeight: 1.4,
		maxWidth: 420,
		minWidth: 280,
		padding: "10px 12px",
		position: "absolute",
		right: 0,
		top: "calc(100% + 8px)",
		zIndex: 31
	},
	launchFailure: { backgroundColor: "#251816", borderColor: "#a85545", color: "#f1b8ad" },
	failure: {
		backgroundColor: "#251816",
		border: "1px solid #a85545",
		boxShadow: "0 10px 28px #00000066",
		color: "#f1b8ad",
		display: "flex",
		flexDirection: "column",
		fontSize: 10,
		gap: 5,
		left: 0,
		lineHeight: 1.4,
		maxWidth: 420,
		minWidth: 280,
		padding: "10px 12px",
		position: "absolute",
		top: "calc(100% + 8px)",
		zIndex: 30
	}
});
