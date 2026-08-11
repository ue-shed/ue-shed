import * as stylex from "@stylexjs/stylex";
import { ConfigExplorerRoute } from "@ue-shed/extension-config-explorer";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { ConfigExplorerQuery, ConfigExplorerQueryResult } from "../main/preload.js";
import type { WorkbenchRendererClient } from "./workbench-client.js";

type QueryMode = ConfigExplorerQuery["mode"];
type QuerySource = ConfigExplorerQuery["source"];

const samples = [
	{
		key: "Entries",
		label: "Array operations",
		mode: "compare",
		note: "add, remove, clear, duplicates"
	},
	{ key: "Mode", label: "Scalar override", mode: "explain", note: "last writer wins" },
	{
		key: "ExplicitEmpty",
		label: "Explicit empty",
		mode: "explain",
		note: "empty is not missing"
	},
	{
		key: "Unsupported",
		label: "Unsupported syntax",
		mode: "explain",
		note: "partial coverage"
	}
] as const;

export interface ConfigExplorerShowcaseProps {
	readonly client: Pick<WorkbenchRendererClient, "configExplorerQuery">;
}

function errorCandidates(
	error: Extract<ConfigExplorerQueryResult, { readonly status: "failed" }>["error"]
): readonly string[] | undefined {
	return "candidates" in error ? error.candidates : undefined;
}

export function ConfigExplorerShowcase(props: ConfigExplorerShowcaseProps) {
	const action = createEffectAction();
	const [source, setSource] = createSignal<QuerySource>("sample_fixture");
	const [mode, setMode] = createSignal<QueryMode>("compare");
	const [family, setFamily] = createSignal("Game");
	const [section, setSection] = createSignal("Fixture.Settings");
	const [key, setKey] = createSignal("Entries");
	const [platform, setPlatform] = createSignal("PlatformA");
	const [rightPlatform, setRightPlatform] = createSignal("PlatformB");
	const [loading, setLoading] = createSignal(false);
	const [transportFailure, setTransportFailure] = createSignal(false);
	const [result, setResult] = createSignal<ConfigExplorerQueryResult>();
	const ready = createMemo(() => {
		const current = result();
		return current?.status === "ready" ? current : undefined;
	});
	const failed = createMemo(() => {
		const current = result();
		return current?.status === "failed" ? current : undefined;
	});

	const request = (): ConfigExplorerQuery => {
		const common = {
			source: source(),
			section: section().trim(),
			key: key().trim(),
			...(family().trim() === "" ? {} : { family: family().trim() })
		};
		return mode() === "explain"
			? {
					...common,
					mode: "explain",
					platform: platform().trim()
				}
			: {
					...common,
					leftPlatform: platform().trim(),
					mode: "compare",
					rightPlatform: rightPlatform().trim()
				};
	};

	const run = (event?: SubmitEvent) => {
		event?.preventDefault();
		setLoading(true);
		setTransportFailure(false);
		setResult(undefined);
		action.run(props.client.configExplorerQuery(request()), {
			onFailure: () => {
				setLoading(false);
				setTransportFailure(true);
			},
			onSuccess: (next) => {
				setLoading(false);
				setResult(next);
			}
		});
	};

	const loadSample = (sample: (typeof samples)[number]) => {
		setSource("sample_fixture");
		setMode(sample.mode);
		setFamily("Game");
		setSection("Fixture.Settings");
		setKey(sample.key);
		setPlatform("PlatformA");
		setRightPlatform("PlatformB");
		setResult(undefined);
	};

	return (
		<main {...stylex.props(styles.route)}>
			<header {...stylex.props(styles.header)}>
				<div>
					<nav aria-label="Breadcrumb" {...stylex.props(styles.eyebrow)}>
						WORKBENCH / CONFIG EXPLORER
					</nav>
					<h1 {...stylex.props(styles.title)}>Why does this setting have that value?</h1>
					<p {...stylex.props(styles.intro)}>
						Resolve one saved Unreal .ini key against the selected project, then inspect
						every layer and operation that produced it. Read-only. No live CVars, Device
						Profiles, command line, or cooked config.
					</p>
				</div>
				<div {...stylex.props(styles.scopeStamp)}>
					<span>SAVED CONFIG ONLY</span>
					<strong>UE 5.7 hierarchy semantics</strong>
					<small>Effective value + ordered provenance</small>
				</div>
			</header>

			<section aria-label="Config query workspace" {...stylex.props(styles.workspace)}>
				<form onSubmit={run} {...stylex.props(styles.queryPanel)}>
					<div {...stylex.props(styles.panelHeading)}>
						<div>
							<span {...stylex.props(styles.step)}>01 / TARGET</span>
							<h2>Build a query</h2>
						</div>
						<span {...stylex.props(styles.readOnly)}>READ ONLY</span>
					</div>

					<fieldset {...stylex.props(styles.segmentField)}>
						<legend>Configuration source</legend>
						<div {...stylex.props(styles.segments)}>
							<button
								aria-pressed={source() === "selected_project"}
								onClick={() => setSource("selected_project")}
								type="button"
								{...stylex.props(
									styles.segment,
									source() === "selected_project" && styles.segmentActive
								)}
							>
								Selected project
							</button>
							<button
								aria-pressed={source() === "sample_fixture"}
								onClick={() => setSource("sample_fixture")}
								type="button"
								{...stylex.props(
									styles.segment,
									source() === "sample_fixture" && styles.segmentActive
								)}
							>
								Sample fixture
							</button>
						</div>
						<p>
							{source() === "selected_project"
								? "Uses the project chosen in the Workbench header and its discovered or explicitly configured engine."
								: "Uses committed text files so the workflow is usable without an Unreal installation."}
						</p>
					</fieldset>

					<fieldset {...stylex.props(styles.segmentField)}>
						<legend>Operation</legend>
						<div {...stylex.props(styles.segments)}>
							<button
								aria-pressed={mode() === "explain"}
								onClick={() => setMode("explain")}
								type="button"
								{...stylex.props(
									styles.segment,
									mode() === "explain" && styles.segmentActive
								)}
							>
								Explain
							</button>
							<button
								aria-pressed={mode() === "compare"}
								onClick={() => setMode("compare")}
								type="button"
								{...stylex.props(
									styles.segment,
									mode() === "compare" && styles.segmentActive
								)}
							>
								Compare platforms
							</button>
						</div>
					</fieldset>

					<div {...stylex.props(styles.fieldGrid)}>
						<label {...stylex.props(styles.field)}>
							<span>
								Config family <small>optional</small>
							</span>
							<input
								aria-label="Config family"
								onInput={(event) => setFamily(event.currentTarget.value)}
								placeholder="Game"
								value={family()}
								{...stylex.props(styles.input)}
							/>
						</label>
						<label {...stylex.props(styles.field, styles.fieldWide)}>
							<span>Section</span>
							<input
								aria-label="Config section"
								onInput={(event) => setSection(event.currentTarget.value)}
								placeholder="/Script/Engine.Engine"
								required
								value={section()}
								{...stylex.props(styles.input)}
							/>
						</label>
						<label {...stylex.props(styles.field, styles.fieldWide)}>
							<span>Key</span>
							<input
								aria-label="Config key"
								onInput={(event) => setKey(event.currentTarget.value)}
								placeholder="bUseFixedFrameRate"
								required
								value={key()}
								{...stylex.props(styles.input)}
							/>
						</label>
						<label {...stylex.props(styles.field)}>
							<span>{mode() === "compare" ? "Left platform" : "Platform"}</span>
							<input
								aria-label={mode() === "compare" ? "Left platform" : "Platform"}
								list="config-platforms"
								onInput={(event) => setPlatform(event.currentTarget.value)}
								required
								value={platform()}
								{...stylex.props(styles.input)}
							/>
						</label>
						<Show when={mode() === "compare"}>
							<label {...stylex.props(styles.field)}>
								<span>Right platform</span>
								<input
									aria-label="Right platform"
									list="config-platforms"
									onInput={(event) => setRightPlatform(event.currentTarget.value)}
									required
									value={rightPlatform()}
									{...stylex.props(styles.input)}
								/>
							</label>
						</Show>
						<datalist id="config-platforms">
							<option value="Windows" />
							<option value="Linux" />
							<option value="Mac" />
							<option value="Android" />
							<option value="IOS" />
						</datalist>
					</div>

					<button disabled={loading()} type="submit" {...stylex.props(styles.run)}>
						<span>
							{loading()
								? "RESOLVING…"
								: mode() === "compare"
									? "COMPARE"
									: "EXPLAIN"}
						</span>
						<small>
							{mode() === "compare"
								? `${platform()} ⇄ ${rightPlatform()}`
								: platform()}
						</small>
					</button>
				</form>

				<aside {...stylex.props(styles.samples)}>
					<span {...stylex.props(styles.step)}>02 / QUICK START</span>
					<h2>Known evidence cases</h2>
					<p>
						Load a query, edit any field, then run it. These are examples, not canned
						results.
					</p>
					<div {...stylex.props(styles.sampleList)}>
						<For each={samples}>
							{(sample) => (
								<button
									onClick={() => loadSample(sample)}
									type="button"
									{...stylex.props(styles.sampleButton)}
								>
									<span {...stylex.props(styles.sampleMeta)}>
										<strong {...stylex.props(styles.sampleLabel)}>
											{sample.label}
										</strong>
										<small {...stylex.props(styles.sampleNote)}>
											{sample.note}
										</small>
									</span>
									<code {...stylex.props(styles.sampleCode)}>{sample.key}</code>
								</button>
							)}
						</For>
					</div>
					<div {...stylex.props(styles.boundary)}>
						<strong>What this can answer</strong>
						<p>
							Which files contributed? In what order? Which operation changed the
							value? What survived? Which expected layers were missing or unreadable?
						</p>
					</div>
				</aside>
			</section>

			<Show when={loading()}>
				<section aria-live="polite" {...stylex.props(styles.state)}>
					<span {...stylex.props(styles.pulse)} />
					<div>
						<strong>Reconstructing the saved hierarchy</strong>
						<p>Reading layers and folding contributions in engine-defined order…</p>
					</div>
				</section>
			</Show>

			<Show when={transportFailure()}>
				<section role="alert" {...stylex.props(styles.state, styles.failure)}>
					<div>
						<strong>Workbench could not validate the query response.</strong>
						<p>Restart Workbench and verify package versions, then retry.</p>
					</div>
					<button onClick={() => run()} {...stylex.props(styles.retry)}>
						RETRY QUERY
					</button>
				</section>
			</Show>

			<Show when={failed()}>
				{(failure) => (
					<section role="alert" {...stylex.props(styles.state, styles.failure)}>
						<div>
							<strong>{failure().error.message}</strong>
							<p>{failure().error.recovery}</p>
							<Show when={errorCandidates(failure().error)}>
								{(candidates) => <p>Candidates: {candidates().join(", ")}</p>}
							</Show>
						</div>
						<code>{failure().error.code}</code>
					</section>
				)}
			</Show>

			<Show when={ready()} keyed>
				{(resolved) => (
					<section {...stylex.props(styles.resultBlock)}>
						<header {...stylex.props(styles.resultHeader)}>
							<div>
								<span {...stylex.props(styles.step)}>03 / EVIDENCE</span>
								<h2>{resolved.projectName}</h2>
							</div>
							<div {...stylex.props(styles.queryReceipt)}>
								<span>
									{resolved.source === "selected_project"
										? "SELECTED PROJECT"
										: "SAMPLE"}
								</span>
								<code>
									[
									{resolved.mode === "explain"
										? resolved.evidence.section
										: resolved.evidence.left.section}
									] /{" "}
									{resolved.mode === "explain"
										? resolved.evidence.key
										: resolved.evidence.left.key}
								</code>
							</div>
						</header>
						<section
							aria-label="Config Explorer evidence"
							{...stylex.props(styles.evidence)}
						>
							<ConfigExplorerRoute result={resolved.evidence} />
						</section>
					</section>
				)}
			</Show>
		</main>
	);
}

const styles = stylex.create({
	route: {
		minHeight: "calc(100vh - 52px)",
		backgroundColor: "#0d100e",
		backgroundImage:
			"radial-gradient(circle at 82% -12%, #d4552d1c, transparent 28%), linear-gradient(90deg, transparent 49.9%, #ffffff06 50%, transparent 50.1%)",
		color: tokens.colorText,
		padding: "30px 36px 52px"
	},
	header: {
		display: "flex",
		alignItems: "end",
		justifyContent: "space-between",
		gap: 36,
		paddingBottom: 22,
		borderBottom: "1px solid #333934"
	},
	eyebrow: { color: "#d4552d", fontSize: 9, letterSpacing: ".18em" },
	title: {
		margin: "9px 0 7px",
		fontFamily: "Georgia, serif",
		fontSize: 34,
		fontWeight: 400,
		letterSpacing: "-.025em"
	},
	intro: { maxWidth: 740, margin: 0, color: "#929c95", fontSize: 11, lineHeight: 1.65 },
	scopeStamp: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		minWidth: 290,
		padding: "13px 16px",
		border: "1px solid #474e48",
		borderLeft: "3px solid #d4552d",
		backgroundColor: "#151a17"
	},
	workspace: {
		display: "grid",
		gridTemplateColumns: "minmax(620px, 1fr) minmax(270px, 340px)",
		gap: 1,
		marginTop: 18,
		marginBottom: 18,
		backgroundColor: "#333934",
		border: "1px solid #333934"
	},
	queryPanel: { padding: "20px 22px", backgroundColor: "#151a17" },
	panelHeading: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "start",
		marginBottom: 16
	},
	step: { color: "#d4552d", fontSize: 9, letterSpacing: ".16em" },
	readOnly: {
		padding: "5px 8px",
		border: "1px solid #486052",
		color: "#8eb29b",
		fontSize: 8,
		letterSpacing: ".12em"
	},
	segmentField: { margin: "0 0 14px", padding: 0, border: 0 },
	segments: { display: "flex", gap: 1, backgroundColor: "#353b36" },
	segment: {
		flex: 1,
		padding: "9px 11px",
		border: 0,
		backgroundColor: { default: "#101411", ":hover": "#202620" },
		color: "#949d96",
		cursor: "pointer",
		fontSize: 10
	},
	segmentActive: { backgroundColor: "#d4552d", color: "#fff8ec" },
	fieldGrid: {
		display: "grid",
		gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
		gap: 10
	},
	field: { display: "flex", flexDirection: "column", gap: 6 },
	fieldWide: { gridColumn: "span 2" },
	input: {
		width: "100%",
		boxSizing: "border-box",
		padding: "9px 10px",
		border: "1px solid #3b443d",
		outline: { default: "none", ":focus": "1px solid #d4552d" },
		backgroundColor: "#0d100e",
		color: "#e1e5e1",
		fontFamily: "ui-monospace, monospace",
		fontSize: 11
	},
	run: {
		display: "flex",
		justifyContent: "space-between",
		width: "100%",
		marginTop: 16,
		padding: "12px 14px",
		border: "1px solid #e06a43",
		backgroundColor: { default: "#c94e28", ":hover": "#df5c34", ":disabled": "#713e2f" },
		color: "#fff7eb",
		cursor: "pointer",
		letterSpacing: ".11em"
	},
	samples: { padding: "20px", backgroundColor: "#111512" },
	sampleList: { display: "flex", flexDirection: "column", gap: 1, marginTop: 15 },
	sampleButton: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "11px 12px",
		border: 0,
		borderLeft: "2px solid transparent",
		backgroundColor: { default: "#181d19", ":hover": "#242b25" },
		color: "#aeb6b0",
		cursor: "pointer",
		textAlign: "left"
	},
	sampleMeta: { display: "flex", flexDirection: "column", gap: 3 },
	sampleLabel: { fontSize: 11, fontWeight: 600 },
	sampleNote: { color: "#7f8a82", fontSize: 9 },
	sampleCode: { color: "#d8b66d", fontSize: 9 },
	boundary: {
		marginTop: 18,
		padding: 14,
		border: "1px solid #343c36",
		backgroundColor: "#171c18"
	},
	state: {
		display: "flex",
		alignItems: "center",
		gap: 16,
		minHeight: 100,
		padding: 22,
		border: "1px solid #333934",
		backgroundColor: "#151a17"
	},
	failure: { justifyContent: "space-between", borderLeft: "4px solid #d4552d" },
	pulse: {
		width: 10,
		height: 10,
		borderRadius: "50%",
		backgroundColor: "#f3c969",
		boxShadow: "0 0 0 7px #f3c9691f"
	},
	retry: {
		padding: "9px 14px",
		border: "1px solid #d4552d",
		backgroundColor: "transparent",
		color: "#f3c969",
		cursor: "pointer"
	},
	resultBlock: { marginTop: 18 },
	resultHeader: {
		display: "flex",
		alignItems: "end",
		justifyContent: "space-between",
		padding: "14px 17px",
		border: "1px solid #4b504b",
		borderBottom: 0,
		backgroundColor: "#151a17"
	},
	queryReceipt: {
		display: "flex",
		flexDirection: "column",
		alignItems: "end",
		gap: 4
	},
	evidence: { overflow: "hidden", border: "1px solid #4b504b" }
});
