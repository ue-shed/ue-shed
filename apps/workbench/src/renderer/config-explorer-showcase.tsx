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
			...(family().trim() === "" ? undefined : { family: family().trim() })
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
		minHeight: "calc(100vh - 48px)",
		boxSizing: "border-box",
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText,
		padding: "24px 32px 40px",
		maxWidth: 1200,
		margin: "0 auto"
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 30,
		padding: "4px 2px 16px",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	titleBlock: { minWidth: 0 },
	eyebrow: {
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 12,
		letterSpacing: "0"
	},
	title: {
		margin: "8px 0 6px",
		fontFamily: tokens.fontDisplay,
		fontSize: 26,
		fontWeight: 590,
		letterSpacing: "-0.02em",
		color: tokens.colorTextStrong
	},
	intro: { margin: 0, color: tokens.colorTextMuted, fontSize: 14, lineHeight: 1.6 },
	scopeStamp: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		flexShrink: 0,
		padding: "10px 14px",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	workspace: {
		marginTop: 16,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		boxShadow: tokens.shadowCard,
		overflow: "hidden"
	},
	queryPanel: { padding: 16 },
	queryOptions: {
		display: "grid",
		gridTemplateColumns: "minmax(250px, .8fr) minmax(330px, 1.1fr) auto",
		alignItems: "end",
		gap: 12,
		paddingBottom: 14,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	segmentField: { minWidth: 0, margin: 0, padding: 0, border: 0 },
	segments: {
		display: "flex",
		gap: 2,
		marginTop: 6,
		padding: 2,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset
	},
	segment: {
		flex: 1,
		minHeight: 30,
		padding: "6px 10px",
		border: 0,
		borderRadius: tokens.radiusBadge,
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.05)"
		},
		color: tokens.colorTextMuted,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 12,
		fontWeight: 500,
		transitionProperty: "background-color, color, transform",
		transitionDuration: tokens.motionFast,
		transform: { default: "scale(1)", ":active": "scale(.98)" }
	},
	segmentActive: {
		backgroundColor: "rgba(255, 255, 255, 0.1)",
		color: tokens.colorTextStrong
	},
	readOnly: {
		paddingBottom: 8,
		color: tokens.colorTextFaint,
		fontSize: 11,
		fontWeight: 500
	},
	fieldGrid: {
		display: "grid",
		gridTemplateColumns:
			"minmax(90px, .48fr) minmax(190px, 1.35fr) minmax(130px, .8fr) minmax(105px, .62fr) minmax(105px, .62fr) minmax(130px, .72fr)",
		gap: 8,
		alignItems: "end",
		marginTop: 14
	},
	field: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		minWidth: 0,
		fontSize: 11,
		fontWeight: 500,
		color: tokens.colorTextMuted
	},
	input: {
		width: "100%",
		height: 34,
		boxSizing: "border-box",
		padding: "7px 10px",
		borderColor: { default: tokens.colorBorderStrong, ":focus": tokens.colorTextSubtle },
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		outline: "none",
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontBody,
		fontSize: 13
	},
	run: {
		gridColumn: "-2 / -1",
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		alignItems: "start",
		gap: 2,
		height: 34,
		padding: "4px 12px",
		border: 0,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: tokens.colorAccent,
			":hover": tokens.colorAccentStrong,
			":active": "#d3e01f",
			":disabled": tokens.colorAccent
		},
		color: tokens.colorAccentText,
		cursor: { default: "pointer", ":disabled": "wait" },
		opacity: { default: 1, ":disabled": 0.55 },
		fontFamily: tokens.fontBody,
		fontSize: 13,
		fontWeight: 600,
		transitionProperty: "background-color, transform",
		transitionDuration: tokens.motionFast,
		transform: { default: "scale(1)", ":active": "scale(.98)" }
	},
	samples: { display: "flex", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" },
	sampleHeading: {
		flexShrink: 0,
		color: tokens.colorTextFaint,
		fontSize: 11,
		fontWeight: 500
	},
	sampleList: { display: "flex", flexWrap: "wrap", gap: 6 },
	sampleButton: {
		display: "flex",
		alignItems: "center",
		gap: 7,
		padding: "5px 11px",
		border: 0,
		borderRadius: tokens.radiusPill,
		backgroundColor: {
			default: "rgba(255, 255, 255, 0.04)",
			":hover": "rgba(255, 255, 255, 0.08)"
		},
		color: tokens.colorTextMuted,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 12
	},
	state: {
		display: "flex",
		alignItems: "center",
		gap: 12,
		minHeight: 54,
		marginTop: 16,
		padding: "12px 16px",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		fontSize: 13,
		color: tokens.colorTextMuted
	},
	failure: {
		justifyContent: "space-between",
		backgroundColor: "rgba(235, 87, 87, 0.07)",
		borderColor: "rgba(235, 87, 87, 0.35)"
	},
	pulse: {
		width: 7,
		height: 7,
		flexShrink: 0,
		borderRadius: "50%",
		backgroundColor: tokens.colorWarning,
		boxShadow: "0 0 0 5px rgba(242, 153, 74, 0.1)"
	},
	retry: {
		padding: "7px 12px",
		borderColor: { default: tokens.colorBorderStrong, ":hover": "#4a4e54" },
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		cursor: "pointer",
		fontSize: 12,
		fontWeight: 500
	},
	resultBlock: { marginTop: 16 },
	resultHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 18,
		padding: "10px 14px",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderBottomWidth: 0,
		borderTopLeftRadius: tokens.radiusControl,
		borderTopRightRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		fontSize: 13,
		color: tokens.colorText
	},
	resultLabel: {
		marginRight: 8,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	queryReceipt: {
		display: "flex",
		alignItems: "center",
		gap: 12,
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	evidence: {
		overflow: "hidden",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderBottomLeftRadius: tokens.radiusControl,
		borderBottomRightRadius: tokens.radiusControl
	}
});
