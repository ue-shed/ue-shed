import * as stylex from "@stylexjs/stylex";
import type {
	CustodianEngineReport,
	CustodianExecutionMode,
	CustodianProposal,
	CustodianProjectReport,
	CustodianReceipt,
	CustodianReport,
	CustodianTargetId,
	CustodianTarget
} from "@ue-shed/project-custodian/browser";
import { Button, createEffectAction, PageHeader } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause } from "effect";
import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import type {
	CustodianClientApi,
	CustodianPublicError,
	CustodianRunResult
} from "./custodian-client.js";

type ViewState =
	| { readonly status: "loading" }
	| { readonly status: "not_configured" }
	| { readonly status: "cancelled" }
	| { readonly status: "failed"; readonly error: CustodianPublicError }
	| { readonly status: "ready"; readonly report: CustodianReport };

type InventoryItem = CustodianProjectReport | CustodianEngineReport;

type CleanupState =
	| { readonly stage: "select" }
	| { readonly stage: "preparing" }
	| { readonly stage: "approve"; readonly proposal: CustodianProposal }
	| { readonly stage: "executing"; readonly proposal: CustodianProposal }
	| { readonly stage: "result"; readonly receipt: CustodianReceipt }
	| { readonly stage: "failed"; readonly error: CustodianPublicError };

function humanBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"] as const;
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const digits = unit < 2 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
	return value.toFixed(digits) + " " + units[unit];
}

function leaf(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
	return normalized.split("/").at(-1) ?? path;
}

function eligibilityLabel(project: CustodianProjectReport): string {
	switch (project.eligibility.kind) {
		case "candidate":
			return "eligible";
		case "opted_out":
			return "opted out";
		case "recent":
			return Math.ceil(project.eligibility.eligibleAfterDays) + "d grace";
		case "unknown_age":
			return "age unknown";
		case "invalid_policy":
			return "policy refused";
		case "empty":
			return "clean";
	}
}

function stateFrom(result: CustodianRunResult): ViewState {
	switch (result.status) {
		case "completed":
			return { status: "ready", report: result.report };
		case "failed":
			return { status: "failed", error: result.error };
		case "cancelled":
			return { status: "cancelled" };
		case "not_configured":
			return { status: "not_configured" };
	}
}

export function ProjectCustodianRoute(props: { readonly client: CustodianClientApi }) {
	const action = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [cleanupOpen, setCleanupOpen] = createSignal(false);
	const report = createMemo(() => {
		const current = state();
		return current.status === "ready" ? current.report : undefined;
	});
	const inventory = createMemo<readonly InventoryItem[]>(() => {
		const current = report();
		return current === undefined
			? []
			: [...current.projects, ...current.engines].sort(
					(left, right) =>
						right.reclaimableBytes - left.reclaimableBytes ||
						left.name.localeCompare(right.name)
				);
	});

	const run = (operation: () => ReturnType<CustodianClientApi["configuredScan"]>) => {
		setCleanupOpen(false);
		setState({ status: "loading" });
		action.run(operation(), {
			onSuccess: (result) => setState(stateFrom(result)),
			onFailure: (cause) =>
				setState({
					status: "failed",
					error: {
						code: "scan_failed",
						message: Cause.pretty(cause),
						recovery: "Choose a readable directory and retry. No files were changed.",
						retrySafe: true
					}
				})
		});
	};

	onMount(() => run(() => props.client.configuredScan()));

	return (
		<main {...stylex.props(styles.page)}>
			<PageHeader
				eyebrow="Project Custodian · storage evidence"
				actions={
					<>
						<Button
							tone="quiet"
							disabled={state().status === "loading" || report() === undefined}
							onClick={() => run(() => props.client.configuredScan())}
						>
							Rescan
						</Button>
						<Button
							tone="primary"
							disabled={state().status === "loading"}
							onClick={() => run(() => props.client.chooseAndScan())}
						>
							Choose scan root…
						</Button>
					</>
				}
			/>

			<div {...stylex.props(styles.safetyRail)}>
				<span {...stylex.props(styles.safetyMark)}>GUARDED CLEANUP</span>
				<span>
					Every run creates a durable proposal, requires its exact approval phrase, and
					revalidates targets before Trash or permanent deletion.
				</span>
			</div>

			<Show when={state().status === "loading"}>
				<div {...stylex.props(styles.loading)} role="progressbar" aria-busy="true">
					<span {...stylex.props(styles.loadingBar)} />
				</div>
			</Show>

			<Switch>
				<Match when={state().status === "loading"}>
					<EmptyState index="00" title="Reading the rebuildable layer.">
						Walking known Unreal output directories and resolving safety policy.
						Authored content is never a candidate.
					</EmptyState>
				</Match>
				<Match when={state().status === "not_configured" || state().status === "cancelled"}>
					<EmptyState index="01" title="Name the ground to inspect.">
						Choose a project, engine directory, or parent folder. The scan never expands
						beyond that root.
						<div {...stylex.props(styles.emptyAction)}>
							<Button
								tone="primary"
								onClick={() => run(() => props.client.chooseAndScan())}
							>
								Choose scan root…
							</Button>
						</div>
					</EmptyState>
				</Match>
				<Match when={state().status === "failed"}>
					<Show when={state()} keyed>
						{(current: ViewState) => (
							<section {...stylex.props(styles.error)}>
								<span>
									{current.status === "failed" ? current.error.code : "failed"}
								</span>
								<h1>
									{current.status === "failed"
										? current.error.message
										: "Scan failed."}
								</h1>
								<p>
									{current.status === "failed"
										? current.error.recovery
										: "Retry."}
								</p>
							</section>
						)}
					</Show>
				</Match>
				<Match when={report()}>
					{(current: Accessor<CustodianReport>) => (
						<CustodianLedger
							report={current()}
							inventory={inventory()}
							onReviewCleanup={() => setCleanupOpen(true)}
						/>
					)}
				</Match>
			</Switch>

			<Show when={cleanupOpen() ? report() : undefined} keyed>
				{(current) => (
					<CleanupWorkflow
						client={props.client}
						report={current}
						onClose={() => setCleanupOpen(false)}
						onFinished={() => run(() => props.client.configuredScan())}
					/>
				)}
			</Show>
		</main>
	);
}

function EmptyState(props: {
	readonly index: string;
	readonly title: string;
	readonly children: JSX.Element;
}) {
	return (
		<section {...stylex.props(styles.empty)}>
			<span {...stylex.props(styles.emptyIndex)}>{props.index}</span>
			<h1>{props.title}</h1>
			<div {...stylex.props(styles.emptyCopy)}>{props.children}</div>
		</section>
	);
}

function CustodianLedger(props: {
	readonly report: CustodianReport;
	readonly inventory: readonly InventoryItem[];
	readonly onReviewCleanup: () => void;
}) {
	const pressure = () => {
		const threshold = props.report.plan.thresholdBytes;
		return threshold === 0 ? 100 : Math.min(100, (props.report.freeBytes / threshold) * 100);
	};
	return (
		<>
			<section aria-label="Storage summary" {...stylex.props(styles.summary)}>
				<div {...stylex.props(styles.heroMetric)}>
					<span {...stylex.props(styles.metricLabel)}>Rebuildable footprint</span>
					<strong>{humanBytes(props.report.totalReclaimableBytes)}</strong>
					<span {...stylex.props(styles.metricNote)}>
						{props.report.projects.length} projects · {props.report.engines.length}{" "}
						engines
					</span>
				</div>
				<Metric label="Free now" value={humanBytes(props.report.freeBytes)} />
				<Metric
					label="Dry-run queue"
					value={humanBytes(props.report.plan.reclaimableBytes)}
				/>
				<Metric
					label="After plan"
					value={humanBytes(props.report.plan.projectedFreeBytes)}
				/>
			</section>

			<section aria-label="Disk pressure" {...stylex.props(styles.pressure)}>
				<div {...stylex.props(styles.pressureHead)}>
					<span>VOLUME PRESSURE</span>
					<strong>
						{humanBytes(props.report.freeBytes)} free /{" "}
						{humanBytes(props.report.plan.thresholdBytes)} target
					</strong>
				</div>
				<div {...stylex.props(styles.pressureTrack)}>
					<span
						{...stylex.props(styles.pressureFill)}
						style={{ width: pressure() + "%" }}
					/>
					<i {...stylex.props(styles.threshold)} />
				</div>
				<p>{planExplanation(props.report)}</p>
			</section>

			<div {...stylex.props(styles.columns)}>
				<section aria-label="Custodian inventory" {...stylex.props(styles.inventory)}>
					<SectionHeader
						left={"INVENTORY / " + props.inventory.length.toString().padStart(2, "0")}
						right={leaf(props.report.root)}
					/>
					<Show
						when={props.inventory.length > 0}
						fallback={
							<p {...stylex.props(styles.noRows)}>
								No Unreal projects or engines found.
							</p>
						}
					>
						<For each={props.inventory}>
							{(item, index) => <InventoryRow item={item} index={index()} />}
						</For>
					</Show>
				</section>

				<aside aria-label="Dry-run plan" {...stylex.props(styles.plan)}>
					<SectionHeader
						left="DRY-RUN QUEUE"
						right={props.report.plan.items.length.toString().padStart(2, "0")}
					/>
					<Show
						when={props.report.plan.items.length > 0}
						fallback={
							<p {...stylex.props(styles.noRows)}>
								Nothing would be reclaimed under current age and pressure policy.
							</p>
						}
					>
						<For each={props.report.plan.items}>
							{(item, index) => (
								<div {...stylex.props(styles.planItem)}>
									<span {...stylex.props(styles.planOrder)}>
										{String(index() + 1).padStart(2, "0")}
									</span>
									<div>
										<strong>{item.name}</strong>
										<small>{item.targets.length} known targets</small>
									</div>
									<b>{humanBytes(item.bytes)}</b>
								</div>
							)}
						</For>
					</Show>
					<footer {...stylex.props(styles.planFooter)}>
						<div>
							<span>EXECUTION</span>
							<strong>
								{props.report.plan.items.length > 0 ? "AVAILABLE" : "NO QUEUE"}
							</strong>
						</div>
						<Button
							tone="primary"
							disabled={props.report.plan.items.length === 0}
							onClick={props.onReviewCleanup}
						>
							Review cleanup…
						</Button>
					</footer>
				</aside>
			</div>
			<footer {...stylex.props(styles.provenance)}>
				Measured {new Date(props.report.measuredAt).toLocaleString()} · explicit root{" "}
				{props.report.root} · authored directories excluded by construction
			</footer>
		</>
	);
}

function planExplanation(report: CustodianReport): string {
	if (report.plan.status === "pressure_satisfied")
		return "Pressure threshold satisfied. Inventory remains visible; the automatic queue is empty.";
	if (report.plan.status === "nothing_eligible")
		return "No eligible rebuildable output is old enough to queue.";
	return (
		report.plan.items.length +
		" largest item(s) would restore the configured free-space target."
	);
}

function Metric(props: { readonly label: string; readonly value: string }) {
	return (
		<div {...stylex.props(styles.metric)}>
			<span {...stylex.props(styles.metricLabel)}>{props.label}</span>
			<strong>{props.value}</strong>
		</div>
	);
}

function SectionHeader(props: { readonly left: string; readonly right: string }) {
	return (
		<header {...stylex.props(styles.sectionHeader)}>
			<span>{props.left}</span>
			<span>{props.right}</span>
		</header>
	);
}

function InventoryRow(props: { readonly item: InventoryItem; readonly index: number }) {
	const status = () =>
		props.item.kind === "project"
			? eligibilityLabel(props.item)
			: props.item.buildKind + " build";
	return (
		<details {...stylex.props(styles.row)}>
			<summary {...stylex.props(styles.rowSummary)}>
				<span {...stylex.props(styles.rowIndex)}>
					{String(props.index + 1).padStart(2, "0")}
				</span>
				<span
					{...stylex.props(
						styles.kind,
						props.item.kind === "engine" && styles.engineKind
					)}
				>
					{props.item.kind === "project" ? "PROJECT" : "ENGINE"}
				</span>
				<span {...stylex.props(styles.identity)}>
					<strong>{props.item.name}</strong>
					<small>{props.item.root}</small>
				</span>
				<span {...stylex.props(styles.rowStatus)}>{status()}</span>
				<b {...stylex.props(styles.rowBytes)}>{humanBytes(props.item.reclaimableBytes)}</b>
			</summary>
			<div {...stylex.props(styles.targets)}>
				<For each={props.item.targets}>{(target) => <TargetRow target={target} />}</For>
				<For each={props.item.refusals}>
					{(entry) => (
						<div {...stylex.props(styles.refusal)}>
							<span>LOCKED</span>
							<strong>{entry.relativePath}</strong>
							<small>{entry.reason}</small>
						</div>
					)}
				</For>
			</div>
		</details>
	);
}

function TargetRow(props: { readonly target: CustodianTarget }) {
	const riskStyle = () =>
		({ low: styles.low, medium: styles.medium, high: styles.high, critical: styles.critical })[
			props.target.risk
		];
	return (
		<div {...stylex.props(styles.target)}>
			<span {...stylex.props(styles.risk, riskStyle())}>{props.target.risk}</span>
			<div>
				<strong>{props.target.relativePath}</strong>
				<small>{props.target.rebuildCost}</small>
			</div>
			<b>{humanBytes(props.target.bytes)}</b>
		</div>
	);
}

function CleanupWorkflow(props: {
	readonly client: CustodianClientApi;
	readonly report: CustodianReport;
	readonly onClose: () => void;
	readonly onFinished: () => void;
}) {
	const action = createEffectAction();
	const cancelAction = createEffectAction();
	const targets = props.report.plan.items.flatMap((item) =>
		item.targets.map((target) => ({ owner: item.name, target }))
	);
	const [selectedIds, setSelectedIds] = createSignal<readonly CustodianTargetId[]>(
		targets.map(({ target }) => target.id)
	);
	const [mode, setMode] = createSignal<CustodianExecutionMode>("trash");
	const [approval, setApproval] = createSignal("");
	const [cancelRequested, setCancelRequested] = createSignal(false);
	const [state, setState] = createSignal<CleanupState>({ stage: "select" });
	const selectedTargets = createMemo(() =>
		targets.filter(({ target }) => selectedIds().includes(target.id))
	);
	const selectedBytes = createMemo(() =>
		selectedTargets().reduce((total, { target }) => total + target.bytes, 0)
	);
	const step = createMemo(() => {
		switch (state().stage) {
			case "select":
			case "preparing":
				return 0;
			case "approve":
				return 1;
			default:
				return 2;
		}
	});
	const toggle = (targetId: CustodianTargetId) => {
		setSelectedIds((current) =>
			current.includes(targetId)
				? current.filter((candidate) => candidate !== targetId)
				: [...current, targetId]
		);
	};
	const clientFailure = (cause: Cause.Cause<unknown>): CustodianPublicError => ({
		code: "execution_failed",
		message: Cause.pretty(cause),
		recovery: "Restart Workbench, rescan the root, and inspect durable cleanup records.",
		retrySafe: false
	});
	const prepare = () => {
		if (selectedIds().length === 0) return;
		setState({ stage: "preparing" });
		action.run(
			props.client.prepare({
				root: props.report.root,
				ignorePressure: false,
				mode: mode(),
				targetIds: selectedIds()
			}),
			{
				onFailure: (cause) => setState({ stage: "failed", error: clientFailure(cause) }),
				onSuccess: (result) =>
					result.status === "completed"
						? setState({ stage: "approve", proposal: result.proposal })
						: setState({ stage: "failed", error: result.error })
			}
		);
	};
	const execute = (proposal: CustodianProposal) => {
		if (approval() !== proposal.approvalPhrase) return;
		setState({ stage: "executing", proposal });
		action.run(
			props.client.execute({
				proposalPath: proposal.proposalPath,
				approvalPhrase: approval()
			}),
			{
				onFailure: (cause) => setState({ stage: "failed", error: clientFailure(cause) }),
				onSuccess: (result) =>
					result.status === "completed"
						? setState({ stage: "result", receipt: result.receipt })
						: setState({ stage: "failed", error: result.error })
			}
		);
	};
	const cancel = (proposal: CustodianProposal) => {
		setCancelRequested(true);
		cancelAction.run(props.client.cancel(proposal.id), {
			onFailure: (cause) => setState({ stage: "failed", error: clientFailure(cause) }),
			onSuccess: (result) => {
				if (result.status === "failed") setState({ stage: "failed", error: result.error });
			}
		});
	};

	return (
		<div {...stylex.props(styles.workflowScrim)}>
			<section
				role="dialog"
				aria-modal="true"
				aria-labelledby="custodian-cleanup-title"
				{...stylex.props(styles.workflow)}
			>
				<header {...stylex.props(styles.workflowHeader)}>
					<div>
						<span {...stylex.props(styles.workflowKicker)}>DESTRUCTIVE BOUNDARY</span>
						<h2 id="custodian-cleanup-title">Review cleanup</h2>
					</div>
					<button
						type="button"
						aria-label="Close cleanup workflow"
						disabled={state().stage === "executing"}
						onClick={props.onClose}
						{...stylex.props(styles.workflowClose)}
					>
						×
					</button>
				</header>

				<ol aria-label="Cleanup workflow progress" {...stylex.props(styles.workflowSteps)}>
					<For each={["SELECT", "APPROVE", "EXECUTE"] as const}>
						{(label, index) => (
							<li
								{...stylex.props(
									styles.workflowStep,
									index() <= step() && styles.workflowStepActive
								)}
							>
								<span>{String(index() + 1).padStart(2, "0")}</span>
								<strong>{label}</strong>
							</li>
						)}
					</For>
				</ol>

				<div {...stylex.props(styles.workflowBody)}>
					<Switch>
						<Match when={state().stage === "select" || state().stage === "preparing"}>
							<section
								aria-label="Select cleanup targets"
								{...stylex.props(styles.workflowStage)}
							>
								<p {...stylex.props(styles.workflowIndex)}>01 / SELECT TARGETS</p>
								<h3>Choose the rebuildable layer to reclaim.</h3>
								<p {...stylex.props(styles.workflowCopy)}>
									The proposal records exact target IDs and measured bytes.
									Authored Content, Source, Config, project roots, and save games
									cannot enter this list.
								</p>
								<div {...stylex.props(styles.modeGrid)}>
									<label
										{...stylex.props(
											styles.modeChoice,
											mode() === "trash" && styles.modeSelected
										)}
									>
										<input
											type="radio"
											name="cleanup-mode"
											checked={mode() === "trash"}
											onChange={() => setMode("trash")}
										/>
										<span {...stylex.props(styles.modeCopy)}>
											<strong>Trash / Recycle Bin</strong>
											<small>
												Recoverable. Space returns after the bin is emptied.
											</small>
										</span>
									</label>
									<label
										{...stylex.props(
											styles.modeChoice,
											mode() === "permanent" && styles.modeDanger
										)}
									>
										<input
											type="radio"
											name="cleanup-mode"
											checked={mode() === "permanent"}
											onChange={() => setMode("permanent")}
										/>
										<span {...stylex.props(styles.modeCopy)}>
											<strong>Permanent deletion</strong>
											<small>
												Immediate space. These directories cannot be
												restored.
											</small>
										</span>
									</label>
								</div>
								<ul {...stylex.props(styles.cleanupTargets)}>
									<For each={targets}>
										{({ owner, target }) => (
											<li {...stylex.props(styles.cleanupTarget)}>
												<label {...stylex.props(styles.cleanupTargetLabel)}>
													<input
														type="checkbox"
														checked={selectedIds().includes(target.id)}
														onChange={() => toggle(target.id)}
													/>
													<span
														{...stylex.props(styles.cleanupTargetCopy)}
													>
														<strong>{target.relativePath}</strong>
														<small>
															{owner} · {target.rebuildCost}
														</small>
													</span>
													<b>{humanBytes(target.bytes)}</b>
												</label>
											</li>
										)}
									</For>
								</ul>
							</section>
						</Match>

						<Match when={state().stage === "approve"}>
							{(() => {
								const current = state();
								if (current.stage !== "approve") return null;
								return (
									<section
										aria-label="Approve cleanup proposal"
										{...stylex.props(styles.workflowStage)}
									>
										<p {...stylex.props(styles.workflowIndex)}>
											02 / APPROVE PROPOSAL
										</p>
										<h3>The plan is now durable.</h3>
										<p {...stylex.props(styles.workflowCopy)}>
											Nothing has moved yet. The executor will rescan every
											target, refuse drift, and refuse while any Unreal Editor
											is running.
										</p>
										<dl {...stylex.props(styles.proposalFacts)}>
											<div {...stylex.props(styles.proposalFact)}>
												<dt {...stylex.props(styles.proposalFactLabel)}>
													Mode
												</dt>
												<dd {...stylex.props(styles.proposalFactValue)}>
													{current.proposal.mode}
												</dd>
											</div>
											<div {...stylex.props(styles.proposalFact)}>
												<dt {...stylex.props(styles.proposalFactLabel)}>
													Targets
												</dt>
												<dd {...stylex.props(styles.proposalFactValue)}>
													{current.proposal.targets.length}
												</dd>
											</div>
											<div {...stylex.props(styles.proposalFact)}>
												<dt {...stylex.props(styles.proposalFactLabel)}>
													Measured
												</dt>
												<dd {...stylex.props(styles.proposalFactValue)}>
													{humanBytes(current.proposal.bytes)}
												</dd>
											</div>
											<div {...stylex.props(styles.proposalFact)}>
												<dt {...stylex.props(styles.proposalFactLabel)}>
													Proposal
												</dt>
												<dd {...stylex.props(styles.proposalFactValue)}>
													{leaf(current.proposal.proposalPath)}
												</dd>
											</div>
										</dl>
										<label {...stylex.props(styles.approvalLabel)}>
											<span>Type the exact approval phrase</span>
											<code>{current.proposal.approvalPhrase}</code>
											<input
												value={approval()}
												onInput={(event) =>
													setApproval(event.currentTarget.value)
												}
												autocomplete="off"
												spellcheck={false}
											/>
										</label>
									</section>
								);
							})()}
						</Match>

						<Match when={state().stage === "executing"}>
							<section
								aria-label="Cleanup in progress"
								aria-live="polite"
								{...stylex.props(styles.executing)}
							>
								<span {...stylex.props(styles.executionPulse)} />
								<p {...stylex.props(styles.workflowIndex)}>03 / EXECUTE</p>
								<h3>
									{cancelRequested()
										? "Cancelling remaining targets…"
										: "Revalidating, then reclaiming."}
								</h3>
								<p>Each completed target is appended to the durable event log.</p>
							</section>
						</Match>

						<Match when={state().stage === "result"}>
							{(() => {
								const current = state();
								if (current.stage !== "result") return null;
								return <CleanupResult receipt={current.receipt} />;
							})()}
						</Match>

						<Match when={state().stage === "failed"}>
							{(() => {
								const current = state();
								if (current.stage !== "failed") return null;
								return (
									<section role="alert" {...stylex.props(styles.workflowFailure)}>
										<p {...stylex.props(styles.workflowIndex)}>
											CLEANUP FAILED
										</p>
										<h3>{current.error.message}</h3>
										<p>{current.error.recovery}</p>
									</section>
								);
							})()}
						</Match>
					</Switch>
				</div>

				<footer {...stylex.props(styles.workflowFooter)}>
					<Show when={state().stage === "select" || state().stage === "preparing"}>
						<button
							type="button"
							onClick={props.onClose}
							{...stylex.props(styles.secondaryAction)}
						>
							CANCEL
						</button>
						<span {...stylex.props(styles.selectionTotal)}>
							{selectedIds().length} TARGETS · {humanBytes(selectedBytes())}
						</span>
						<button
							type="button"
							disabled={selectedIds().length === 0 || state().stage === "preparing"}
							onClick={prepare}
							{...stylex.props(styles.primaryAction)}
						>
							{state().stage === "preparing" ? "CREATING…" : "CREATE PROPOSAL →"}
						</button>
					</Show>
					<Show when={state().stage === "approve"}>
						{(() => {
							const current = state();
							if (current.stage !== "approve") return null;
							return (
								<>
									<button
										type="button"
										onClick={props.onClose}
										{...stylex.props(styles.secondaryAction)}
									>
										CLOSE
									</button>
									<button
										type="button"
										disabled={approval() !== current.proposal.approvalPhrase}
										onClick={() => execute(current.proposal)}
										{...stylex.props(styles.dangerAction)}
									>
										{current.proposal.mode === "trash"
											? "MOVE TO TRASH"
											: "DELETE PERMANENTLY"}
									</button>
								</>
							);
						})()}
					</Show>
					<Show when={state().stage === "executing"}>
						{(() => {
							const current = state();
							if (current.stage !== "executing") return null;
							return (
								<button
									type="button"
									disabled={cancelRequested()}
									onClick={() => cancel(current.proposal)}
									{...stylex.props(styles.secondaryAction)}
								>
									CANCEL REMAINING
								</button>
							);
						})()}
					</Show>
					<Show when={state().stage === "result" || state().stage === "failed"}>
						<button
							type="button"
							onClick={props.onFinished}
							{...stylex.props(styles.primaryAction)}
						>
							DONE · RESCAN
						</button>
					</Show>
				</footer>
			</section>
		</div>
	);
}

function CleanupResult(props: { readonly receipt: CustodianReceipt }) {
	return (
		<section
			aria-label="Cleanup result"
			aria-live="polite"
			{...stylex.props(styles.workflowStage)}
		>
			<p {...stylex.props(styles.workflowIndex)}>03 / {props.receipt.status.toUpperCase()}</p>
			<h3>
				{props.receipt.status === "completed"
					? "Cleanup finished with durable evidence."
					: props.receipt.status === "refused"
						? "Cleanup was refused before mutation."
						: props.receipt.status === "cancelled"
							? "Remaining targets were cancelled."
							: "Cleanup completed partially."}
			</h3>
			<Show when={props.receipt.refusal} keyed>
				{(refusal) => (
					<div role="alert" {...stylex.props(styles.receiptRefusal)}>
						<strong>{refusal.message}</strong>
						<p>{refusal.recovery}</p>
					</div>
				)}
			</Show>
			<div {...stylex.props(styles.resultSummary)}>
				<div {...stylex.props(styles.resultDatum)}>
					<strong>
						{
							props.receipt.entries.filter(
								({ status }) => status === "trashed" || status === "deleted"
							).length
						}
					</strong>
					<span>PROCESSED</span>
				</div>
				<div {...stylex.props(styles.resultDatum)}>
					<strong>{humanBytes(props.receipt.processedBytes)}</strong>
					<span>{props.receipt.mode === "trash" ? "MOVED" : "DELETED"}</span>
				</div>
				<div {...stylex.props(styles.resultDatum)}>
					<strong>
						{props.receipt.entries.filter(({ status }) => status === "failed").length}
					</strong>
					<span>FAILED</span>
				</div>
			</div>
			<ul {...stylex.props(styles.receiptEntries)}>
				<For each={props.receipt.entries}>
					{(entry) => (
						<li {...stylex.props(styles.receiptEntry)}>
							<span>{entry.status.toUpperCase()}</span>
							<strong>{entry.relativePath}</strong>
							<small>{entry.message ?? humanBytes(entry.bytes)}</small>
						</li>
					)}
				</For>
			</ul>
			<p {...stylex.props(styles.receiptPath)}>Receipt · {props.receipt.receiptPath}</p>
		</section>
	);
}

const sweep = stylex.keyframes({
	from: { transform: "translateX(-100%)" },
	to: { transform: "translateX(420%)" }
});

const styles = stylex.create({
	page: {
		minHeight: "calc(100vh - 52px)",
		padding: "24px 30px 34px",
		backgroundColor: tokens.colorCanvas,
		backgroundImage:
			"linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px)",
		backgroundSize: "24px 24px",
		color: tokens.colorText
	},
	safetyRail: {
		display: "flex",
		alignItems: "center",
		gap: 12,
		margin: "10px 0 18px",
		padding: "9px 12px",
		borderLeft: `3px solid ${tokens.colorSuccess}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontSize: 11,
		letterSpacing: ".03em"
	},
	safetyMark: { color: tokens.colorSuccess, fontWeight: 590, letterSpacing: "0" },
	loading: { height: 2, overflow: "hidden", backgroundColor: tokens.colorBorder },
	loadingBar: {
		display: "block",
		width: "24%",
		height: "100%",
		backgroundColor: tokens.colorWarning,
		animationName: sweep,
		animationDuration: "1.2s",
		animationIterationCount: "infinite",
		animationTimingFunction: "ease-in-out"
	},
	empty: {
		position: "relative",
		maxWidth: 670,
		margin: "72px auto",
		padding: "30px 0 30px 88px",
		borderTop: `1px solid ${tokens.colorBorder}`,
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	emptyIndex: {
		position: "absolute",
		left: 0,
		top: 30,
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 26
	},
	emptyCopy: { color: tokens.colorTextMuted, fontSize: 11, lineHeight: 1.7 },
	emptyAction: { marginTop: 18 },
	error: {
		maxWidth: 780,
		margin: "50px auto",
		padding: 24,
		border: "1px solid rgba(235, 87, 87, 0.35)",
		backgroundColor: "rgba(235, 87, 87, 0.08)"
	},
	summary: {
		display: "grid",
		gridTemplateColumns: "minmax(290px, 1.5fr) repeat(3, minmax(130px, .7fr))",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface
	},
	heroMetric: { padding: "18px 22px", borderRight: `1px solid ${tokens.colorBorder}` },
	metric: { padding: "18px", borderRight: `1px solid ${tokens.colorBorder}` },
	metricLabel: {
		display: "block",
		marginBottom: 8,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: "0",
		textTransform: "none"
	},
	metricNote: { display: "block", marginTop: 7, color: tokens.colorTextMuted, fontSize: 11 },
	pressure: {
		marginTop: 12,
		padding: "13px 16px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface
	},
	pressureHead: {
		display: "flex",
		justifyContent: "space-between",
		color: tokens.colorTextMuted,
		fontSize: 11,
		letterSpacing: "0"
	},
	pressureTrack: {
		position: "relative",
		height: 7,
		marginTop: 11,
		backgroundColor: tokens.colorSurfaceInset,
		overflow: "hidden"
	},
	pressureFill: { display: "block", height: "100%", backgroundColor: tokens.colorSuccess },
	threshold: {
		position: "absolute",
		right: 0,
		top: -2,
		width: 2,
		height: 11,
		backgroundColor: tokens.colorWarning
	},
	columns: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1.8fr) minmax(280px, .7fr)",
		gap: 12,
		marginTop: 12
	},
	inventory: { border: `1px solid ${tokens.colorBorder}`, backgroundColor: tokens.colorSurface },
	plan: { border: `1px solid ${tokens.colorBorder}`, backgroundColor: tokens.colorSurface },
	sectionHeader: {
		display: "flex",
		justifyContent: "space-between",
		padding: "10px 13px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: "0"
	},
	noRows: { padding: 18, color: tokens.colorTextMuted, fontSize: 12, lineHeight: 1.6 },
	row: { borderBottom: `1px solid ${tokens.colorBorder}` },
	rowSummary: {
		display: "grid",
		gridTemplateColumns: "30px 58px minmax(0, 1fr) 88px 88px",
		alignItems: "center",
		gap: 9,
		padding: "12px 13px",
		borderRadius: tokens.radiusControl,
		cursor: "pointer",
		listStyle: "none",
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" }
	},
	rowIndex: {
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 13
	},
	kind: {
		color: tokens.colorWarning,
		fontSize: 11,
		fontWeight: 590,
		letterSpacing: "0"
	},
	engineKind: { color: "#02b8cc" },
	identity: { minWidth: 0, overflow: "hidden" },
	rowStatus: { color: tokens.colorTextMuted, fontSize: 11, textTransform: "none" },
	rowBytes: { color: tokens.colorTextStrong, fontSize: 11, textAlign: "right" },
	targets: { padding: "0 13px 10px 110px", backgroundColor: tokens.colorSurfaceInset },
	target: {
		display: "grid",
		gridTemplateColumns: "48px minmax(0, 1fr) 72px",
		alignItems: "center",
		gap: 10,
		padding: "9px 0",
		borderBottom: `1px dotted ${tokens.colorBorder}`
	},
	risk: { fontSize: 11, letterSpacing: "0", textTransform: "none" },
	low: { color: tokens.colorSuccess },
	medium: { color: tokens.colorWarning },
	high: { color: tokens.colorWarningStrong },
	critical: { color: tokens.colorDanger },
	refusal: {
		display: "grid",
		gridTemplateColumns: "48px 150px minmax(0, 1fr)",
		gap: 10,
		padding: "9px 0",
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	planItem: {
		display: "grid",
		gridTemplateColumns: "28px minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 10,
		padding: "13px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	planOrder: { color: tokens.colorWarning, fontFamily: tokens.fontMono, fontSize: 16 },
	planFooter: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: 10,
		margin: 12,
		paddingTop: 12,
		borderTop: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted,
		fontSize: 11,
		letterSpacing: "0"
	},
	workflowScrim: {
		position: "fixed",
		inset: 0,
		zIndex: 90,
		display: "flex",
		justifyContent: "flex-end",
		backgroundColor: "rgba(8, 9, 10, 0.78)",
		backdropFilter: "blur(4px)"
	},
	workflow: {
		width: "min(620px, 96vw)",
		height: "100%",
		display: "grid",
		gridTemplateRows: "auto auto minmax(0, 1fr) auto",
		borderLeft: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: tokens.shadowOverlay,
		color: tokens.colorText
	},
	workflowHeader: {
		minHeight: 94,
		display: "flex",
		alignItems: "flex-start",
		justifyContent: "space-between",
		padding: "22px 24px 18px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	workflowKicker: {
		color: tokens.colorDanger,
		fontSize: 11,
		fontWeight: 590,
		letterSpacing: "0"
	},
	workflowClose: {
		width: 32,
		height: 32,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		fontSize: 20,
		cursor: "pointer"
	},
	workflowSteps: {
		listStyle: "none",
		margin: 0,
		padding: 0,
		display: "grid",
		gridTemplateColumns: "repeat(3, 1fr)",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	workflowStep: {
		display: "flex",
		gap: 8,
		padding: "12px 16px",
		borderRight: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: "0"
	},
	workflowStepActive: {
		color: tokens.colorTextStrong,
		boxShadow: `inset 0 -2px ${tokens.colorAccent}`
	},
	workflowBody: { overflowY: "auto" },
	workflowStage: { padding: "28px 26px 34px" },
	workflowIndex: { color: tokens.colorWarning, fontSize: 11, letterSpacing: "0" },
	workflowCopy: { color: tokens.colorTextMuted, fontSize: 11, lineHeight: 1.7 },
	modeGrid: {
		display: "grid",
		gridTemplateColumns: "1fr 1fr",
		gap: 8,
		margin: "22px 0 14px"
	},
	modeChoice: {
		minHeight: 84,
		display: "grid",
		gridTemplateColumns: "18px 1fr",
		alignContent: "center",
		gap: "5px 8px",
		padding: 13,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorText,
		fontSize: 12,
		cursor: "pointer"
	},
	modeCopy: { minWidth: 0, display: "flex", flexDirection: "column", gap: 6, lineHeight: 1.45 },
	modeSelected: { borderColor: tokens.colorAccent, backgroundColor: tokens.colorAccentWash },
	modeDanger: {
		borderColor: tokens.colorDanger,
		backgroundColor: "rgba(235, 87, 87, 0.10)"
	},
	cleanupTargets: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 },
	cleanupTarget: {
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset
	},
	cleanupTargetLabel: {
		minHeight: 62,
		display: "grid",
		gridTemplateColumns: "18px minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 10,
		padding: "0 13px",
		cursor: "pointer"
	},
	cleanupTargetCopy: { minWidth: 0, display: "flex", flexDirection: "column", gap: 5 },
	proposalFacts: { margin: "22px 0", border: `1px solid ${tokens.colorBorder}` },
	proposalFact: {
		minHeight: 42,
		display: "grid",
		gridTemplateColumns: "120px minmax(0, 1fr)",
		alignItems: "center",
		padding: "0 13px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	proposalFactLabel: {
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: "0"
	},
	proposalFactValue: {
		margin: 0,
		color: tokens.colorText,
		fontSize: 12,
		overflow: "hidden",
		textOverflow: "ellipsis"
	},
	approvalLabel: {
		display: "grid",
		gap: 8,
		padding: 16,
		borderLeft: `3px solid ${tokens.colorWarning}`,
		backgroundColor: "rgba(242, 153, 74, 0.08)",
		color: tokens.colorTextMuted,
		fontSize: 11,
		letterSpacing: "0"
	},
	executing: {
		minHeight: "100%",
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		padding: 30,
		textAlign: "center",
		color: tokens.colorTextMuted
	},
	executionPulse: {
		width: 74,
		height: 74,
		marginBottom: 20,
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderTopColor: tokens.colorWarning,
		borderRadius: "50%",
		animationName: stylex.keyframes({ to: { transform: "rotate(360deg)" } }),
		animationDuration: "1.8s",
		animationIterationCount: "infinite",
		animationTimingFunction: "linear"
	},
	workflowFailure: { padding: 28, color: tokens.colorDanger },
	workflowFooter: {
		minHeight: 72,
		display: "flex",
		alignItems: "center",
		justifyContent: "flex-end",
		gap: 9,
		padding: "14px 20px",
		borderTop: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset
	},
	secondaryAction: {
		minHeight: 38,
		padding: "0 16px",
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		fontSize: 12,
		letterSpacing: "0",
		cursor: "pointer"
	},
	selectionTotal: {
		marginRight: "auto",
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: "0"
	},
	primaryAction: {
		minHeight: 38,
		padding: "0 18px",
		border: `1px solid ${tokens.colorAccent}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: tokens.colorAccent,
			":hover": tokens.colorAccentStrong,
			":disabled": "rgba(228, 242, 34, 0.25)"
		},
		color: tokens.colorAccentText,
		fontSize: 12,
		fontWeight: 590,
		letterSpacing: "0",
		cursor: "pointer"
	},
	dangerAction: {
		minHeight: 38,
		padding: "0 18px",
		border: `1px solid ${tokens.colorDanger}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: tokens.colorDanger,
			":hover": "#f47b7b",
			":disabled": "rgba(235, 87, 87, 0.25)"
		},
		color: "#160707",
		fontSize: 12,
		fontWeight: 590,
		letterSpacing: "0",
		cursor: "pointer"
	},
	receiptRefusal: {
		margin: "18px 0",
		padding: 15,
		borderLeft: `3px solid ${tokens.colorDanger}`,
		backgroundColor: "rgba(235, 87, 87, 0.10)",
		color: tokens.colorDanger,
		fontSize: 12
	},
	resultSummary: {
		display: "grid",
		gridTemplateColumns: "repeat(3, 1fr)",
		margin: "22px 0",
		border: `1px solid ${tokens.colorBorder}`
	},
	resultDatum: {
		minHeight: 78,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 7,
		borderRight: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted,
		fontSize: 11,
		letterSpacing: "0"
	},
	receiptEntries: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 5 },
	receiptEntry: {
		display: "grid",
		gridTemplateColumns: "72px minmax(0, 1fr) auto",
		gap: 10,
		padding: "10px 12px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset,
		fontSize: 12
	},
	receiptPath: {
		marginTop: 18,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		overflowWrap: "anywhere"
	},
	provenance: {
		marginTop: 12,
		color: tokens.colorTextFaint,
		fontSize: 11,
		letterSpacing: ".04em",
		overflowWrap: "anywhere"
	}
});
