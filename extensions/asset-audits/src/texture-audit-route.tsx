import * as stylex from "@stylexjs/stylex";
import { Button, createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import {
	filterTextureReport,
	type DistributionSelection,
	type TextureAuditReport,
	type TextureAuditRunResult,
	type TexturePreviewResult,
	type TextureRecord
} from "@ue-shed/asset-audits/browser";
import { Cause } from "effect";
import { For, Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js";

type ViewState =
	| { readonly status: "loading" }
	| { readonly status: "not_configured" }
	| { readonly status: "cancelled" }
	| {
			readonly status: "failed";
			readonly result: Extract<TextureAuditRunResult, { status: "failed" }>;
	  }
	| { readonly status: "ready"; readonly report: TextureAuditReport };

type PreviewState =
	| { readonly status: "idle" }
	| { readonly status: "loading" }
	| {
			readonly status: "available";
			readonly preview: TexturePreviewResult & { status: "available" };
	  }
	| {
			readonly status: "unavailable";
			readonly preview: TexturePreviewResult & { status: "unavailable" };
	  };

/** Retained only for compatibility with tests of the pre-query presentation model. */
export interface LegacyTextureAuditClientApi {
	readonly chooseProjectAndScan: () => import("effect").Effect.Effect<
		TextureAuditRunResult,
		unknown
	>;
	readonly launchUnreal: () => import("effect").Effect.Effect<
		| { readonly status: "ready" }
		| { readonly status: "failed"; readonly message: string; readonly recovery: string },
		unknown
	>;
	readonly loadConfiguredProject: () => import("effect").Effect.Effect<
		TextureAuditRunResult,
		unknown
	>;
	readonly loadPreview: (
		objectPath: string
	) => import("effect").Effect.Effect<TexturePreviewResult, unknown>;
}

function shortName(objectPath: string): string {
	return objectPath.slice(objectPath.lastIndexOf("/") + 1).split(".")[0] ?? objectPath;
}

function severityLabel(severity: "warning" | "error"): string {
	return severity === "error" ? "Fail" : "Warning";
}

type DisplayEvidence = TextureRecord["compression"] | TextureRecord["sRGB"];

function evidenceLabel(evidence: DisplayEvidence): string {
	return evidence.status === "available" ? String(evidence.value) : "Unavailable";
}

function EvidenceRow(props: { readonly label: string; readonly evidence: DisplayEvidence }) {
	return (
		<div {...stylex.props(styles.evidenceRow)}>
			<span {...stylex.props(styles.evidenceLabel)}>{props.label}</span>
			<span {...stylex.props(styles.evidenceValue)}>{evidenceLabel(props.evidence)}</span>
			<span {...stylex.props(styles.evidenceSource)}>
				{props.evidence.status === "available"
					? props.evidence.source
					: props.evidence.reason.replaceAll("_", " ")}
			</span>
		</div>
	);
}

function DimensionsHero(props: { readonly dimensions: TextureRecord["dimensions"] }) {
	if (props.dimensions.status !== "available") return <>Dimensions unavailable</>;
	return (
		<>
			<strong>{props.dimensions.value.width}</strong>
			<span>×</span>
			<strong>{props.dimensions.value.height}</strong>
			<small>source pixels</small>
		</>
	);
}

function Distribution(props: {
	readonly title: string;
	readonly kind: DistributionSelection["kind"];
	readonly buckets: TextureAuditReport["distributions"]["compression"];
	readonly active: DistributionSelection | undefined;
	readonly onSelect: (selection: DistributionSelection) => void;
}) {
	const maximum = () => Math.max(1, ...props.buckets.map((bucket) => bucket.count));
	return (
		<section {...stylex.props(styles.distribution)} aria-label={`${props.title} facets`}>
			<div {...stylex.props(styles.panelHeading)}>
				<span>{props.title}</span>
			</div>
			<div {...stylex.props(styles.bars)}>
				<For each={props.buckets}>
					{(bucket) => {
						const selected = () =>
							props.active?.kind === props.kind && props.active.key === bucket.key;
						return (
							<button
								type="button"
								aria-pressed={selected()}
								onClick={() =>
									props.onSelect({ kind: props.kind, key: bucket.key })
								}
								{...stylex.props(styles.barRow, selected() && styles.barRowActive)}
							>
								<span {...stylex.props(styles.barLabel)}>{bucket.label}</span>
								<span {...stylex.props(styles.barTrack)}>
									<span
										{...stylex.props(styles.barFill)}
										style={{
											width: `${Math.max(5, (bucket.count / maximum()) * 100)}%`
										}}
									/>
								</span>
								<strong {...stylex.props(styles.countMono)}>
									{String(bucket.count).padStart(2, "0")}
								</strong>
							</button>
						);
					}}
				</For>
			</div>
		</section>
	);
}

export function LegacyTextureAuditRoute(props: { readonly client: LegacyTextureAuditClientApi }) {
	const scanAction = createEffectAction();
	const previewAction = createEffectAction();
	const launchAction = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [selection, setSelection] = createSignal<DistributionSelection>();
	const [selectedPath, setSelectedPath] = createSignal<string>();
	const [query, setQuery] = createSignal("");
	const [findingsOnly, setFindingsOnly] = createSignal(false);
	const [preview, setPreview] = createSignal<PreviewState>({ status: "idle" });
	const [launching, setLaunching] = createSignal(false);
	const [launchFailure, setLaunchFailure] = createSignal<string>();
	const loadPreview = (objectPath: string) => {
		setPreview({ status: "loading" });
		previewAction.run(props.client.loadPreview(objectPath), {
			onFailure: (cause) => {
				setPreview({ status: "idle" });
				setLaunchFailure(Cause.pretty(cause));
			},
			onSuccess: (result) =>
				setPreview(
					result.status === "available"
						? { status: "available", preview: result }
						: { status: "unavailable", preview: result }
				)
		});
	};

	const selectRecord = (record: TextureRecord) => {
		setSelectedPath(record.objectPath);
		setLaunchFailure();
		loadPreview(record.objectPath);
	};

	const launchUnreal = () => {
		setLaunching(true);
		setLaunchFailure();
		launchAction.run(props.client.launchUnreal(), {
			onFailure: (cause) => {
				setLaunching(false);
				setLaunchFailure(Cause.pretty(cause));
			},
			onSuccess: (result) => {
				setLaunching(false);
				if (result.status === "failed") {
					setLaunchFailure(`${result.message} ${result.recovery}`);
					return;
				}
				const objectPath = selectedPath();
				if (objectPath) loadPreview(objectPath);
			}
		});
	};

	const applyResult = (result: TextureAuditRunResult) => {
		if (result.status === "completed") {
			setState({ status: "ready", report: result.report });
			const first = result.report.records[0];
			if (first) selectRecord(first);
		} else if (result.status === "failed") setState({ status: "failed", result });
		else setState({ status: result.status });
	};
	const run = () => {
		setState({ status: "loading" });
		setPreview({ status: "idle" });
		scanAction.run(props.client.loadConfiguredProject(), {
			onFailure: (cause) =>
				applyResult({
					error: {
						code: "contract_failure",
						message: Cause.pretty(cause),
						recovery:
							"Restart Workbench. If the problem persists, verify package versions.",
						retrySafe: true
					},
					status: "failed"
				}),
			onSuccess: applyResult
		});
	};
	onMount(run);

	return (
		<main {...stylex.props(styles.page)}>
			<header {...stylex.props(styles.header)}>
				<div {...stylex.props(styles.heading)}>
					<h1 {...stylex.props(styles.title)}>Texture audit</h1>
					<p {...stylex.props(styles.intro)}>
						Check saved textures against your size, group, and compression rules.
					</p>
				</div>
				<Button type="button" onClick={run} tone="primary">
					Rescan assets
				</Button>
			</header>

			<Switch>
				<Match when={state().status === "loading"}>
					<div {...stylex.props(styles.centerState)}>
						<span aria-hidden="true" {...stylex.props(styles.spinnerDot)} />
						Running the texture audit…
					</div>
				</Match>
				<Match when={state().status === "not_configured"}>
					<div {...stylex.props(styles.noticeCard)}>
						<strong>No project configured.</strong> Choose a project from the Workbench
						header, then select Retry.
					</div>
				</Match>
				<Match when={state().status === "cancelled"}>
					<div {...stylex.props(styles.noticeCard)}>
						Project selection was cancelled. No scan was started.
					</div>
				</Match>
				<Match when={state().status === "failed"}>
					{(() => {
						const current = state();
						if (current.status !== "failed") return null;
						return (
							<section role="alert" {...stylex.props(styles.failureCard)}>
								<strong {...stylex.props(styles.failureTitle)}>
									Couldn&apos;t run the audit
								</strong>
								<span {...stylex.props(styles.failureRecovery)}>
									{current.result.error.recovery}
								</span>
								<Button type="button" onClick={run} tone="secondary">
									Retry
								</Button>
								<details {...stylex.props(styles.technicalDetails)}>
									<summary {...stylex.props(styles.technicalSummary)}>
										Technical details
									</summary>
									<code {...stylex.props(styles.technicalCode)}>
										{current.result.error.message}
									</code>
								</details>
							</section>
						);
					})()}
				</Match>
				<Match when={state().status === "ready"}>
					{(() => {
						const current = state();
						if (current.status !== "ready") return null;
						const report = current.report;
						const findingPaths = new Set(
							report.findings.map((finding) => finding.objectPath)
						);
						const visible = createMemo(() =>
							filterTextureReport(report, selection()).filter((record) => {
								const matchesQuery = record.objectPath
									.toLowerCase()
									.includes(query().toLowerCase());
								return (
									matchesQuery &&
									(!findingsOnly() || findingPaths.has(record.objectPath))
								);
							})
						);
						const selected = createMemo(
							() =>
								report.records.find(
									(record) => record.objectPath === selectedPath()
								) ?? visible()[0]
						);
						return (
							<div {...stylex.props(styles.workspace)}>
								<section
									{...stylex.props(styles.coverage)}
									aria-label="Scan coverage"
								>
									<div
										{...stylex.props(
											styles.coverageStatus,
											report.status === "partial" && styles.coveragePartial
										)}
									>
										<strong>{report.ruleSetName}</strong>
										<span>
											{report.status === "complete" ? "Complete" : "Partial"}
										</span>
									</div>
									<For
										each={
											[
												["Discovered", report.coverage.discoveredPackages],
												["Inspected", report.coverage.inspectedPackages],
												["Textures", report.coverage.textureAssets],
												[
													"Skipped",
													report.coverage.partialPackages +
														report.coverage.failedPackages
												]
											] as const
										}
									>
										{([label, value]) => (
											<div {...stylex.props(styles.coverageItem)}>
												<strong {...stylex.props(styles.countMono)}>
													{String(value).padStart(2, "0")}
												</strong>
												<span>{label}</span>
											</div>
										)}
									</For>
									<div {...stylex.props(styles.findingCount)}>
										<strong {...stylex.props(styles.countMono)}>
											{report.findings.length}
										</strong>
										<span>Findings</span>
									</div>
								</section>

								<div {...stylex.props(styles.distributionGrid)}>
									<Distribution
										title="Maximum dimension"
										kind="maximumDimension"
										buckets={report.distributions.maximumDimension}
										active={selection()}
										onSelect={(next) =>
											setSelection(
												selection()?.kind === next.kind &&
													selection()?.key === next.key
													? undefined
													: next
											)
										}
									/>
									<Distribution
										title="Texture group"
										kind="textureGroup"
										buckets={report.distributions.textureGroup}
										active={selection()}
										onSelect={(next) => setSelection(next)}
									/>
									<Distribution
										title="Compression"
										kind="compression"
										buckets={report.distributions.compression}
										active={selection()}
										onSelect={(next) => setSelection(next)}
									/>
									<Distribution
										title="Color space"
										kind="sRGB"
										buckets={report.distributions.sRGB}
										active={selection()}
										onSelect={(next) => setSelection(next)}
									/>
								</div>

								<div {...stylex.props(styles.lowerGrid)}>
									<section {...stylex.props(styles.sheet)}>
										<div {...stylex.props(styles.sheetTools)}>
											<input
												aria-label="Search textures"
												value={query()}
												onInput={(event) =>
													setQuery(event.currentTarget.value)
												}
												placeholder="Filter object paths…"
												{...stylex.props(styles.search)}
											/>
											<label {...stylex.props(styles.toggle)}>
												<input
													type="checkbox"
													checked={findingsOnly()}
													onChange={(event) =>
														setFindingsOnly(event.currentTarget.checked)
													}
												/>{" "}
												Findings only
											</label>
											<Show when={selection()}>
												<button
													type="button"
													onClick={() => setSelection()}
													{...stylex.props(styles.clearButton)}
												>
													Clear distribution filter
												</button>
											</Show>
										</div>
										<div {...stylex.props(styles.tableHeader)}>
											<span>Asset</span>
											<span>Dimensions</span>
											<span>Group</span>
											<span>Status</span>
										</div>
										<Show
											when={visible().length > 0}
											fallback={
												<div {...stylex.props(styles.noRows)}>
													No textures match this view.
												</div>
											}
										>
											<For each={visible()}>
												{(record) => {
													const finding = report.findings.find(
														(item) =>
															item.objectPath === record.objectPath
													);
													return (
														<button
															type="button"
															onClick={() => selectRecord(record)}
															{...stylex.props(
																styles.tableRow,
																selected()?.objectPath ===
																	record.objectPath &&
																	styles.tableRowSelected
															)}
														>
															<span
																{...stylex.props(styles.objectCell)}
															>
																<strong
																	{...stylex.props(
																		styles.objectName
																	)}
																>
																	{shortName(record.objectPath)}
																</strong>
																<small
																	{...stylex.props(
																		styles.filePath
																	)}
																>
																	{record.filePath}
																</small>
															</span>
															<span>
																{record.dimensions.status ===
																"available"
																	? `${record.dimensions.value.width} × ${record.dimensions.value.height}`
																	: "—"}
															</span>
															<span>
																{evidenceLabel(record.textureGroup)}
															</span>
															<span
																{...stylex.props(
																	styles.rowStatus,
																	finding && styles.warningText
																)}
															>
																{finding
																	? severityLabel(
																			finding.severity
																		)
																	: "Pass"}
															</span>
														</button>
													);
												}}
											</For>
										</Show>
									</section>

									<aside {...stylex.props(styles.inspector)}>
										<Show
											when={selected()}
											fallback={
												<div {...stylex.props(styles.noRows)}>
													Select a texture to inspect its properties.
												</div>
											}
										>
											{(record) => (
												<>
													<h2 {...stylex.props(styles.inspectorTitle)}>
														{shortName(record().objectPath)}
													</h2>
													<code
														title={record().objectPath}
														{...stylex.props(styles.objectPath)}
													>
														{record().objectPath}
													</code>
													<div {...stylex.props(styles.previewFrame)}>
														<Switch>
															<Match
																when={
																	preview().status === "loading"
																}
															>
																<div
																	{...stylex.props(
																		styles.previewEmpty
																	)}
																>
																	<span
																		aria-hidden="true"
																		{...stylex.props(
																			styles.spinnerDot
																		)}
																	/>
																	Decoding preview…
																</div>
															</Match>
															<Match
																when={
																	preview().status === "available"
																}
															>
																{(() => {
																	const current = preview();
																	if (
																		current.status !==
																		"available"
																	)
																		return null;
																	return (
																		<>
																			<img
																				src={`data:${current.preview.mimeType};base64,${current.preview.dataBase64}`}
																				alt={`Live preview of ${shortName(current.preview.objectPath)}`}
																				{...stylex.props(
																					styles.previewImage
																				)}
																			/>
																			<span
																				{...stylex.props(
																					styles.previewBadge
																				)}
																			>
																				Live editor ·{" "}
																				{
																					current.preview
																						.width
																				}{" "}
																				×{" "}
																				{
																					current.preview
																						.height
																				}
																			</span>
																		</>
																	);
																})()}
															</Match>
															<Match
																when={
																	preview().status ===
																	"unavailable"
																}
															>
																<div
																	{...stylex.props(
																		styles.previewEmpty
																	)}
																>
																	<strong>
																		No live preview.
																	</strong>
																	<span>
																		{(() => {
																			const current =
																				preview();
																			return current.status ===
																				"unavailable"
																				? current.preview
																						.message
																				: "Unreal is not connected.";
																		})()}
																	</span>
																	<button
																		type="button"
																		disabled={launching()}
																		onClick={() =>
																			void launchUnreal()
																		}
																		{...stylex.props(
																			styles.launchButton
																		)}
																	>
																		{launching()
																			? "Launching…"
																			: "Launch Unreal"}
																	</button>
																	<Show when={launchFailure()}>
																		<details
																			{...stylex.props(
																				styles.technicalDetails
																			)}
																		>
																			<summary
																				{...stylex.props(
																					styles.technicalSummary
																				)}
																			>
																				Technical details
																			</summary>
																			<code
																				{...stylex.props(
																					styles.technicalCode
																				)}
																			>
																				{launchFailure()}
																			</code>
																		</details>
																	</Show>
																</div>
															</Match>
														</Switch>
													</div>
													<div {...stylex.props(styles.dimensionHero)}>
														<DimensionsHero
															dimensions={record().dimensions}
														/>
													</div>
													<div {...stylex.props(styles.evidenceList)}>
														<EvidenceRow
															label="Format"
															evidence={record().sourceFormat}
														/>
														<EvidenceRow
															label="Texture group"
															evidence={record().textureGroup}
														/>
														<EvidenceRow
															label="Compression"
															evidence={record().compression}
														/>
														<EvidenceRow
															label="sRGB"
															evidence={record().sRGB}
														/>
														<EvidenceRow
															label="Mip generation"
															evidence={record().mipGeneration}
														/>
													</div>
													<For
														each={report.findings.filter(
															(finding) =>
																finding.objectPath ===
																record().objectPath
														)}
													>
														{(finding) => (
															<div
																{...stylex.props(
																	styles.findingCard
																)}
															>
																<span
																	{...stylex.props(
																		styles.findingSeverity
																	)}
																>
																	{severityLabel(
																		finding.severity
																	)}{" "}
																	· {finding.ruleId}
																</span>
																<strong>
																	{finding.explanation}
																</strong>
																<For each={finding.actual}>
																	{(item) => (
																		<small>
																			{item.label}:{" "}
																			{item.value}
																		</small>
																	)}
																</For>
															</div>
														)}
													</For>
												</>
											)}
										</Show>
									</aside>
								</div>
								<Show when={report.diagnostics.length > 0}>
									<div {...stylex.props(styles.diagnostics)}>
										{report.diagnostics.length}{" "}
										{report.diagnostics.length === 1 ? "package" : "packages"}{" "}
										skipped · coverage is partial
									</div>
								</Show>
							</div>
						);
					})()}
				</Match>
			</Switch>
		</main>
	);
}

const styles = stylex.create({
	page: {
		minHeight: "100vh",
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText,
		padding: `${tokens.space5} ${tokens.space6} ${tokens.space6}`,
		fontFamily: tokens.fontBody
	},
	header: {
		display: "flex",
		alignItems: "flex-start",
		justifyContent: "space-between",
		gap: tokens.space5,
		paddingBottom: tokens.space4,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		marginBottom: tokens.space5
	},
	heading: { minWidth: 0 },
	title: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontSize: 22,
		fontWeight: 590,
		letterSpacing: "-0.02em"
	},
	intro: {
		maxWidth: 560,
		margin: "6px 0 0",
		color: tokens.colorTextMuted,
		fontSize: 14,
		lineHeight: 1.45
	},
	centerState: {
		minHeight: 430,
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		gap: tokens.space2,
		color: tokens.colorTextMuted,
		fontSize: 13
	},
	spinnerDot: {
		width: 8,
		height: 8,
		borderRadius: "50%",
		backgroundColor: tokens.colorAccent
	},
	noticeCard: {
		display: "grid",
		placeItems: "center",
		minHeight: 430,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "dashed",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextMuted
	},
	failureCard: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: tokens.space2,
		maxWidth: 560,
		margin: `${tokens.space6} auto 0`,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		padding: tokens.space5
	},
	failureTitle: {
		color: tokens.colorTextStrong,
		fontSize: 15,
		fontWeight: 600
	},
	failureRecovery: {
		color: tokens.colorTextMuted,
		fontSize: 13,
		lineHeight: 1.45
	},
	technicalDetails: {
		width: "100%",
		marginTop: tokens.space1
	},
	technicalSummary: {
		color: tokens.colorTextFaint,
		cursor: "pointer",
		fontSize: 12
	},
	technicalCode: {
		display: "block",
		overflow: "auto",
		marginTop: tokens.space2,
		padding: tokens.space2,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusBadge,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		lineHeight: 1.45,
		whiteSpace: "pre-wrap"
	},
	countMono: {
		fontFamily: tokens.fontMono,
		fontWeight: 400
	},
	workspace: { display: "flex", flexDirection: "column", gap: tokens.space4 },
	coverage: {
		display: "grid",
		gridTemplateColumns: "1.8fr repeat(4, 1fr) 1fr",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	coverageStatus: {
		padding: "12px 16px",
		borderLeftColor: tokens.colorSuccess,
		borderLeftStyle: "solid",
		borderLeftWidth: 3,
		display: "flex",
		flexDirection: "column-reverse",
		gap: tokens.space1
	},
	coveragePartial: { borderLeftColor: tokens.colorWarning },
	coverageItem: {
		padding: "11px 14px",
		borderLeftColor: tokens.colorBorder,
		borderLeftStyle: "solid",
		borderLeftWidth: 1,
		display: "flex",
		flexDirection: "column",
		gap: 3
	},
	findingCount: {
		padding: "11px 14px",
		backgroundColor: "rgba(242, 153, 74, 0.12)",
		color: tokens.colorWarning,
		display: "flex",
		flexDirection: "column"
	},
	distributionGrid: {
		display: "grid",
		gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
		gap: tokens.space2
	},
	distribution: {
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		minHeight: 164,
		overflow: "hidden"
	},
	panelHeading: {
		padding: "10px 12px",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		justifyContent: "space-between",
		fontSize: 11,
		textTransform: "none",
		letterSpacing: 0
	},
	bars: { padding: "8px 10px" },
	barRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "minmax(82px, 1.1fr) 1fr 24px",
		alignItems: "center",
		gap: 8,
		color: tokens.colorText,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		borderStyle: "none",
		borderWidth: 0,
		padding: "5px 3px",
		textAlign: "left",
		cursor: "pointer",
		fontSize: 12
	},
	barRowActive: { color: tokens.colorWarning, backgroundColor: "rgba(255, 255, 255, 0.07)" },
	barLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
	barTrack: { height: 4, backgroundColor: tokens.colorSurfaceInset, display: "block" },
	barFill: { height: "100%", display: "block", backgroundColor: tokens.colorTextSubtle },
	lowerGrid: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) 330px",
		gap: tokens.space2,
		minHeight: 350
	},
	sheet: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	sheetTools: {
		display: "flex",
		gap: 10,
		padding: 10,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		alignItems: "center"
	},
	search: {
		minWidth: 260,
		flexGrow: 1,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		padding: "8px 10px",
		outlineColor: tokens.colorTextSubtle
	},
	toggle: {
		fontSize: 12,
		color: tokens.colorTextMuted,
		display: "flex",
		gap: 6,
		borderRadius: tokens.radiusBadge,
		whiteSpace: "nowrap"
	},
	clearButton: {
		fontSize: 12,
		borderStyle: "none",
		borderWidth: 0,
		backgroundColor: "transparent",
		color: tokens.colorWarning,
		cursor: "pointer"
	},
	tableHeader: {
		display: "grid",
		gridTemplateColumns: "2fr 0.75fr 1fr 1.1fr",
		padding: "8px 12px",
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: 0,
		textTransform: "none"
	},
	tableRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "2fr 0.75fr 1fr 1.1fr",
		alignItems: "center",
		padding: "10px 12px",
		borderStyle: "none",
		borderWidth: 0,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorText,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" },
		textAlign: "left",
		cursor: "pointer",
		fontSize: 13
	},
	tableRowSelected: {
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		boxShadow: `inset 2px 0 ${tokens.colorAccent}`
	},
	objectCell: { minWidth: 0, display: "flex", flexDirection: "column", gap: 3 },
	objectName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
	filePath: {
		color: tokens.colorTextFaint,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		fontSize: 11
	},
	warningText: { color: tokens.colorWarning },
	noRows: { padding: 30, color: tokens.colorTextMuted, textAlign: "center" },
	inspector: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		padding: tokens.space4,
		overflow: "hidden"
	},
	inspectorTitle: {
		fontFamily: tokens.fontDisplay,
		fontWeight: 590,
		fontSize: 17,
		margin: "0 0 4px",
		overflowWrap: "anywhere"
	},
	previewFrame: {
		position: "relative",
		minHeight: 188,
		margin: "16px 0 12px",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurfaceInset,
		overflow: "hidden",
		display: "grid",
		placeItems: "center"
	},
	previewImage: {
		display: "block",
		width: "100%",
		height: 220,
		objectFit: "contain",
		imageRendering: "auto"
	},
	previewBadge: {
		position: "absolute",
		left: 8,
		bottom: 8,
		padding: "5px 7px",
		backgroundColor: "rgba(8, 9, 10, 0.85)",
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 11,
		letterSpacing: 0
	},
	previewEmpty: {
		padding: 20,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		textAlign: "center",
		gap: 9,
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	launchButton: {
		marginTop: 4,
		padding: "9px 12px",
		borderColor: tokens.colorAccent,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: tokens.colorAccent, ":hover": tokens.colorAccentStrong },
		color: tokens.colorAccentText,
		fontWeight: 500,
		cursor: "pointer",
		transition: "transform 140ms cubic-bezier(0.23, 1, 0.32, 1)",
		transform: { default: "scale(1)", ":active": "scale(0.97)" }
	},
	objectPath: {
		display: "block",
		overflow: "hidden",
		color: tokens.colorTextSubtle,
		fontSize: 11,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		margin: 0
	},
	rowStatus: {
		color: tokens.colorSuccess,
		fontSize: 12
	},
	dimensionHero: {
		margin: "19px 0",
		padding: "15px 0",
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		alignItems: "baseline",
		gap: 8,
		color: tokens.colorTextStrong,
		fontSize: 13
	},
	evidenceList: { display: "flex", flexDirection: "column" },
	evidenceRow: {
		display: "grid",
		gridTemplateColumns: "1fr 1.2fr 0.8fr",
		padding: "7px 0",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		fontSize: 12
	},
	evidenceLabel: { color: tokens.colorTextSubtle },
	evidenceValue: { color: tokens.colorText, overflowWrap: "anywhere" },
	evidenceSource: { color: tokens.colorTextMuted, textAlign: "right" },
	findingCard: {
		marginTop: tokens.space3,
		padding: tokens.space3,
		borderColor: "rgba(242, 153, 74, 0.35)",
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusBadge,
		backgroundColor: "rgba(242, 153, 74, 0.1)",
		display: "flex",
		flexDirection: "column",
		gap: 5,
		color: tokens.colorWarning,
		fontSize: 12
	},
	findingSeverity: { fontSize: 11 },
	diagnostics: {
		padding: tokens.space2 + 2,
		color: tokens.colorTextMuted,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		fontSize: 12
	}
});
