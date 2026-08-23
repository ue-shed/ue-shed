import * as stylex from "@stylexjs/stylex";
import { Button, createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause } from "effect";
import {
	For,
	Match,
	Show,
	Switch,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount
} from "solid-js";
import type { MapReviewClientApi, MapReviewResult, MapReviewRunView } from "./map-review-client.js";
import { MapReviewAuthoring } from "./map-review-authoring.js";
import { CaptureWorkflow } from "./capture-workflow.js";
import { ReviewSetLibrary } from "./review-set-library.js";
import { SavedWorldScout } from "./saved-world-scout.js";
import { WorldScout } from "./world-scout.js";
import { VisibilityPolicySettings } from "./visibility-policy-settings.js";
import type { ObservedActor } from "@ue-shed/observatory";

type ViewState = { readonly status: "loading" } | MapReviewResult;
type RunArtifact = NonNullable<MapReviewRunView["capture"]>["artifacts"][number];
type RunCapture = NonNullable<MapReviewRunView["capture"]>;

function visibilitySummary(visibility: RunCapture["visibility"]): string {
	return visibility.status === "assessed"
		? `${Math.round(visibility.visibleFraction * 100)}% · ${visibility.method.method.replaceAll("_", " ")}`
		: visibility.status.replaceAll("_", " ");
}

function clearSummary(clear: RunCapture["clearCompanion"]): string {
	return clear.status === "not_requested"
		? "not requested"
		: `${clear.status} · ${clear.strategy.replaceAll("_", " ")}`;
}

function restorationSummary(clear: RunCapture["clearCompanion"]): string {
	return clear.status === "not_requested" ? "not applicable" : clear.restoration.status;
}

function revisionSummary(
	revision: RunCapture["viewRevision"],
	currentRevisionId: string | undefined
): string {
	return revision.status === "numbered"
		? `r${revision.number}${revision.id === currentRevisionId ? " · current" : " · older framing"}`
		: "legacy · unversioned";
}

function captureExplanations(capture: RunCapture): ReadonlyArray<string> {
	const limitations =
		capture.visibility.status === "assessment_failed"
			? [capture.visibility.failure.message]
			: [...(capture.visibility.limitations ?? [])];
	if (capture.clearCompanion.status === "not_requested") return limitations;
	const interventions = capture.clearCompanion.interventions.map((intervention) =>
		intervention.type === "show_only_subject_components"
			? `Isolated ${intervention.subject.diagnosticLabel ?? intervention.subject.actorPath}`
			: `Hid ${intervention.target.diagnosticLabel ?? intervention.target.actorPath}`
	);
	return capture.clearCompanion.status === "failed"
		? [...limitations, ...interventions, capture.clearCompanion.failure.message]
		: [...limitations, ...interventions];
}

function ArtifactImage(props: { readonly artifact: RunArtifact; readonly alt: string }) {
	const [source, setSource] = createSignal<string>();
	createEffect(() => {
		const bytes = Uint8Array.from(props.artifact.bytes);
		const url = URL.createObjectURL(new Blob([bytes.buffer], { type: "image/png" }));
		setSource(url);
		onCleanup(() => URL.revokeObjectURL(url));
	});
	return (
		<Show when={source()}>
			{(url) => <img src={url()} alt={props.alt} {...stylex.props(styles.previewImage)} />}
		</Show>
	);
}

export function MapReviewRoute(props: { readonly client: MapReviewClientApi }) {
	const action = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [selectedRunId, setSelectedRunId] = createSignal<string>();
	const [selectedViewId, setSelectedViewId] = createSignal<string>();
	const [authoringMode, setAuthoringMode] = createSignal<"append" | "revise">("append");
	const [comparisonMode, setComparisonMode] = createSignal<
		"pure" | "clear" | "side_by_side" | "previous"
	>("pure");
	const [focusRequest, setFocusRequest] = createSignal<{
		readonly actor: ObservedActor;
		readonly nonce: number;
	}>();
	const [captureOpen, setCaptureOpen] = createSignal(false);
	const [setLibraryOpen, setSetLibraryOpen] = createSignal(false);
	const [worldSource, setWorldSource] = createSignal<"saved" | "live">(
		props.client.readSavedWorld === undefined || props.client.savedWorldMaps === undefined
			? "live"
			: "saved"
	);
	const ready = createMemo(() => {
		const current = state();
		if (current.status === "ready") return current;
		return undefined;
	});
	const selected = createMemo(() => {
		const current = ready();
		return current?.runs.find((run) => run.id === selectedRunId()) ?? current?.runs[0];
	});
	const selectedView = createMemo(() =>
		ready()?.reviewSet.views.find((view) => view.id === selectedViewId())
	);
	const capturesForRun = (run: MapReviewRunView): ReadonlyArray<RunCapture> =>
		run.captures ?? (run.capture === undefined ? [] : [run.capture]);
	const selectedCapture = createMemo(() => {
		const run = selected();
		if (run === undefined) return undefined;
		const viewId = selectedViewId();
		return capturesForRun(run).find((capture) => capture.viewId === viewId);
	});
	const selectedFailure = createMemo(() =>
		selected()?.failures?.find((failure) => failure.viewId === selectedViewId())
	);
	const subjectGroups = createMemo(() => {
		const groups = new Map<
			string,
			Array<NonNullable<ReturnType<typeof ready>>["reviewSet"]["views"][number]>
		>();
		for (const view of ready()?.reviewSet.views ?? []) {
			const key = view.actorPath ?? `area:${view.id}`;
			groups.set(key, [...(groups.get(key) ?? []), view]);
		}
		return [...groups.entries()];
	});
	const pureArtifact = createMemo(() =>
		selectedCapture()?.artifacts.find((artifact) => artifact.variant === "pure")
	);
	const clearArtifact = createMemo(() =>
		selectedCapture()?.artifacts.find((artifact) => artifact.variant === "clear")
	);
	const previousEvidence = createMemo(() => {
		const current = ready();
		const run = selected();
		if (current === undefined || run === undefined) return undefined;
		const selectedIndex = current.runs.findIndex((candidate) => candidate.id === run.id);
		for (const candidate of current.runs.slice(selectedIndex + 1)) {
			const capture = capturesForRun(candidate).find(
				(item) => item.viewId === selectedViewId()
			);
			const artifact = capture?.artifacts.find((item) => item.variant === "pure");
			if (capture !== undefined && artifact !== undefined) {
				return { artifact, capture, run: candidate };
			}
		}
		return undefined;
	});
	const apply = (result: MapReviewResult) => {
		setState(result);
		if (result.status === "ready") {
			const nextViewId = result.reviewSet.views.some((view) => view.id === selectedViewId())
				? selectedViewId()
				: result.reviewSet.views[0]?.id;
			setSelectedViewId(nextViewId);
			setSelectedRunId(
				result.runs.find((run) =>
					(run.captures ?? (run.capture === undefined ? [] : [run.capture])).some(
						(capture) => capture.viewId === nextViewId
					)
				)?.id ?? result.runs[0]?.id
			);
		}
		setComparisonMode("pure");
	};
	const clientFailure = (cause: Cause.Cause<unknown>): MapReviewResult => ({
		error: {
			message: Cause.pretty(cause),
			recovery: "Restart Workbench. If the problem persists, verify package versions."
		},
		status: "failed"
	});
	const load = () =>
		action.run(props.client.load(), {
			onFailure: (cause) => apply(clientFailure(cause)),
			onSuccess: apply
		});
	onMount(load);

	return (
		<main {...stylex.props(styles.page)}>
			<Show when={setLibraryOpen()}>
				<ReviewSetLibrary
					canCreate={ready() !== undefined}
					client={props.client}
					onChanged={apply}
					onClose={() => setSetLibraryOpen(false)}
				/>
			</Show>
			<Show when={captureOpen() && ready()}>
				{(current) => (
					<CaptureWorkflow
						client={props.client}
						onCaptured={apply}
						onClose={() => setCaptureOpen(false)}
						review={current()}
					/>
				)}
			</Show>
			<header {...stylex.props(styles.header)}>
				<div {...stylex.props(styles.headerCopy)}>
					<h1 {...stylex.props(styles.title)}>Map review</h1>
					<p {...stylex.props(styles.subtitle)}>
						Browse captured views of your map, compare runs side by side, and keep the
						framings worth reusing.
					</p>
				</div>
				<div {...stylex.props(styles.headerActions)}>
					<Button
						type="button"
						disabled={
							state().status === "loading" || state().status === "not_configured"
						}
						onClick={() => setSetLibraryOpen(true)}
						tone="quiet"
					>
						Review sets
					</Button>
					<Button
						type="button"
						disabled={ready() === undefined || worldSource() !== "live"}
						onClick={() => setCaptureOpen(true)}
						tone="primary"
					>
						Capture set
					</Button>
				</div>
			</header>
			<div {...stylex.props(styles.toolbar)}>
				<div
					role="tablist"
					aria-label="Map data source"
					{...stylex.props(styles.sourceTabs)}
				>
					<button
						type="button"
						role="tab"
						aria-selected={worldSource() === "saved"}
						disabled={
							props.client.readSavedWorld === undefined ||
							props.client.savedWorldMaps === undefined
						}
						onClick={() => setWorldSource("saved")}
						{...stylex.props(
							styles.sourceTab,
							worldSource() === "saved" && styles.sourceTabActive
						)}
					>
						Saved map
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={worldSource() === "live"}
						onClick={() => setWorldSource("live")}
						{...stylex.props(
							styles.sourceTab,
							worldSource() === "live" && styles.sourceTabActive
						)}
					>
						Live session
					</button>
				</div>
				<Show when={ready() !== undefined && worldSource() === "live"}>
					<div
						role="group"
						aria-label="Authoring mode"
						{...stylex.props(styles.modeGroup)}
					>
						<button
							type="button"
							aria-pressed={authoringMode() === "append"}
							onClick={() => setAuthoringMode("append")}
							{...stylex.props(
								styles.modeButton,
								authoringMode() === "append" && styles.modeButtonActive
							)}
						>
							Add another view
						</button>
						<button
							type="button"
							disabled={selectedView() === undefined}
							aria-pressed={authoringMode() === "revise"}
							onClick={() => setAuthoringMode("revise")}
							{...stylex.props(
								styles.modeButton,
								authoringMode() === "revise" && styles.modeButtonActive
							)}
						>
							Revise selected view
						</button>
					</div>
				</Show>
			</div>
			<Show
				when={worldSource() === "saved"}
				fallback={
					<WorldScout
						client={props.client}
						onActorFocused={(actor) => {
							setFocusRequest((current) => ({
								actor,
								nonce: (current?.nonce ?? 0) + 1
							}));
						}}
					/>
				}
			>
				<SavedWorldScout client={props.client} />
			</Show>

			<Switch>
				<Match when={state().status === "loading"}>
					<div {...stylex.props(styles.centerState)}>Opening local review history…</div>
				</Match>
				<Match when={state().status === "not_configured"}>
					<div {...stylex.props(styles.centerState)}>
						<strong>No review project is configured.</strong>
						<span>
							Set UE_SHED_PROJECT_ROOT to a project folder, then return here to create
							its first review set.
						</span>
					</div>
				</Match>
				<Match when={state().status === "setup_required"}>
					<div {...stylex.props(styles.setupWorkspace)}>
						<Show
							when={worldSource() === "live"}
							fallback={
								<div {...stylex.props(styles.offlineNote)}>
									Saved map review is ready. Switch to Live session to author or
									capture views.
								</div>
							}
						>
							<MapReviewAuthoring
								client={props.client}
								focusRequest={focusRequest()}
								onApproved={load}
								onChooseReviewSet={() => setSetLibraryOpen(true)}
							/>
						</Show>
					</div>
				</Match>
				<Match when={state().status === "failed"}>
					{(() => {
						const current = state();
						if (current.status !== "failed") return null;
						return (
							<div role="alert" {...stylex.props(styles.stateCard)}>
								<strong {...stylex.props(styles.stateTitle)}>
									Couldn't load review data
								</strong>
								<span>{current.error.recovery}</span>
								<Button type="button" onClick={() => void load()} tone="quiet">
									Retry
								</Button>
								<details {...stylex.props(styles.technical)}>
									<summary>Technical details</summary>
									<code>{current.error.message}</code>
								</details>
							</div>
						);
					})()}
				</Match>
				<Match when={state().status === "blocked"}>
					{(() => {
						const current = state();
						if (current.status !== "blocked") return null;
						return (
							<div role="alert" {...stylex.props(styles.stateCard)}>
								<strong {...stylex.props(styles.stateTitle)}>
									{current.policy.message}
								</strong>
								<span>{current.policy.recovery}</span>
								<Button type="button" onClick={() => void load()} tone="quiet">
									Return to review
								</Button>
							</div>
						);
					})()}
				</Match>
				<Match when={ready()}>
					{(current) => (
						<div {...stylex.props(styles.workspace)}>
							<section
								aria-label="Review set status"
								{...stylex.props(styles.statusStrip)}
							>
								<div {...stylex.props(styles.setIdentity)}>
									<strong>{current().reviewSet.displayName}</strong>
									<code>{current().reviewSet.mapPath}</code>
								</div>
								<div {...stylex.props(styles.stat)}>
									<strong>{current().reviewSet.viewCount}</strong>
									<span>
										{current().reviewSet.viewCount === 1 ? "view" : "views"}
									</span>
								</div>
								<div {...stylex.props(styles.stat)}>
									<strong>{current().runs.length}</strong>
									<span>{current().runs.length === 1 ? "run" : "runs"}</span>
								</div>
							</section>
							<Show when={worldSource() === "live" && current().reviewSet.id} keyed>
								<MapReviewAuthoring
									client={props.client}
									destination={
										authoringMode() === "revise" &&
										selectedViewId() !== undefined
											? {
													kind: "revise_view",
													viewId: selectedViewId()!
												}
											: { kind: "append_view" }
									}
									focusRequest={focusRequest()}
									onApproved={load}
									onChooseReviewSet={() => setSetLibraryOpen(true)}
								/>
							</Show>

							<section
								aria-label="Review views"
								{...stylex.props(styles.viewNavigator)}
							>
								<div {...stylex.props(styles.sectionHeading)}>
									<span>Views · {current().reviewSet.views.length}</span>
								</div>
								<For each={subjectGroups()}>
									{([subject, views]) => (
										<section
											aria-label={`${views[0]?.subjectLabel ?? views[0]?.displayName ?? "Review subject"} views`}
											{...stylex.props(styles.subjectGroup)}
										>
											<div {...stylex.props(styles.subjectIdentity)}>
												<span {...stylex.props(styles.subjectCount)}>
													{views.length}{" "}
													{views.length === 1 ? "view" : "views"}
												</span>
												<strong>
													{views[0]?.subjectLabel ??
														views[0]?.displayName}
												</strong>
												<code>
													{subject.startsWith("area:")
														? "oriented area"
														: subject}
												</code>
											</div>
											<div {...stylex.props(styles.viewRail)}>
												<For each={views}>
													{(view) => (
														<button
															type="button"
															aria-pressed={
																selectedViewId() === view.id
															}
															onClick={() => {
																setSelectedViewId(view.id);
																setComparisonMode("pure");
																setSelectedRunId(
																	current().runs.find((run) =>
																		capturesForRun(run).some(
																			(capture) =>
																				capture.viewId ===
																				view.id
																		)
																	)?.id ?? current().runs[0]?.id
																);
															}}
															{...stylex.props(
																styles.viewCard,
																selectedViewId() === view.id &&
																	styles.viewCardActive
															)}
														>
															<strong>{view.displayName}</strong>
															<small>
																{view.viewpoint?.replaceAll(
																	"_",
																	" "
																) ?? "view"}{" "}
																· r{view.revision?.number ?? "?"}
															</small>
														</button>
													)}
												</For>
											</div>
										</section>
									)}
								</For>
							</section>
							<VisibilityPolicySettings
								client={props.client}
								onUpdated={apply}
								review={current()}
							/>

							<Show
								when={selected()}
								fallback={
									<section
										aria-label="Captures"
										{...stylex.props(styles.emptyState)}
									>
										<p>
											No captures yet. Capture this set to save PNG stills of
											every view.
										</p>
									</section>
								}
							>
								{(run) => (
									<section
										aria-label="Selected capture"
										{...stylex.props(styles.stage)}
									>
										<div>
											<Show when={selectedCapture()}>
												<div
													role="group"
													aria-label="Compare captures"
													{...stylex.props(styles.comparisonControls)}
												>
													<button
														type="button"
														aria-pressed={comparisonMode() === "pure"}
														onClick={() => setComparisonMode("pure")}
														{...stylex.props(
															styles.comparisonButton,
															comparisonMode() === "pure" &&
																styles.comparisonButtonActive
														)}
													>
														Natural
													</button>
													<button
														type="button"
														disabled={clearArtifact() === undefined}
														aria-pressed={comparisonMode() === "clear"}
														onClick={() => setComparisonMode("clear")}
														{...stylex.props(
															styles.comparisonButton,
															comparisonMode() === "clear" &&
																styles.comparisonButtonActive
														)}
													>
														Clear
													</button>
													<button
														type="button"
														disabled={clearArtifact() === undefined}
														aria-pressed={
															comparisonMode() === "side_by_side"
														}
														onClick={() =>
															setComparisonMode("side_by_side")
														}
														{...stylex.props(
															styles.comparisonButton,
															comparisonMode() === "side_by_side" &&
																styles.comparisonButtonActive
														)}
													>
														Side by side
													</button>
													<button
														type="button"
														disabled={previousEvidence() === undefined}
														aria-pressed={
															comparisonMode() === "previous"
														}
														onClick={() =>
															setComparisonMode("previous")
														}
														{...stylex.props(
															styles.comparisonButton,
															comparisonMode() === "previous" &&
																styles.comparisonButtonActive
														)}
													>
														Compare previous run
													</button>
												</div>
											</Show>
											<div
												{...stylex.props(
													styles.comparisonStage,
													(comparisonMode() === "side_by_side" ||
														comparisonMode() === "previous") &&
														styles.comparisonStagePaired
												)}
											>
												<Show
													when={pureArtifact()}
													fallback={
														<div {...stylex.props(styles.imageFrame)}>
															<div
																{...stylex.props(
																	styles.missingPreview
																)}
															>
																<span>
																	{selectedFailure() === undefined
																		? "Not captured in this run"
																		: "View capture failed"}
																</span>
																<small>
																	{selectedFailure()?.message ??
																		"No result was recorded for this view."}
																</small>
															</div>
															<div
																{...stylex.props(
																	styles.imageChrome
																)}
															>
																<span>Natural</span>
																<code>{run().id}</code>
															</div>
														</div>
													}
												>
													{(pure) => (
														<Show when={comparisonMode() !== "clear"}>
															<div
																{...stylex.props(styles.imageFrame)}
															>
																<ArtifactImage
																	artifact={pure()}
																	alt={`Natural capture of ${selectedCapture()?.viewName ?? "Review view"}`}
																/>
																<div
																	{...stylex.props(
																		styles.imageChrome
																	)}
																>
																	<span>Natural</span>
																	<code>{run().id}</code>
																</div>
															</div>
														</Show>
													)}
												</Show>
												<Show
													when={
														comparisonMode() === "clear" ||
														comparisonMode() === "side_by_side"
															? clearArtifact()
															: undefined
													}
												>
													{(clear) => (
														<div
															{...stylex.props(
																styles.imageFrame,
																styles.clearFrame
															)}
														>
															<ArtifactImage
																artifact={clear()}
																alt={`Clear capture with modified visibility of ${selectedCapture()?.viewName ?? "Review view"}`}
															/>
															<div
																{...stylex.props(
																	styles.imageChrome,
																	styles.clearChrome
																)}
															>
																<span>
																	Clear · visibility modified
																</span>
																<code>matched framing</code>
															</div>
														</div>
													)}
												</Show>
												<Show
													when={
														comparisonMode() === "previous"
															? previousEvidence()
															: undefined
													}
												>
													{(previous) => (
														<div {...stylex.props(styles.imageFrame)}>
															<ArtifactImage
																artifact={previous().artifact}
																alt={`Previous run capture of ${previous().capture.viewName}`}
															/>
															<div
																{...stylex.props(
																	styles.imageChrome
																)}
															>
																<span>Previous run</span>
																<code>{previous().run.id}</code>
															</div>
														</div>
													)}
												</Show>
											</div>
										</div>
										<aside {...stylex.props(styles.runInspector)}>
											<p {...stylex.props(styles.inspectorLabel)}>Run</p>
											<h2>{new Date(run().completedAt).toLocaleString()}</h2>
											<dl>
												<Show when={selectedCapture()}>
													{(capture) => (
														<>
															<div>
																<dt>Trigger</dt>
																<dd>
																	{capture().cause.type.replaceAll(
																		"_",
																		" "
																	)}
																</dd>
															</div>
															<div>
																<dt>Visibility</dt>
																<dd>
																	{visibilitySummary(
																		capture().visibility
																	)}
																</dd>
															</div>
															<div>
																<dt>Clear</dt>
																<dd>
																	{clearSummary(
																		capture().clearCompanion
																	)}
																</dd>
															</div>
															<Show
																when={
																	capture().clearCompanion
																		.status !== "not_requested"
																}
															>
																<div>
																	<dt>Restoration</dt>
																	<dd>
																		{restorationSummary(
																			capture().clearCompanion
																		)}
																	</dd>
																</div>
															</Show>
															<Show
																when={
																	selectedCapture()?.viewRevision
																}
															>
																{(revision) => (
																	<div>
																		<dt>Revision</dt>
																		<dd>
																			{revisionSummary(
																				revision(),
																				selectedView()
																					?.revision?.id
																			)}
																		</dd>
																	</div>
																)}
															</Show>
															<Show
																when={
																	captureExplanations(capture())
																		.length > 0
																}
															>
																<details
																	{...stylex.props(styles.notes)}
																>
																	<summary>Notes</summary>
																	<ul>
																		<For
																			each={captureExplanations(
																				capture()
																			)}
																		>
																			{(explanation) => (
																				<li>
																					{explanation}
																				</li>
																			)}
																		</For>
																	</ul>
																</details>
															</Show>
														</>
													)}
												</Show>
												<div>
													<dt>Result</dt>
													<dd>{run().status.replaceAll("_", " ")}</dd>
												</div>
												<div>
													<dt>Captured</dt>
													<dd>{run().successfulViews}</dd>
												</div>
												<div>
													<dt>Failed</dt>
													<dd>{run().failedViews}</dd>
												</div>
												<Show when={run().preview}>
													{(preview) => (
														<div>
															<dt>Frame</dt>
															<dd>
																{preview().width} ×{" "}
																{preview().height}
															</dd>
														</div>
													)}
												</Show>
											</dl>
										</aside>
									</section>
								)}
							</Show>

							<section aria-label="Runs" {...stylex.props(styles.history)}>
								<div {...stylex.props(styles.sectionHeading)}>
									<span>Runs</span>
									<small>Newest first</small>
								</div>
								<div {...stylex.props(styles.runRail)}>
									<For each={current().runs}>
										{(run, index) => (
											<button
												type="button"
												aria-pressed={selected()?.id === run.id}
												onClick={() => {
													setSelectedRunId(run.id);
													setComparisonMode("pure");
												}}
												{...stylex.props(
													styles.runCard,
													selected()?.id === run.id &&
														styles.runCardActive
												)}
											>
												<span>
													{String(
														current().runs.length - index()
													).padStart(2, "0")}
												</span>
												<strong>
													{new Date(run.completedAt).toLocaleTimeString()}
												</strong>
												<small>{run.status.replaceAll("_", " ")}</small>
												<small>
													{capturesForRun(run).some(
														(capture) =>
															capture.viewId === selectedViewId()
													)
														? "captured"
														: run.failures?.some(
																	(failure) =>
																		failure.viewId ===
																		selectedViewId()
															  )
															? "view failed"
															: "not in run"}
												</small>
											</button>
										)}
									</For>
								</div>
							</section>
						</div>
					)}
				</Match>
			</Switch>
		</main>
	);
}

const styles = stylex.create({
	page: {
		minHeight: "calc(100vh - 52px)",
		width: "100%",
		boxSizing: "border-box",
		overflowX: "hidden",
		padding: tokens.space5,
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "flex-start",
		gap: tokens.space4,
		paddingBottom: tokens.space4,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		marginBottom: tokens.space5
	},
	headerCopy: { display: "flex", flexDirection: "column", gap: 6 },
	title: {
		margin: 0,
		fontSize: 22,
		fontWeight: 590,
		letterSpacing: "-0.02em",
		color: tokens.colorTextStrong
	},
	subtitle: {
		margin: 0,
		maxWidth: 560,
		fontSize: 14,
		lineHeight: 1.45,
		color: tokens.colorTextMuted
	},
	headerActions: { display: "flex", alignItems: "center", gap: tokens.space2 },
	toolbar: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: tokens.space3,
		marginBottom: tokens.space4
	},
	sourceTabs: { display: "flex", gap: 4 },
	sourceTab: {
		borderColor: "transparent",
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: "transparent",
			":hover": tokens.colorSurfaceHover,
			":disabled": "transparent"
		},
		color: {
			default: tokens.colorTextMuted,
			":active": tokens.colorTextStrong,
			":disabled": tokens.colorTextFaint
		},
		padding: "5px 10px",
		fontSize: 13,
		fontWeight: 500,
		cursor: { default: "pointer", ":disabled": "not-allowed" }
	},
	sourceTabActive: {
		backgroundColor: tokens.colorSurfaceRaised,
		borderColor: tokens.colorBorder,
		color: tokens.colorTextStrong
	},
	modeGroup: { display: "flex", gap: 4 },
	modeButton: {
		borderColor: "transparent",
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: "transparent",
			":hover": tokens.colorSurfaceHover,
			":disabled": "transparent"
		},
		color: { default: tokens.colorTextMuted, ":disabled": tokens.colorTextFaint },
		padding: "5px 10px",
		fontSize: 13,
		fontWeight: 500,
		cursor: { default: "pointer", ":disabled": "not-allowed" }
	},
	modeButtonActive: {
		backgroundColor: tokens.colorSurfaceRaised,
		borderColor: tokens.colorBorder,
		color: tokens.colorTextStrong
	},
	centerState: {
		minHeight: 430,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		alignItems: "center",
		gap: 10,
		textAlign: "center",
		color: tokens.colorTextMuted
	},
	stateCard: {
		width: "min(560px, 100%)",
		margin: "0 auto",
		marginTop: tokens.space6,
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: tokens.space3,
		padding: tokens.space5,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextMuted
	},
	stateTitle: {
		color: tokens.colorTextStrong,
		fontSize: 15,
		fontWeight: 600
	},
	technical: {
		alignSelf: "stretch",
		marginTop: tokens.space2,
		color: tokens.colorTextSubtle,
		fontSize: 12
	},
	setupWorkspace: { paddingTop: tokens.space3 },
	offlineNote: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextMuted,
		padding: `${tokens.space3}px ${tokens.space4}px`,
		fontSize: 13
	},
	workspace: { paddingTop: 0, display: "grid", gap: tokens.space4 },
	statusStrip: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 2fr) minmax(90px, .5fr) minmax(90px, .5fr)",
		gap: tokens.space3,
		padding: `${tokens.space3}px ${tokens.space4}px`,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface
	},
	setIdentity: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		gap: 4
	},
	stat: {
		display: "flex",
		alignItems: "baseline",
		justifyContent: "flex-end",
		gap: 6
	},
	stage: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) 260px",
		gap: tokens.space3
	},
	comparisonControls: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: tokens.space2 },
	comparisonButton: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: "transparent",
			":hover": tokens.colorSurfaceHover,
			":disabled": "transparent"
		},
		color: { default: tokens.colorTextMuted, ":disabled": tokens.colorTextFaint },
		padding: "4px 10px",
		fontSize: 12,
		fontWeight: 500,
		cursor: { default: "pointer", ":disabled": "default" }
	},
	comparisonButtonActive: {
		borderColor: tokens.colorBorder,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextStrong
	},
	comparisonStage: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: tokens.space2 },
	comparisonStagePaired: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
	imageFrame: {
		minHeight: 380,
		position: "relative",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		overflow: "hidden"
	},
	previewImage: {
		width: "100%",
		height: "100%",
		maxHeight: "65vh",
		objectFit: "contain",
		display: "block"
	},
	missingPreview: {
		minHeight: 380,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 8,
		textAlign: "center",
		padding: tokens.space4,
		color: tokens.colorTextSubtle
	},
	imageChrome: {
		position: "absolute",
		left: 0,
		right: 0,
		bottom: 0,
		display: "flex",
		justifyContent: "space-between",
		padding: `${tokens.space3}px ${tokens.space4}px`,
		backgroundImage: "linear-gradient(transparent, rgba(8, 9, 10, 0.91))",
		color: tokens.colorText,
		fontSize: 11
	},
	clearFrame: { borderColor: "#02b8cc" },
	clearChrome: { color: "#02b8cc" },
	notes: { margin: `${tokens.space2}px 0`, color: tokens.colorTextMuted, fontSize: 11 },
	runInspector: {
		alignSelf: "start",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		padding: tokens.space4
	},
	inspectorLabel: {
		margin: 0,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		fontWeight: 600
	},
	emptyState: {
		borderColor: tokens.colorBorder,
		borderStyle: "dashed",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		padding: tokens.space5,
		color: tokens.colorTextMuted,
		fontSize: 13,
		textAlign: "center"
	},
	viewNavigator: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	sectionHeading: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "baseline",
		padding: `${tokens.space2}px ${tokens.space4}px`,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorTextStrong,
		fontSize: 12,
		fontWeight: 600
	},
	subjectGroup: {
		display: "grid",
		gridTemplateColumns: "minmax(180px, .55fr) 1.45fr",
		gap: tokens.space3,
		padding: tokens.space3,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	subjectIdentity: { display: "grid", alignContent: "start", gap: 4 },
	subjectCount: {
		width: "fit-content",
		padding: "1px 6px",
		borderRadius: tokens.radiusBadge,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	viewRail: { display: "flex", gap: tokens.space2, overflowX: "auto" },
	viewCard: {
		minWidth: 170,
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: 4,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: tokens.colorSurfaceInset, ":hover": tokens.colorSurfaceHover },
		color: tokens.colorTextMuted,
		padding: tokens.space2,
		textAlign: "left",
		cursor: "pointer"
	},
	viewCardActive: {
		borderColor: tokens.colorAccent,
		boxShadow: `inset 0 -2px ${tokens.colorAccent}`,
		color: tokens.colorTextStrong
	},
	history: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	runRail: { display: "flex", minHeight: 80, overflowX: "auto" },
	runCard: {
		minWidth: 170,
		display: "grid",
		gridTemplateColumns: "28px 1fr",
		alignItems: "center",
		borderStyle: "none",
		borderWidth: 0,
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorTextMuted,
		textAlign: "left",
		cursor: "pointer",
		padding: tokens.space3
	},
	runCardActive: {
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: `inset 0 -2px ${tokens.colorAccent}`,
		color: tokens.colorTextStrong
	}
});
