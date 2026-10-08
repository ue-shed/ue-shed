import * as stylex from "@stylexjs/stylex";
import {
	textCountLabel,
	type LocalizationSelection,
	type TextCorpusQuerySummary,
	type WorkbenchOperationFilesResult,
	type WorkbenchOperationPlan,
	type WorkbenchOperationProgress,
	type WorkbenchOperationRequest,
	type WorkbenchOperationResult,
	type WorkbenchOperationState
} from "@ue-shed/game-text/browser";
import { Button, createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { Effect, Schedule, Stream } from "effect";
import { For, Show, createEffect, createSignal, untrack } from "solid-js";
import type { GameTextClientApi } from "./game-text-client.js";
import { LocalizationPicker } from "./game-text-localization-picker.js";
import { styles } from "./game-text-styles.js";

const operationLabels = {
	gather: "Gather text",
	import: "Import translations",
	export: "Export PO files",
	compile: "Compile",
	reports: "Generate Unreal reports",
	sync: "Sync with Unreal"
} satisfies Record<WorkbenchOperationRequest["operation"], string>;
const runningLabels = {
	gather: "Gathering text",
	import: "Importing translations",
	export: "Exporting PO files",
	compile: "Compiling",
	reports: "Generating Unreal reports",
	sync: "Syncing with Unreal"
} satisfies Record<WorkbenchOperationRequest["operation"], string>;
const resultLabels = {
	gather: "Gathered",
	import: "Imported",
	export: "Exported",
	compile: "Compiled",
	reports: "Reports generated",
	sync: "Synced"
} satisfies Record<WorkbenchOperationRequest["operation"], string>;
const stepLabels = {
	gather_source: "Gather source text",
	gather_assets: "Gather saved asset text",
	gather_metadata: "Gather metadata",
	manifest: "Gathered text",
	archive: "Translations",
	import: "Import",
	export: "Export",
	compile: "Compile",
	reports: "Reports"
} satisfies Record<NonNullable<WorkbenchOperationProgress["kind"]>, string>;
type FilePage = Extract<WorkbenchOperationFilesResult, { status: "ready" }>;
function progressLabel(value: WorkbenchOperationProgress): string {
	return value.phase === "refreshing"
		? "Reloading translations…"
		: value.kind
			? `step ${value.stepIndex + 1} of ${value.stepTotal} · ${stepLabels[value.kind]}`
			: "Starting…";
}

export function createGameTextOperations(props: {
	readonly client: GameTextClientApi;
	readonly target: () => LocalizationSelection["target"] | undefined;
	readonly scanning: () => boolean;
	readonly revision: () => TextCorpusQuerySummary | undefined;
	readonly onCompleted: () => void;
}) {
	const api = props.client.operations;
	const [state, setState] = createSignal<WorkbenchOperationState>();
	const [plan, setPlan] = createSignal<WorkbenchOperationPlan>();
	const [files, setFiles] = createSignal<FilePage>();
	const [changedFiles, setChangedFiles] = createSignal<FilePage>();
	const [result, setResult] = createSignal<WorkbenchOperationResult>();
	const [planning, setPlanning] = createSignal(false);
	const [running, setRunning] = createSignal(false);
	const [progress, setProgress] = createSignal<WorkbenchOperationProgress>();
	const [copied, setCopied] = createSignal(false);
	const [copyError, setCopyError] = createSignal<string>();
	const planAction = createEffectAction();
	const runAction = createEffectAction();
	const cancelAction = createEffectAction();
	const fileAction = createEffectAction();
	const copyAction = createEffectAction();
	const copyConfirmation = createEffectAction();
	const poll = createEffectSubscription();
	const events = createEffectSubscription();
	let generation = 0;
	let completedId: string | undefined;
	let finishedId: string | undefined;
	const complete = (value: WorkbenchOperationResult) => {
		finishedId = value.status === "completed" ? value.receipt.id : untrack(progress)?.id;
		setResult(value);
		setRunning(false);
		setProgress(undefined);
		setState((previous) =>
			previous
				? {
						operations: previous.operations,
						wholeRecipe: previous.wholeRecipe
					}
				: undefined
		);
		if (value.status === "completed" && completedId !== value.receipt.id) {
			completedId = value.receipt.id;
			props.onCompleted();
		}
	};
	createEffect(
		() => ({ target: props.target(), revision: props.revision(), scanning: props.scanning() }),
		({ target, scanning }) => {
			poll.cancel();
			if (!api || !target || scanning) return;
			poll.subscribe(
				Stream.fromEffectSchedule(api.state(target), Schedule.spaced("500 millis")),
				{
					onValue: (value) => {
						setState(value);
						setProgress(value.progress?.id === finishedId ? undefined : value.progress);
						if (
							value.result &&
							!value.progress &&
							!untrack(running) &&
							!untrack(planning) &&
							!untrack(plan)
						) {
							if (
								value.result.status === "completed" &&
								value.result.receipt.id !== completedId
							)
								complete(value.result);
							else setResult(value.result);
						}
					},
					onFailure: () =>
						setCopyError("Unreal steps are unavailable. Reload Game Text to try again.")
				}
			);
		}
	);
	createEffect(
		() => props.target(),
		() => {
			generation++;
			planAction.cancel();
			setPlan(undefined);
			setFiles(undefined);
			setChangedFiles(undefined);
			setResult(undefined);
			setState(undefined);
			setPlanning(false);
		}
	);
	createEffect(
		() => !!api,
		(supported) => {
			if (!supported || !api) return;
			events.subscribe(api.progress, {
				onValue: (value) => {
					if (value.id !== finishedId && value.target === untrack(props.target))
						setProgress(value);
				}
			});
		}
	);
	const busy = () => props.scanning() || planning() || running() || !!state()?.busyReason;
	const reason = () =>
		props.scanning()
			? "A project scan is running. Wait before running Unreal steps."
			: (state()?.busyReason ??
				(planning()
					? "Preparing an Unreal step."
					: running()
						? "An Unreal step is running. Cancel it or wait."
						: undefined));
	const prepare = (operation: WorkbenchOperationRequest["operation"]) => {
		const target = props.target();
		if (!api || !target || busy()) return;
		const version = ++generation;
		copyAction.cancel();
		fileAction.cancel();
		setPlanning(true);
		setPlan(undefined);
		setFiles(undefined);
		setResult(undefined);
		setChangedFiles(undefined);
		setCopyError(undefined);
		setCopied(false);
		planAction.run(
			Effect.gen(function* () {
				const value = yield* api.plan({ target, operation });
				const page =
					value.status === "ready"
						? yield* api.files({ id: value.plan.id, kind: "planned" })
						: undefined;
				return { value, page };
			}),
			{
				onSuccess: ({ value, page }) => {
					if (version !== generation) return;
					setPlanning(false);
					if (value.status === "failed") setResult(value);
					else if (page?.status === "ready") {
						setPlan(value.plan);
						setFiles(page);
					} else if (page?.status === "failed") setResult(page);
				},
				onFailure: () => {
					if (version !== generation) return;
					setPlanning(false);
					setCopyError(
						"Couldn’t prepare this Unreal step. Check the engine configuration and retry."
					);
				}
			}
		);
	};
	const run = () => {
		const current = plan();
		if (!api || !current || busy()) return;
		setRunning(true);
		setPlan(undefined);
		setProgress({
			id: current.id,
			target: current.target,
			operation: current.operation,
			phase: "starting",
			stepIndex: 0,
			stepTotal: current.steps.length
		});
		runAction.run(api.run(current.id), {
			onSuccess: complete,
			onFailure: () => {
				setRunning(false);
				setCopyError(
					"Connection to the Unreal step was lost. Check its status before retrying."
				);
			}
		});
	};
	const cancel = () => {
		const current = progress();
		if (!current || !api) {
			setPlan(undefined);
			setFiles(undefined);
			return;
		}
		cancelAction.run(api.cancel(current.id), {
			onSuccess: complete,
			onFailure: () => setCopyError("Couldn’t cancel Unreal. Wait for the step to finish.")
		});
	};
	const showFiles = (kind: "planned" | "changed", offset?: number) => {
		const id =
			kind === "planned"
				? plan()?.id
				: result()?.status === "completed"
					? untrack(() => {
							const value = result();
							return value?.status === "completed" ? value.receipt.id : undefined;
						})
					: undefined;
		if (!api || !id) return;
		fileAction.run(
			api.files({ id, kind, ...(offset === undefined ? undefined : { offset }) }),
			{
				onSuccess: (value) => {
					if (value.status !== "ready") {
						setCopyError(value.message + " " + value.recovery);
						return;
					}
					const update = (previous: FilePage | undefined) =>
						offset && previous
							? { ...value, files: [...previous.files, ...value.files] }
							: value;
					if (kind === "planned") setFiles(update);
					else setChangedFiles(update);
				}
			}
		);
	};
	const copyFiles = () => {
		const current = plan();
		if (!api || !current) return;
		copyAction.run(
			Effect.gen(function* () {
				const paths: string[] = [];
				let offset: number | undefined = 0;
				while (offset !== undefined) {
					const page: WorkbenchOperationFilesResult = yield* api.files({
						id: current.id,
						kind: "planned",
						offset
					});
					if (page.status !== "ready") return false;
					paths.push(...page.files.map((file) => file.path));
					offset = page.nextOffset;
				}
				yield* Effect.tryPromise({
					try: () => navigator.clipboard.writeText(paths.join("\n")),
					catch: String
				});
				return true;
			}),
			{
				onSuccess: (success) => {
					setCopied(success);
					if (!success)
						setCopyError("The file list changed. Open the confirmation again.");
					copyConfirmation.run(Effect.sleep("1500 millis"), {
						onSuccess: () => setCopied(false)
					});
				},
				onFailure: () => setCopyError("Couldn’t copy the file list.")
			}
		);
	};
	return {
		supported: !!api,
		state,
		plan,
		files,
		changedFiles,
		result,
		planning,
		running,
		progress,
		busy,
		reason,
		prepare,
		run,
		cancel,
		showFiles,
		toggleChangedFiles: () => {
			if (changedFiles()) setChangedFiles(undefined);
			else showFiles("changed");
		},
		copyFiles,
		copied,
		copyError
	};
}
export type GameTextOperationsModel = ReturnType<typeof createGameTextOperations>;

export function SyncWithUnreal(props: {
	readonly model: GameTextOperationsModel;
	readonly pending: number;
}) {
	return (
		<Show when={props.pending > 0 && props.model.state()?.operations.includes("sync")}>
			<Button
				size="compact"
				tone="primary"
				disabled={props.model.busy()}
				title={props.model.reason()}
				onClick={() => props.model.prepare("sync")}
			>
				Sync with Unreal
			</Button>
		</Show>
	);
}
export function UnrealSteps(props: { readonly model: GameTextOperationsModel }) {
	const choices = () =>
		(props.model.state()?.operations ?? []).map((operation) => ({
			operation,
			label:
				operationLabels[operation] +
				(props.model.state()?.wholeRecipe ? " (whole recipe)" : "")
		}));
	return (
		<Show when={props.model.supported && choices().length > 0}>
			<LocalizationPicker
				label="Unreal steps"
				value="Unreal steps"
				values={choices().map((choice) => choice.label)}
				disabled={props.model.busy()}
				onSelect={(label) => {
					const choice = choices().find((item) => item.label === label);
					if (choice) props.model.prepare(choice.operation);
				}}
			/>
		</Show>
	);
}
function OperationFiles(props: {
	readonly model: GameTextOperationsModel;
	readonly page: FilePage;
	readonly kind: "planned" | "changed";
}) {
	return (
		<>
			<ul {...stylex.attrs(styles.operationFiles)}>
				<For each={props.page.files}>
					{(file) => (
						<li {...stylex.attrs(styles.mono, !file.planned && styles.warning)}>
							{file.path}
							{!file.planned ? " · unexpected write" : ""}
						</li>
					)}
				</For>
			</ul>
			<Show when={props.page.nextOffset !== undefined}>
				<Button
					size="compact"
					tone="quiet"
					onClick={() => props.model.showFiles(props.kind, props.page.nextOffset)}
				>
					Show more files
				</Button>
			</Show>
		</>
	);
}

export function OperationPanel(props: { readonly model: GameTextOperationsModel }) {
	const completed = () => {
		const value = props.model.result();
		return value?.status === "completed" ? value.receipt : undefined;
	};
	const failed = () => {
		const value = props.model.result();
		return value?.status === "failed" ? value : undefined;
	};
	return (
		<>
			<Show when={props.model.planning()}>
				<p role="status" {...stylex.attrs(styles.muted)}>
					Preparing Unreal step…
				</p>
			</Show>
			<Show when={props.model.plan()}>
				{(plan) => (
					<section
						aria-label="Confirm Unreal step"
						{...stylex.attrs(styles.operationPanel)}
					>
						<div {...stylex.attrs(styles.bar)}>
							<span>
								{operationLabels[plan().operation]} for {plan().target}
								{plan().wholeRecipe
									? " by running its whole config recipe"
									: ""}{" "}
								with Unreal Engine {plan().engine}.
							</span>
							<Button size="compact" tone="quiet" onClick={props.model.copyFiles}>
								{props.model.copied() ? "Copied" : "Copy file list"}
							</Button>
						</div>
						<span {...stylex.attrs(styles.muted)}>
							Files Unreal may write ({plan().fileCount}):
						</span>
						<Show when={props.model.files()}>
							{(page) => (
								<OperationFiles model={props.model} page={page()} kind="planned" />
							)}
						</Show>
						<span {...stylex.attrs(styles.muted)}>
							Check these files out in your source control first; UE Shed does not
							touch source control.
						</span>
						<div {...stylex.attrs(styles.bar)}>
							<Button
								size="compact"
								tone="primary"
								disabled={props.model.busy()}
								title={props.model.reason()}
								onClick={props.model.run}
							>
								Run
							</Button>
							<Button size="compact" tone="quiet" onClick={props.model.cancel}>
								Cancel
							</Button>
						</div>
					</section>
				)}
			</Show>
			<Show when={props.model.progress()}>
				{(progress) => (
					<div role="status" {...stylex.attrs(styles.bar, styles.muted)}>
						{runningLabels[progress().operation]} · {progressLabel(progress())}
						<Button size="compact" tone="quiet" onClick={props.model.cancel}>
							Cancel
						</Button>
					</div>
				)}
			</Show>
			<Show when={props.model.result()}>
				{(result) => (
					<>
						<Show when={completed()}>
							{(value) => (
								<div {...stylex.attrs(styles.muted)}>
									<div role="status" {...stylex.attrs(styles.bar)}>
										{resultLabels[value().operation]}:{" "}
										{textCountLabel(value().changedFiles, "file")} changed
										<Show
											when={
												value().operation === "sync" ||
												value().operation === "import"
											}
										>
											{" · "}
											{textCountLabel(
												value().translationsImported,
												"translation"
											)}{" "}
											imported
										</Show>
										<Button
											size="compact"
											tone="quiet"
											aria-expanded={
												props.model.changedFiles() ? "true" : "false"
											}
											onClick={props.model.toggleChangedFiles}
										>
											{props.model.changedFiles()
												? "Hide changed files"
												: "Show changed files"}
										</Button>
									</div>
									<Show when={value().unplannedFiles > 0}>
										<p role="alert" {...stylex.attrs(styles.warning)}>
											Unreal wrote{" "}
											{textCountLabel(value().unplannedFiles, "file")} outside
											the confirmed file list.
										</p>
									</Show>
									<Show when={!value().refreshed}>
										<p role="alert" {...stylex.attrs(styles.warning)}>
											Files changed, but translations could not be reloaded.
											Rescan to refresh them.
										</p>
									</Show>
									<Show when={props.model.changedFiles()}>
										{(page) => (
											<OperationFiles
												model={props.model}
												page={page()}
												kind="changed"
											/>
										)}
									</Show>
								</div>
							)}
						</Show>
						<Show when={failed()}>
							{(value) => (
								<div role="alert" {...stylex.attrs(styles.muted, styles.warning)}>
									{value().message} {value().recovery}
									<Show when={value().details.length > 0}>
										<details>
											<summary>Show details</summary>
											<pre {...stylex.attrs(styles.operationFiles)}>
												{value().details.join("\n")}
											</pre>
										</details>
									</Show>
								</div>
							)}
						</Show>
						<Show when={result().status === "cancelled"}>
							<span role="status" {...stylex.attrs(styles.muted)}>
								Unreal step cancelled. Check the files before retrying.
							</span>
						</Show>
					</>
				)}
			</Show>
			<Show when={props.model.copyError()}>
				{(message) => (
					<span role="alert" {...stylex.attrs(styles.muted, styles.warning)}>
						{message()}
					</span>
				)}
			</Show>
		</>
	);
}
