import * as stylex from "@stylexjs/stylex";
import { ConfigExplorerRoute } from "@ue-shed/extension-config-explorer";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import type { ConfigExplorerQuery, ConfigExplorerQueryResult } from "../main/preload.js";
import type { WorkbenchRendererClient } from "./workbench-client.js";

type QueryMode = ConfigExplorerQuery["mode"];
type QuerySource = ConfigExplorerQuery["source"];

const samples = [
	{
		key: "Entries",
		label: "Platform divergence",
		mode: "compare",
		note: "array merge + clear"
	},
	{ key: "Mode", label: "Last writer", mode: "explain", note: "scalar override" },
	{
		key: "ExplicitEmpty",
		label: "Empty vs missing",
		mode: "explain",
		note: "explicit array state"
	},
	{
		key: "Unsupported",
		label: "Coverage gap",
		mode: "explain",
		note: "unsupported syntax"
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
		run();
	};

	onMount(() => run());

	return (
		<main {...stylex.props(styles.route)}>
			<header {...stylex.props(styles.header)}>
				<div {...stylex.props(styles.titleBlock)}>
					<nav aria-label="Breadcrumb" {...stylex.props(styles.eyebrow)}>
						WORKBENCH / CONFIG EXPLORER
					</nav>
					<h1 {...stylex.props(styles.title)}>Trace a config value</h1>
					<p {...stylex.props(styles.intro)}>
						See the final saved value, the exact .ini lines that produced it, and what
						changes between platforms.
					</p>
				</div>
				<div {...stylex.props(styles.scopeStamp)}>
					<strong>SAVED SOURCE</strong>
					<span>Read-only · runtime overrides excluded</span>
				</div>
			</header>

			<section aria-label="Config query workspace" {...stylex.props(styles.workspace)}>
				<form onSubmit={run} {...stylex.props(styles.queryPanel)}>
					<div {...stylex.props(styles.queryOptions)}>
						<fieldset {...stylex.props(styles.segmentField)}>
							<legend>Source</legend>
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
									Sample
								</button>
							</div>
						</fieldset>

						<fieldset {...stylex.props(styles.segmentField)}>
							<legend>Question</legend>
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
									Why this value?
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
									What changes by platform?
								</button>
							</div>
						</fieldset>

						<span {...stylex.props(styles.readOnly)}>NO FILES ARE MODIFIED</span>
					</div>

					<div {...stylex.props(styles.fieldGrid)}>
						<label {...stylex.props(styles.field)}>
							<span>
								Family <small>optional</small>
							</span>
							<input
								aria-label="Config family"
								onInput={(event) => setFamily(event.currentTarget.value)}
								placeholder="Game"
								value={family()}
								{...stylex.props(styles.input)}
							/>
						</label>
						<label {...stylex.props(styles.field)}>
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
						<label {...stylex.props(styles.field)}>
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

						<button disabled={loading()} type="submit" {...stylex.props(styles.run)}>
							<span>
								{loading()
									? "TRACING…"
									: mode() === "compare"
										? "COMPARE"
										: "TRACE VALUE"}
							</span>
							<small>
								{mode() === "compare"
									? `${platform()} ⇄ ${rightPlatform()}`
									: platform()}
							</small>
						</button>
					</div>

					<div {...stylex.props(styles.samples)}>
						<span {...stylex.props(styles.sampleHeading)}>TRY A KNOWN CASE</span>
						<div {...stylex.props(styles.sampleList)}>
							<For each={samples}>
								{(sample) => (
									<button
										onClick={() => loadSample(sample)}
										type="button"
										{...stylex.props(styles.sampleButton)}
									>
										<strong>{sample.label}</strong>
										<span>{sample.note}</span>
									</button>
								)}
							</For>
						</div>
					</div>
				</form>
			</section>

			<Show when={loading()}>
				<section aria-live="polite" {...stylex.props(styles.state)}>
					<span {...stylex.props(styles.pulse)} />
					<div>
						<strong>Tracing saved config layers…</strong>
						<p>Folding source operations in Unreal load order.</p>
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
						RETRY
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
								<span {...stylex.props(styles.resultLabel)}>RESULT</span>
								<strong>{resolved.projectName}</strong>
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
		boxSizing: "border-box",
		backgroundColor: tokens.colorCanvas,
		backgroundImage: "radial-gradient(circle at 86% -10%, #d4552d14, transparent 27%)",
		color: tokens.colorText,
		padding: "20px 24px 34px"
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 30,
		padding: "0 2px 14px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	titleBlock: { minWidth: 0 },
	eyebrow: { color: tokens.colorWarningStrong, fontSize: 8, letterSpacing: ".16em" },
	title: {
		margin: "6px 0 3px",
		fontFamily: tokens.fontDisplay,
		fontSize: 26,
		fontWeight: 400,
		letterSpacing: "-.02em"
	},
	intro: { margin: 0, color: tokens.colorTextMuted, fontSize: 10, lineHeight: 1.5 },
	scopeStamp: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		flexShrink: 0,
		padding: "8px 11px",
		borderLeft: `2px solid ${tokens.colorWarningStrong}`,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextFaint,
		fontSize: 8,
		letterSpacing: ".07em"
	},
	workspace: {
		marginTop: 10,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurface
	},
	queryPanel: { padding: 13 },
	queryOptions: {
		display: "grid",
		gridTemplateColumns: "minmax(250px, .8fr) minmax(330px, 1.1fr) auto",
		alignItems: "end",
		gap: 10,
		paddingBottom: 11,
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	segmentField: { minWidth: 0, margin: 0, padding: 0, border: 0, fontSize: 8 },
	segments: { display: "flex", gap: 1, marginTop: 5, backgroundColor: tokens.colorBorder },
	segment: {
		flex: 1,
		minHeight: 30,
		padding: "6px 9px",
		border: 0,
		backgroundColor: { default: tokens.colorSurfaceInset, ":hover": tokens.colorSurfaceHover },
		color: tokens.colorTextSubtle,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 8,
		transitionProperty: "transform, background-color, color",
		transitionDuration: tokens.motionFast,
		transform: { default: "scale(1)", ":active": "scale(.98)" }
	},
	segmentActive: { backgroundColor: tokens.colorWarningStrong, color: "#fff8ec" },
	readOnly: {
		paddingBottom: 7,
		color: tokens.colorTextFaint,
		fontSize: 7,
		letterSpacing: ".1em"
	},
	fieldGrid: {
		display: "grid",
		gridTemplateColumns:
			"minmax(90px, .48fr) minmax(190px, 1.35fr) minmax(130px, .8fr) minmax(105px, .62fr) minmax(105px, .62fr) minmax(130px, .72fr)",
		gap: 8,
		alignItems: "end",
		marginTop: 11
	},
	field: { display: "flex", flexDirection: "column", gap: 5, minWidth: 0, fontSize: 8 },
	input: {
		width: "100%",
		height: 34,
		boxSizing: "border-box",
		padding: "7px 8px",
		border: `1px solid ${tokens.colorBorderInteractive}`,
		outline: { default: "none", ":focus": `1px solid ${tokens.colorWarningStrong}` },
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 9
	},
	run: {
		gridColumn: "-2 / -1",
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		alignItems: "start",
		gap: 3,
		height: 34,
		padding: "5px 10px",
		border: `1px solid ${tokens.colorWarningStrong}`,
		backgroundColor: {
			default: tokens.colorWarningStrong,
			":hover": "#e08b54",
			":disabled": "#70452d"
		},
		color: "#fff8ec",
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 8,
		letterSpacing: ".08em",
		transitionProperty: "transform, background-color",
		transitionDuration: tokens.motionFast,
		transform: { default: "scale(1)", ":active": "scale(.98)" }
	},
	samples: { display: "flex", alignItems: "center", gap: 12, marginTop: 11 },
	sampleHeading: {
		flexShrink: 0,
		color: tokens.colorTextFaint,
		fontSize: 7,
		letterSpacing: ".1em"
	},
	sampleList: { display: "flex", flexWrap: "wrap", gap: 5 },
	sampleButton: {
		display: "flex",
		alignItems: "center",
		gap: 7,
		padding: "6px 8px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: tokens.colorSurfaceInset, ":hover": tokens.colorSurfaceHover },
		color: tokens.colorTextMuted,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 8,
		transitionProperty: "transform, background-color",
		transitionDuration: tokens.motionFast,
		transform: { default: "scale(1)", ":active": "scale(.98)" }
	},
	state: {
		display: "flex",
		alignItems: "center",
		gap: 12,
		minHeight: 54,
		marginTop: 10,
		padding: "10px 14px",
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurface,
		fontSize: 9
	},
	failure: { justifyContent: "space-between", borderLeft: `3px solid ${tokens.colorDanger}` },
	pulse: {
		width: 7,
		height: 7,
		borderRadius: "50%",
		backgroundColor: tokens.colorWarning,
		boxShadow: "0 0 0 5px #d6a3631c"
	},
	retry: {
		padding: "7px 10px",
		border: `1px solid ${tokens.colorWarningStrong}`,
		backgroundColor: "transparent",
		color: tokens.colorWarning,
		cursor: "pointer"
	},
	resultBlock: { marginTop: 10 },
	resultHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 18,
		padding: "8px 12px",
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderBottom: 0,
		backgroundColor: tokens.colorSurfaceRaised,
		fontSize: 9
	},
	resultLabel: {
		marginRight: 9,
		color: tokens.colorWarningStrong,
		fontSize: 7,
		letterSpacing: ".1em"
	},
	queryReceipt: { display: "flex", alignItems: "center", gap: 12, color: tokens.colorTextFaint },
	evidence: { overflow: "hidden", border: `1px solid ${tokens.colorBorderStrong}` }
});
