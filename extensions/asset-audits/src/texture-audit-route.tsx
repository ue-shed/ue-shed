import * as stylex from "@stylexjs/stylex";
import {
	filterTextureReport,
	type DistributionSelection,
	type TextureAuditReport,
	type TextureAuditRunResult,
	type TextureRecord
} from "@ue-shed/asset-audits/browser";
import { For, Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js";

export interface TextureAuditClient {
	readonly loadConfiguredProject: () => Promise<TextureAuditRunResult>;
	readonly chooseProjectAndScan: () => Promise<TextureAuditRunResult>;
}

type ViewState =
	| { readonly status: "loading" }
	| { readonly status: "not_configured" }
	| { readonly status: "cancelled" }
	| {
			readonly status: "failed";
			readonly result: Extract<TextureAuditRunResult, { status: "failed" }>;
	  }
	| { readonly status: "ready"; readonly report: TextureAuditReport };

function shortName(objectPath: string): string {
	return objectPath.slice(objectPath.lastIndexOf("/") + 1).split(".")[0] ?? objectPath;
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
			<small>source pixels · serialized</small>
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
		<section {...stylex.props(styles.distribution)} aria-label={`${props.title} distribution`}>
			<div {...stylex.props(styles.panelHeading)}>
				<span>{props.title}</span>
				<span {...stylex.props(styles.panelMeta)}>CORPUS</span>
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
								<strong>{String(bucket.count).padStart(2, "0")}</strong>
							</button>
						);
					}}
				</For>
			</div>
		</section>
	);
}

export function TextureAuditRoute(props: { readonly client: TextureAuditClient }) {
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [selection, setSelection] = createSignal<DistributionSelection>();
	const [selectedPath, setSelectedPath] = createSignal<string>();
	const [query, setQuery] = createSignal("");
	const [findingsOnly, setFindingsOnly] = createSignal(false);

	const applyResult = (result: TextureAuditRunResult) => {
		if (result.status === "completed") setState({ status: "ready", report: result.report });
		else if (result.status === "failed") setState({ status: "failed", result });
		else setState({ status: result.status });
	};
	const run = async (choose: boolean) => {
		setState({ status: "loading" });
		applyResult(
			await (choose
				? props.client.chooseProjectAndScan()
				: props.client.loadConfiguredProject())
		);
	};
	onMount(() => void run(false));

	return (
		<main {...stylex.props(styles.page)}>
			<header {...stylex.props(styles.header)}>
				<div>
					<div {...stylex.props(styles.eyebrow)}>ASSET AUDITS / TEXTURE + IMPORT</div>
					<h1 {...stylex.props(styles.title)}>Texture evidence desk</h1>
					<p {...stylex.props(styles.subtitle)}>
						Serialized facts, corpus shape, and explicit rules. No editor required.
					</p>
				</div>
				<div {...stylex.props(styles.actions)}>
					<button
						type="button"
						onClick={() => void run(true)}
						{...stylex.props(styles.primaryButton)}
					>
						Choose project
					</button>
					<button
						type="button"
						onClick={() => void run(false)}
						{...stylex.props(styles.secondaryButton)}
					>
						Rescan
					</button>
				</div>
			</header>

			<Switch>
				<Match when={state().status === "loading"}>
					<div {...stylex.props(styles.emptyState)}>
						<span {...stylex.props(styles.pulse)} /> Inspecting saved packages…
					</div>
				</Match>
				<Match when={state().status === "not_configured"}>
					<div {...stylex.props(styles.emptyState)}>
						<strong>No project configured.</strong> Choose a project and its texture
						rule file to begin.
					</div>
				</Match>
				<Match when={state().status === "cancelled"}>
					<div {...stylex.props(styles.emptyState)}>
						Selection cancelled. No scan was started.
					</div>
				</Match>
				<Match when={state().status === "failed"}>
					{(() => {
						const current = state();
						if (current.status !== "failed") return null;
						return (
							<div {...stylex.props(styles.errorState)}>
								<strong>{current.result.error.message}</strong>
								<span>{current.result.error.recovery}</span>
							</div>
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
										<span>
											{report.status === "complete" ? "COMPLETE" : "PARTIAL"}
										</span>
										<strong>{report.ruleSetName}</strong>
									</div>
									<For
										each={
											[
												["Discovered", report.coverage.discoveredPackages],
												["Inspected", report.coverage.inspectedPackages],
												["Textures", report.coverage.textureAssets],
												[
													"Partial / failed",
													report.coverage.partialPackages +
														report.coverage.failedPackages
												]
											] as const
										}
									>
										{([label, value]) => (
											<div {...stylex.props(styles.coverageItem)}>
												<strong>{String(value).padStart(2, "0")}</strong>
												<span>{label}</span>
											</div>
										)}
									</For>
									<div {...stylex.props(styles.findingCount)}>
										<strong>{report.findings.length}</strong>
										<span>WARNINGS</span>
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
										title="Color evidence"
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
											<span>Object</span>
											<span>Source</span>
											<span>Group</span>
											<span>Finding</span>
										</div>
										<Show
											when={visible().length > 0}
											fallback={
												<div {...stylex.props(styles.noRows)}>
													No Texture2D assets match this view.
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
															onClick={() =>
																setSelectedPath(record.objectPath)
															}
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
																	finding && styles.warningText
																)}
															>
																{finding ? finding.ruleId : "Clear"}
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
													Select a texture to inspect evidence.
												</div>
											}
										>
											{(record) => (
												<>
													<div {...stylex.props(styles.inspectorKicker)}>
														SELECTED ASSET
													</div>
													<h2 {...stylex.props(styles.inspectorTitle)}>
														{shortName(record().objectPath)}
													</h2>
													<p {...stylex.props(styles.objectPath)}>
														{record().objectPath}
													</p>
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
																<span>
																	WARNING · {finding.ruleId}
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
										{report.diagnostics.length} package diagnostics retained ·
										report is partial
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
		backgroundColor: "#0d0f0e",
		color: "#e9e6dc",
		padding: "34px 40px 44px",
		backgroundImage:
			"radial-gradient(circle at 14% -10%, #2b2c244d 0, transparent 34%), linear-gradient(#ffffff05 1px, transparent 1px)",
		backgroundSize: "auto, 100% 28px"
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "flex-end",
		borderBottom: "1px solid #45463f",
		paddingBottom: 24,
		marginBottom: 18
	},
	eyebrow: { color: "#d7894a", fontSize: 11, letterSpacing: "0.2em", marginBottom: 10 },
	title: {
		fontFamily: "Georgia, serif",
		fontWeight: 400,
		fontSize: 44,
		letterSpacing: "-0.035em",
		margin: 0
	},
	subtitle: { color: "#969990", fontSize: 12, margin: "8px 0 0" },
	actions: { display: "flex", gap: 8 },
	primaryButton: {
		backgroundColor: "#d7894a",
		color: "#15130f",
		border: 0,
		padding: "11px 16px",
		cursor: "pointer",
		fontWeight: 700
	},
	secondaryButton: {
		backgroundColor: "transparent",
		color: "#d8d5cc",
		border: "1px solid #5a5c54",
		padding: "10px 16px",
		cursor: "pointer"
	},
	emptyState: {
		minHeight: 430,
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 12,
		color: "#aaa99f",
		border: "1px dashed #474941"
	},
	errorState: {
		padding: 24,
		border: "1px solid #b7604f",
		color: "#efb2a6",
		display: "flex",
		flexDirection: "column",
		gap: 8
	},
	pulse: {
		width: 8,
		height: 8,
		borderRadius: "50%",
		backgroundColor: "#d7894a",
		boxShadow: "0 0 18px #d7894a"
	},
	workspace: { display: "flex", flexDirection: "column", gap: 14 },
	coverage: {
		display: "grid",
		gridTemplateColumns: "1.8fr repeat(4, 1fr) 1fr",
		border: "1px solid #3d3f39",
		backgroundColor: "#151716"
	},
	coverageStatus: {
		padding: "14px 16px",
		borderLeft: "3px solid #6ea889",
		display: "flex",
		flexDirection: "column",
		gap: 5
	},
	coveragePartial: { borderLeftColor: "#d7894a" },
	coverageItem: {
		padding: "13px 15px",
		borderLeft: "1px solid #353731",
		display: "flex",
		flexDirection: "column",
		gap: 3
	},
	findingCount: {
		padding: "13px 15px",
		backgroundColor: "#3b231b",
		color: "#efa46e",
		display: "flex",
		flexDirection: "column"
	},
	distributionGrid: {
		display: "grid",
		gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
		gap: 10
	},
	distribution: { backgroundColor: "#141615", border: "1px solid #343631", minHeight: 164 },
	panelHeading: {
		padding: "10px 12px",
		borderBottom: "1px solid #343631",
		display: "flex",
		justifyContent: "space-between",
		fontSize: 11,
		textTransform: "uppercase",
		letterSpacing: "0.08em"
	},
	panelMeta: { color: "#686b64" },
	bars: { padding: "8px 10px" },
	barRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "minmax(82px, 1.1fr) 1fr 24px",
		alignItems: "center",
		gap: 8,
		color: "#aeb0a8",
		backgroundColor: { default: "transparent", ":hover": "#232622" },
		border: 0,
		padding: "5px 3px",
		textAlign: "left",
		cursor: "pointer",
		fontSize: 10
	},
	barRowActive: { color: "#f0a66e", backgroundColor: "#2e241d" },
	barLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
	barTrack: { height: 4, backgroundColor: "#292b27", display: "block" },
	barFill: { height: "100%", display: "block", backgroundColor: "#8c9987" },
	lowerGrid: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) 330px",
		gap: 10,
		minHeight: 350
	},
	sheet: { border: "1px solid #383a35", backgroundColor: "#121413", overflow: "hidden" },
	sheetTools: {
		display: "flex",
		gap: 10,
		padding: 10,
		borderBottom: "1px solid #383a35",
		alignItems: "center"
	},
	search: {
		minWidth: 260,
		flexGrow: 1,
		backgroundColor: "#090b0a",
		color: "#e6e3d9",
		border: "1px solid #41433d",
		padding: "8px 10px",
		outlineColor: "#d7894a"
	},
	toggle: { fontSize: 10, color: "#b0b2aa", display: "flex", gap: 6, whiteSpace: "nowrap" },
	clearButton: {
		fontSize: 10,
		border: 0,
		backgroundColor: "transparent",
		color: "#d7894a",
		cursor: "pointer"
	},
	tableHeader: {
		display: "grid",
		gridTemplateColumns: "2fr 0.75fr 1fr 1.1fr",
		padding: "8px 12px",
		color: "#6e716a",
		fontSize: 9,
		letterSpacing: "0.12em",
		textTransform: "uppercase"
	},
	tableRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "2fr 0.75fr 1fr 1.1fr",
		alignItems: "center",
		padding: "10px 12px",
		border: 0,
		borderTop: "1px solid #292b27",
		color: "#c8c8c0",
		backgroundColor: { default: "transparent", ":hover": "#1b1e1b" },
		textAlign: "left",
		cursor: "pointer",
		fontSize: 10
	},
	tableRowSelected: { backgroundColor: "#282a25", boxShadow: "inset 3px 0 #d7894a" },
	objectCell: { minWidth: 0, display: "flex", flexDirection: "column", gap: 3 },
	objectName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
	filePath: {
		color: "#696c65",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		fontSize: 8
	},
	warningText: { color: "#e89a62" },
	noRows: { padding: 30, color: "#74776f", textAlign: "center" },
	inspector: {
		border: "1px solid #3e403a",
		backgroundColor: "#191b19",
		padding: 18,
		overflow: "hidden"
	},
	inspectorKicker: { color: "#d7894a", letterSpacing: "0.15em", fontSize: 9 },
	inspectorTitle: {
		fontFamily: "Georgia, serif",
		fontWeight: 400,
		fontSize: 23,
		margin: "7px 0 4px",
		overflowWrap: "anywhere"
	},
	objectPath: { color: "#777a73", fontSize: 9, overflowWrap: "anywhere", margin: 0 },
	dimensionHero: {
		margin: "19px 0",
		padding: "15px 0",
		borderTop: "1px solid #393b36",
		borderBottom: "1px solid #393b36",
		display: "flex",
		alignItems: "baseline",
		gap: 8,
		color: "#dedbd2",
		fontSize: 13
	},
	evidenceList: { display: "flex", flexDirection: "column" },
	evidenceRow: {
		display: "grid",
		gridTemplateColumns: "1fr 1.2fr 0.8fr",
		padding: "7px 0",
		borderBottom: "1px solid #2e302c",
		fontSize: 9
	},
	evidenceLabel: { color: "#74776f" },
	evidenceValue: { color: "#dbd8ce", overflowWrap: "anywhere" },
	evidenceSource: { color: "#8e9189", textAlign: "right" },
	findingCard: {
		marginTop: 14,
		padding: 12,
		border: "1px solid #6e412d",
		backgroundColor: "#2c1d17",
		display: "flex",
		flexDirection: "column",
		gap: 5,
		color: "#e8aa7c",
		fontSize: 9
	},
	diagnostics: { padding: 10, color: "#d79866", border: "1px solid #68442e", fontSize: 10 }
});
