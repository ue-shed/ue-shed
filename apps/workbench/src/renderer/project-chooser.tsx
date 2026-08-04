import * as stylex from "@stylexjs/stylex";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { TaskProgressModal, type TaskProgress } from "@ue-shed/ui/task-progress";
import { Schedule, Stream } from "effect";
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type { WorkbenchProjectState } from "../main/project-workspace-contract.js";
import type { WorkbenchRendererClient } from "./workbench-client.js";

export interface ProjectChooserProps {
	readonly client: Pick<WorkbenchRendererClient, "chooseProject" | "project" | "projectProgress">;
	readonly onChosen: () => void;
}

export function ProjectChooser(props: ProjectChooserProps) {
	// The directory picker returns focus to this window. Keep its action separate from the
	// focus-triggered refresh: each action intentionally cancels only its own prior request.
	const refreshAction = createEffectAction();
	const chooseAction = createEffectAction();
	const progressSubscription = createEffectSubscription();
	const [pending, setPending] = createSignal(false);
	const [progress, setProgress] = createSignal<TaskProgress>({
		completed: 0,
		phase: "idle",
		stage: "project_index",
		total: 0
	});
	const [project, setProject] = createSignal<WorkbenchProjectState>();
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
			<Show when={failure()} keyed>
				{(error) => (
					<div role="alert" {...stylex.props(styles.failure)}>
						<strong>{error.message}</strong>
						<span>{error.recovery}</span>
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
