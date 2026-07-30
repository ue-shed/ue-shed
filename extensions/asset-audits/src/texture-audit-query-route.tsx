import * as stylex from "@stylexjs/stylex";
import type {
	TextureAuditQueryRunResult,
	TextureAuditQuerySummary,
	TextureAuditRecord,
	TextureAuditSearchPage,
	TextureDistributionSelection,
	TexturePreviewResult,
	TextureRecord
} from "@ue-shed/asset-audits/browser";
import { createEffectAction } from "@ue-shed/ui";
import { For, Match, Show, Switch, createSignal, onMount } from "solid-js";
import type { TextureAuditClientShape } from "./texture-audit-client.js";

type ViewState =
	| { readonly status: "loading" }
	| { readonly status: "not_configured" }
	| { readonly status: "cancelled" }
	| {
			readonly status: "failed";
			readonly error: Extract<TextureAuditQueryRunResult, { status: "failed" }>["error"];
	  }
	| {
			readonly status: "ready";
			readonly page: TextureAuditSearchPage;
			readonly summary: TextureAuditQuerySummary;
	  };

function shortName(objectPath: string): string {
	return objectPath.slice(objectPath.lastIndexOf("/") + 1).split(".")[0] ?? objectPath;
}

function evidenceLabel(evidence: TextureRecord["compression"] | TextureRecord["sRGB"]): string {
	return evidence.status === "available" ? String(evidence.value) : "Unavailable";
}

function details(record: TextureAuditRecord | undefined): TextureRecord | undefined {
	return record?.record;
}

function dimensionsLabel(record: TextureRecord): string {
	const dimensions = record.dimensions;
	return dimensions.status === "available"
		? `${dimensions.value.width} × ${dimensions.value.height}`
		: "Dimensions unavailable";
}

function failure(cause: unknown): Extract<ViewState, { status: "failed" }> {
	return {
		error: {
			code: "contract_failure",
			message: String(cause),
			recovery: "Restart Workbench. If the problem persists, verify package versions.",
			retrySafe: true
		},
		status: "failed"
	};
}

/** Bounded query presentation; full texture records remain in the Workbench main process. */
export function TextureAuditRoute(props: { readonly client: TextureAuditClientShape }) {
	const refreshAction = createEffectAction();
	const searchAction = createEffectAction();
	const detailAction = createEffectAction();
	const previewAction = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [query, setQuery] = createSignal("");
	const [selection, setSelection] = createSignal<TextureDistributionSelection>();
	const [findingsOnly, setFindingsOnly] = createSignal(false);
	const [selectedPath, setSelectedPath] = createSignal<string>();
	const [record, setRecord] = createSignal<TextureAuditRecord>();
	const [preview, setPreview] = createSignal<TexturePreviewResult>();
	const availablePreview = () => {
		const current = preview();
		return current?.status === "available" ? current : undefined;
	};
	let searchGeneration = 0;

	const requestRecord = (objectPath: string) => {
		setSelectedPath(objectPath);
		detailAction.run(props.client.record(objectPath), {
			onFailure: (cause) => setState(failure(cause)),
			onSuccess: (result) => setRecord(result.status === "found" ? result.record : undefined)
		});
		previewAction.run(props.client.loadPreview(objectPath), {
			onFailure: () => setPreview(undefined),
			onSuccess: setPreview
		});
	};

	const requestPage = (cursor?: TextureRecord["objectPath"]) => {
		const generation = ++searchGeneration;
		searchAction.run(
			props.client.search({
				...(cursor === undefined ? {} : { cursor }),
				findingsOnly: findingsOnly(),
				pageSize: 100,
				query: query(),
				...(selection() === undefined ? {} : { selection: selection()! })
			}),
			{
				onFailure: (cause) => setState(failure(cause)),
				onSuccess: (result) => {
					if (generation !== searchGeneration || result.status !== "ready") return;
					const current = state();
					if (current.status !== "ready") return;
					setState({ ...current, page: result.page });
					const next =
						result.page.records.find((item) => item.objectPath === selectedPath()) ??
						result.page.records[0];
					if (next) requestRecord(next.objectPath);
					else {
						setSelectedPath(undefined);
						setRecord(undefined);
						setPreview(undefined);
					}
				}
			}
		);
	};

	const applyRefresh = (result: TextureAuditQueryRunResult) => {
		if (result.status === "completed") {
			setState({
				page: { findings: [], records: [], total: 0 },
				status: "ready",
				summary: result.summary
			});
			setSelectedPath(undefined);
			setRecord(undefined);
			setPreview(undefined);
			requestPage();
		} else if (result.status === "failed") setState({ error: result.error, status: "failed" });
		else setState({ status: result.status });
	};

	const refresh = () => {
		setState({ status: "loading" });
		refreshAction.run(props.client.loadConfiguredProject(), {
			onFailure: (cause) => setState(failure(cause)),
			onSuccess: applyRefresh
		});
	};

	onMount(refresh);

	return (
		<main {...stylex.props(styles.page)}>
			<header {...stylex.props(styles.header)}>
				<nav aria-label="Breadcrumb">Asset audits / Texture audit</nav>
				<button type="button" onClick={refresh}>
					Rescan
				</button>
			</header>
			<Switch>
				<Match when={state().status === "loading"}>
					<div {...stylex.props(styles.empty)}>Reading Texture2D evidence…</div>
				</Match>
				<Match when={state().status === "not_configured"}>
					<div {...stylex.props(styles.empty)}>No project configured.</div>
				</Match>
				<Match when={state().status === "cancelled"}>
					<div {...stylex.props(styles.empty)}>Project selection cancelled.</div>
				</Match>
				<Match when={state().status === "failed"}>
					{(() => {
						const current = state();
						return current.status === "failed" ? (
							<div {...stylex.props(styles.error)}>{current.error.message}</div>
						) : null;
					})()}
				</Match>
				<Match when={state().status === "ready"}>
					{(() => {
						const current = state();
						if (current.status !== "ready") return null;
						const selected = details(record());
						return (
							<div {...stylex.props(styles.workspace)}>
								<section
									aria-label="Scan coverage"
									{...stylex.props(styles.coverage)}
								>
									<strong>
										{current.summary.status === "partial"
											? "PARTIAL"
											: "COMPLETE"}
									</strong>
									<span>{current.summary.ruleSetName}</span>
									<span>{current.summary.coverage.textureAssets} textures</span>
									<span>{current.summary.findingCount} warnings</span>
									<span>{current.summary.diagnosticCount} diagnostics</span>
								</section>
								<section
									aria-label="Texture distributions"
									{...stylex.props(styles.distributions)}
								>
									<For
										each={
											[
												[
													"Maximum dimension",
													"maximumDimension",
													current.summary.distributions.maximumDimension
												],
												[
													"Texture group",
													"textureGroup",
													current.summary.distributions.textureGroup
												],
												[
													"Compression",
													"compression",
													current.summary.distributions.compression
												],
												[
													"Color evidence",
													"sRGB",
													current.summary.distributions.sRGB
												]
											] as const
										}
									>
										{([label, kind, buckets]) => (
											<div>
												<strong>{label}</strong>
												<For each={buckets.slice(0, 6)}>
													{(bucket) => (
														<button
															type="button"
															onClick={() => {
																setSelection({
																	key: bucket.key,
																	kind
																});
																requestPage();
															}}
														>
															{bucket.label} · {bucket.count}
														</button>
													)}
												</For>
											</div>
										)}
									</For>
								</section>
								<section {...stylex.props(styles.tools)}>
									<input
										aria-label="Search textures"
										value={query()}
										onInput={(event) => {
											setQuery(event.currentTarget.value);
											requestPage();
										}}
										placeholder="Filter object paths…"
									/>
									<label>
										<input
											type="checkbox"
											checked={findingsOnly()}
											onChange={(event) => {
												setFindingsOnly(event.currentTarget.checked);
												requestPage();
											}}
										/>{" "}
										Findings only
									</label>
									<Show when={selection()}>
										<button
											type="button"
											onClick={() => {
												setSelection(undefined);
												requestPage();
											}}
										>
											Clear distribution filter
										</button>
									</Show>
									<span>{current.page.total} assets</span>
								</section>
								<div {...stylex.props(styles.grid)}>
									<section
										aria-label="Texture records"
										{...stylex.props(styles.table)}
									>
										<For each={current.page.records}>
											{(item) => (
												<button
													type="button"
													aria-pressed={
														selectedPath() === item.objectPath
													}
													onClick={() => requestRecord(item.objectPath)}
												>
													<strong>{shortName(item.objectPath)}</strong>
													<span>
														{item.dimensions.status === "available"
															? `${item.dimensions.value.width} × ${item.dimensions.value.height}`
															: "—"}
													</span>
													<span>{evidenceLabel(item.textureGroup)}</span>
												</button>
											)}
										</For>
										<Show when={current.page.records.length === 0}>
											<p>No Texture2D assets match this view.</p>
										</Show>
										<Show when={current.page.nextCursor}>
											{(cursor) => (
												<button
													type="button"
													onClick={() => requestPage(cursor())}
												>
													Next page
												</button>
											)}
										</Show>
									</section>
									<aside
										aria-label="Texture inspector"
										{...stylex.props(styles.inspector)}
									>
										<Show
											when={selected}
											fallback={<p>Select a texture to inspect evidence.</p>}
										>
											{(item) => (
												<>
													<strong>{shortName(item().objectPath)}</strong>
													<code>{item().objectPath}</code>
													<Show when={availablePreview()}>
														{(currentPreview) => (
															<img
																src={`data:${currentPreview().mimeType};base64,${currentPreview().dataBase64}`}
																alt={`Live preview of ${shortName(item().objectPath)}`}
															/>
														)}
													</Show>
													<p>{dimensionsLabel(item())}</p>
													<p>
														Group: {evidenceLabel(item().textureGroup)}
													</p>
													<p>
														Compression:{" "}
														{evidenceLabel(item().compression)}
													</p>
													<For each={record()?.findings ?? []}>
														{(finding) => (
															<p>
																WARNING · {finding.ruleId}:{" "}
																{finding.explanation}
															</p>
														)}
													</For>
												</>
											)}
										</Show>
									</aside>
								</div>
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
		padding: "34px 40px",
		color: "#e6e3d9",
		backgroundColor: "#111310"
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		marginBottom: 16,
		color: "#d7894a",
		fontSize: 10,
		letterSpacing: ".14em"
	},
	empty: {
		minHeight: 430,
		display: "grid",
		placeItems: "center",
		border: "1px dashed #474941",
		color: "#91958d"
	},
	error: {
		minHeight: 300,
		display: "grid",
		placeItems: "center",
		border: "1px solid #b7604f",
		color: "#efb2a6"
	},
	workspace: { display: "flex", flexDirection: "column", gap: 12 },
	coverage: {
		display: "flex",
		gap: 20,
		flexWrap: "wrap",
		padding: 14,
		border: "1px solid #3d3f39",
		backgroundColor: "#181a17",
		fontSize: 10
	},
	distributions: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 },
	tools: {
		display: "flex",
		gap: 10,
		alignItems: "center",
		padding: 10,
		border: "1px solid #383a35"
	},
	grid: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", gap: 10 },
	table: {
		display: "flex",
		flexDirection: "column",
		border: "1px solid #383a35",
		maxHeight: "calc(100vh - 350px)",
		overflow: "auto"
	},
	inspector: {
		padding: 18,
		border: "1px solid #3e403a",
		overflow: "auto",
		maxHeight: "calc(100vh - 350px)"
	}
});
