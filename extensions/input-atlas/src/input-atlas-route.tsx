import * as stylex from "@stylexjs/stylex";
import {
	buildInputAtlas,
	deviceOf,
	findAtlasKey,
	type AtlasKey,
	type EnhancedInputPublicError,
	type EnhancedInputReport,
	type EnhancedInputRunResult
} from "@ue-shed/enhanced-input/browser";
import { Button, createEffectAction, PageHeader } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause } from "effect";
import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import type { InputAtlasClientShape } from "./input-atlas-client.js";
import {
	capLabel,
	FACE_RADIUS,
	GAMEPAD_BODY,
	GAMEPAD_VIEWBOX,
	gamepadControls,
	keyboardRows,
	mouseCaps,
	STICK_RADIUS,
	isKeyboardCap,
	unplacedKeys,
	type KeyboardCell,
	type KeyboardCap
} from "./input-device-layout.js";

type ViewState =
	| { readonly status: "loading" }
	| { readonly status: "not_configured" }
	| { readonly status: "cancelled" }
	| { readonly status: "failed"; readonly error: EnhancedInputPublicError }
	| {
			readonly status: "ready";
			readonly report: EnhancedInputReport;
			readonly projectRoot: string;
	  };

// The scan carries an absolute root; the diagram only needs the leaf folder to say "this project".
function projectName(projectRoot: string): string {
	const trimmed = projectRoot.replace(/[/\\]+$/, "");
	const leaf = trimmed.split(/[/\\]/).pop();
	return leaf && leaf.length > 0 ? leaf : projectRoot;
}

export function InputAtlasRoute(props: { readonly client: InputAtlasClientShape }) {
	const scanAction = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	// The last project we successfully scanned, kept across a Rescan so the banner still names it
	// while the bar animates.
	const [activeProject, setActiveProject] = createSignal<string | undefined>(undefined);
	// Context chips start selected; the atlas shows only the selected set. Empty selection shows
	// nothing, so toggling and invert stay truthful about "filter by selected".
	const [selectedContexts, setSelectedContexts] = createSignal<ReadonlySet<string> | undefined>(
		undefined
	);
	const [selectedKey, setSelectedKey] = createSignal<string | null>(null);

	const report = () => {
		const current = state();
		return current.status === "ready" ? current.report : undefined;
	};

	// The unfiltered atlas answers "which contexts exist"; the filtered one drives the diagram,
	// so deselecting a context can resolve a contest in front of you.
	const fullAtlas = createMemo(() => {
		const current = report();
		return current ? buildInputAtlas(current) : undefined;
	});

	const contextPaths = createMemo(
		() => fullAtlas()?.contexts.map((context) => context.objectPath) ?? []
	);

	const isContextSelected = (objectPath: string): boolean => {
		const selected = selectedContexts();
		return selected === undefined ? true : selected.has(objectPath);
	};

	const atlas = createMemo(() => {
		const current = report();
		if (!current) return undefined;
		const selected = selectedContexts();
		return buildInputAtlas(
			current,
			selected === undefined
				? undefined
				: {
						contexts: contextPaths().filter((path) => selected.has(path))
					}
		);
	});

	const toggleContext = (objectPath: string) => {
		const paths = contextPaths();
		setSelectedContexts((current) => {
			const next = new Set(current ?? paths);
			if (next.has(objectPath)) next.delete(objectPath);
			else next.add(objectPath);
			return next.size === paths.length ? undefined : next;
		});
	};

	const invertContexts = () => {
		const paths = contextPaths();
		if (paths.length === 0) return;
		setSelectedContexts((current) => {
			const selected = current ?? new Set(paths);
			const next = new Set(paths.filter((path) => !selected.has(path)));
			return next.size === paths.length ? undefined : next;
		});
	};

	const selected = createMemo(() => {
		const current = atlas();
		return current === undefined ? undefined : findAtlasKey(current, selectedKey());
	});

	const applyResult = (result: EnhancedInputRunResult) => {
		if (result.status === "completed") {
			setState({ status: "ready", report: result.report, projectRoot: result.projectRoot });
			setActiveProject(result.projectRoot);
			setSelectedContexts(undefined);
			const first = buildInputAtlas(result.report).contestedKeys[0];
			setSelectedKey(first ?? buildInputAtlas(result.report).keys[0]?.key ?? null);
		} else if (result.status === "failed") {
			setState({ status: "failed", error: result.error });
		} else setState({ status: result.status });
	};

	const run = (effect: () => ReturnType<InputAtlasClientShape["loadConfiguredProject"]>) => {
		setState({ status: "loading" });
		scanAction.run(effect(), {
			onSuccess: applyResult,
			onFailure: (cause) =>
				setState({
					status: "failed",
					error: {
						code: "invalid_project",
						message: Cause.pretty(cause),
						recovery: "Choose an Unreal project directory and scan again.",
						retrySafe: true
					}
				})
		});
	};

	onMount(() => run(() => props.client.loadConfiguredProject()));

	const atlasKey = (key: string) => {
		const current = atlas();
		return current === undefined ? undefined : findAtlasKey(current, key);
	};
	const isBound = (key: string): boolean => (atlasKey(key)?.claims.length ?? 0) > 0;
	const isContested = (key: string): boolean => atlasKey(key)?.contested === true;
	const isSelected = (key: string): boolean => selectedKey() === key;

	function Cap(props: { readonly cap: KeyboardCap }) {
		return (
			<button
				type="button"
				title={props.cap.key}
				onClick={() => setSelectedKey(props.cap.key)}
				{...stylex.props(
					styles.cap,
					isBound(props.cap.key) && styles.capBound,
					isContested(props.cap.key) && styles.capContested,
					isSelected(props.cap.key) && styles.capSelected
				)}
				style={{ "min-width": `${(props.cap.span ?? 1) * 26 + 6}px` }}
			>
				{capLabel(props.cap.key)}
			</button>
		);
	}

	function KeyboardCell(props: { readonly cell: KeyboardCell }) {
		return isKeyboardCap(props.cell) ? (
			<Cap cap={props.cell} />
		) : (
			<span
				aria-hidden="true"
				{...stylex.props(styles.keyGap)}
				style={{ width: `${props.cell.gap * 26 + 6}px` }}
			/>
		);
	}

	return (
		<section {...stylex.props(styles.page)}>
			<PageHeader
				eyebrow="Input Atlas · saved Enhanced Input packages"
				actions={
					<>
						<Button
							tone="quiet"
							disabled={state().status === "loading"}
							onClick={() => run(() => props.client.loadConfiguredProject())}
						>
							Rescan
						</Button>
						<Button
							tone="primary"
							disabled={state().status === "loading"}
							onClick={() => run(() => props.client.chooseProjectAndScan())}
						>
							Choose project…
						</Button>
					</>
				}
			/>

			<Show when={activeProject()}>
				{(project) => (
					<div {...stylex.props(styles.projectBanner)}>
						<span {...stylex.props(styles.projectDot)} />
						<span {...stylex.props(styles.projectName)}>{projectName(project())}</span>
						<span {...stylex.props(styles.projectPath)}>{project()}</span>
					</div>
				)}
			</Show>

			<Show when={state().status === "loading"}>
				<div {...stylex.props(styles.progressTrack)} role="progressbar" aria-busy="true">
					<span {...stylex.props(styles.progressBar)} />
				</div>
			</Show>

			<Switch>
				<Match when={state().status === "loading"}>
					<p {...stylex.props(styles.notice)}>
						{activeProject() === undefined
							? "Scanning saved packages…"
							: `Rescanning ${projectName(activeProject()!)}…`}
					</p>
				</Match>
				<Match when={state().status === "not_configured"}>
					<p {...stylex.props(styles.notice)}>
						No project configured. Choose an Unreal project to scan its mapping
						contexts.
					</p>
				</Match>
				<Match when={state().status === "cancelled"}>
					<p {...stylex.props(styles.notice)}>Scan cancelled.</p>
				</Match>
				<Match when={state().status === "failed"}>
					<Show when={state()} keyed>
						{(current) => (
							<div {...stylex.props(styles.error)}>
								<strong>
									{current.status === "failed" ? current.error.code : ""}
								</strong>
								<p>{current.status === "failed" ? current.error.message : ""}</p>
								<p {...stylex.props(styles.recovery)}>
									{current.status === "failed" ? current.error.recovery : ""}
								</p>
							</div>
						)}
					</Show>
				</Match>
				<Match when={atlas()}>
					{(current) => (
						<>
							<div {...stylex.props(styles.toolbar)}>
								<For each={fullAtlas()?.contexts ?? []}>
									{(context) => (
										<button
											type="button"
											aria-pressed={isContextSelected(context.objectPath)}
											title={context.description ?? context.objectPath}
											onClick={() => toggleContext(context.objectPath)}
											{...stylex.props(
												styles.contextChip,
												isContextSelected(context.objectPath) &&
													styles.contextChipOn
											)}
										>
											{context.name}
											<span {...stylex.props(styles.chipCount)}>
												{context.mappings}
											</span>
										</button>
									)}
								</For>
								<button
									type="button"
									title="Invert which mapping contexts are selected"
									onClick={invertContexts}
									{...stylex.props(styles.contextChip)}
								>
									Invert
								</button>
								<span {...stylex.props(styles.spacer)} />
								<Show
									when={current().contestedKeys.length > 0}
									fallback={
										<span {...stylex.props(styles.chipQuiet)}>
											no contested keys
										</span>
									}
								>
									<span {...stylex.props(styles.chipContested)}>
										{current().contestedKeys.length} contested
									</span>
								</Show>
								<Show when={current().unreadableMappings > 0}>
									<span {...stylex.props(styles.chipQuiet)}>
										{current().unreadableMappings} key(s) not serialized
									</span>
								</Show>
							</div>

							<div {...stylex.props(styles.devices)}>
								<div {...stylex.props(styles.device)}>
									<svg
										viewBox={GAMEPAD_VIEWBOX}
										role="img"
										{...stylex.props(styles.pad)}
									>
										<title>Gamepad keys claimed by the enabled contexts</title>
										<path d={GAMEPAD_BODY} {...stylex.props(styles.padBody)} />
										<For each={gamepadControls}>
											{(control) => (
												<g
													role="button"
													aria-label={control.key}
													onClick={() => setSelectedKey(control.key)}
													{...stylex.props(styles.hit)}
												>
													{control.shape === "pad" ? (
														<rect
															x={control.x}
															y={control.y}
															width={control.width}
															height={control.height}
															rx={4}
															{...stylex.props(
																styles.control,
																isBound(control.key) &&
																	styles.controlBound,
																isContested(control.key) &&
																	styles.controlContested,
																isSelected(control.key) &&
																	styles.controlSelected
															)}
														/>
													) : (
														<circle
															cx={control.cx}
															cy={control.cy}
															r={
																control.shape === "stick"
																	? STICK_RADIUS
																	: FACE_RADIUS
															}
															{...stylex.props(
																styles.control,
																isBound(control.key) &&
																	styles.controlBound,
																isContested(control.key) &&
																	styles.controlContested,
																isSelected(control.key) &&
																	styles.controlSelected
															)}
														/>
													)}
													<text
														x={
															control.shape === "pad"
																? control.x + control.width / 2
																: control.cx
														}
														y={
															control.shape === "pad"
																? control.y + control.height / 2
																: control.cy
														}
														{...stylex.props(
															styles.controlLabel,
															isBound(control.key) &&
																styles.controlLabelBound
														)}
													>
														{capLabel(control.key)}
													</text>
												</g>
											)}
										</For>
									</svg>
								</div>

								<div {...stylex.props(styles.device, styles.keyboardDevice)}>
									<For each={keyboardRows}>
										{(row) => (
											<div {...stylex.props(styles.keyboardRow)}>
												<For each={row}>
													{(cell) => <KeyboardCell cell={cell} />}
												</For>
											</div>
										)}
									</For>
									<div {...stylex.props(styles.keyRow)}>
										<For each={mouseCaps}>{(cap) => <Cap cap={cap} />}</For>
									</div>
									<Show when={unplacedKeys(current()).length > 0}>
										<div {...stylex.props(styles.otherKeys)}>
											<span {...stylex.props(styles.otherLabel)}>
												Bound, not on the diagram
											</span>
											<div {...stylex.props(styles.keyRow)}>
												<For each={unplacedKeys(current())}>
													{(entry) => <Cap cap={{ key: entry.key }} />}
												</For>
											</div>
										</div>
									</Show>
								</div>
							</div>

							<KeyDetail selected={selected()} selectedKey={selectedKey()} />

							<p {...stylex.props(styles.footer)}>
								{report()?.coverage.mappingContexts} mapping context(s) and{" "}
								{report()?.coverage.inputActions} action(s) across{" "}
								{report()?.coverage.inspectedPackages} inspected package(s). Read
								from saved packages — no editor, no play session.
							</p>
						</>
					)}
				</Match>
			</Switch>
		</section>
	);
}

function KeyDetail(props: {
	readonly selected: AtlasKey | undefined;
	readonly selectedKey: string | null;
}) {
	// A key with no claim is absent from the atlas entirely, so the detail falls back to the
	// selected name: "nothing binds this" is an answer, not an empty panel.
	const claims = () => props.selected?.claims ?? [];
	return (
		<div {...stylex.props(styles.detail)}>
			<Show
				when={props.selectedKey}
				fallback={
					<p {...stylex.props(styles.detailEmpty)}>
						Pick a key to see every context that claims it.
					</p>
				}
			>
				{(key) => (
					<>
						<div {...stylex.props(styles.detailHead)}>
							<span {...stylex.props(styles.detailKey)}>{key()}</span>
							<span {...stylex.props(styles.detailDevice)}>
								{props.selected?.device ?? deviceOf(key())}
							</span>
							<Show when={props.selected?.contested === true}>
								<span {...stylex.props(styles.chipContested)}>
									claimed by {claims().length} contexts
								</span>
							</Show>
						</div>
						<Show
							when={claims().length > 0}
							fallback={
								<p {...stylex.props(styles.detailEmpty)}>
									Unbound in every enabled context.
								</p>
							}
						>
							<For each={claims()}>
								{(claim) => (
									<div {...stylex.props(styles.claim)}>
										<span {...stylex.props(styles.claimContext)}>
											{claim.contextName}
										</span>
										<span {...stylex.props(styles.claimAction)}>
											{claim.actionName ?? "no action"}
										</span>
										<span {...stylex.props(styles.claimTags)}>
											<For each={claim.triggers}>
												{(trigger) => (
													<span {...stylex.props(styles.tag)}>
														{trigger}
													</span>
												)}
											</For>
											<Show when={claim.triggers.length === 0}>
												{/* Unreal fires an untriggered mapping on Down,
												    but nothing said so in the package. */}
												<span
													title="No trigger serialized on this mapping"
													{...stylex.props(styles.tagQuiet)}
												>
													no trigger
												</span>
											</Show>
											<For each={claim.modifiers}>
												{(modifier) => (
													<span {...stylex.props(styles.tagQuiet)}>
														{modifier}
													</span>
												)}
											</For>
										</span>
										<span {...stylex.props(styles.claimText)}>
											{claim.actionDescription ?? ""}
										</span>
									</div>
								)}
							</For>
						</Show>
					</>
				)}
			</Show>
		</div>
	);
}

const styles = stylex.create({
	page: { display: "flex", flexDirection: "column", padding: 20 },
	notice: { color: tokens.colorTextMuted, fontSize: 12 },
	projectBanner: {
		alignItems: "center",
		display: "flex",
		gap: 8,
		flexWrap: "wrap",
		marginTop: 6,
		marginBottom: 2
	},
	projectDot: {
		backgroundColor: tokens.colorAccent,
		borderRadius: "50%",
		flexShrink: 0,
		height: 7,
		width: 7
	},
	projectName: { color: tokens.colorTextStrong, fontSize: 13, fontWeight: 700 },
	projectPath: { color: tokens.colorTextFaint, fontSize: 10, overflowWrap: "anywhere" },
	progressTrack: {
		backgroundColor: tokens.colorSurfaceInset,
		borderRadius: tokens.radiusControl,
		height: 3,
		marginTop: 8,
		overflow: "hidden",
		width: "100%"
	},
	progressBar: {
		animationDuration: "1.1s",
		animationIterationCount: "infinite",
		animationName: stylex.keyframes({
			from: { transform: "translateX(-100%)" },
			to: { transform: "translateX(300%)" }
		}),
		animationTimingFunction: "ease-in-out",
		backgroundColor: tokens.colorAccent,
		borderRadius: tokens.radiusControl,
		display: "block",
		height: "100%",
		width: "33%"
	},
	error: {
		borderColor: tokens.colorDanger,
		borderRadius: tokens.radiusPanel,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorText,
		fontSize: 12,
		padding: 14
	},
	recovery: { color: tokens.colorTextMuted },
	toolbar: {
		alignItems: "center",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		flexWrap: "wrap",
		gap: 6,
		paddingBottom: 10
	},
	contextChip: {
		alignItems: "center",
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextFaint,
		cursor: "pointer",
		display: "inline-flex",
		fontFamily: tokens.fontBody,
		fontSize: 10,
		gap: 6,
		padding: "4px 9px"
	},
	contextChipOn: { borderColor: tokens.colorAccent, color: tokens.colorAccent },
	chipCount: { color: tokens.colorTextFaint, fontSize: 9 },
	spacer: { flexGrow: 1 },
	chipQuiet: { color: tokens.colorTextFaint, fontSize: 9, padding: "3px 8px" },
	chipContested: {
		borderColor: tokens.colorWarning,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorWarning,
		fontSize: 9,
		padding: "3px 8px"
	},
	devices: { display: "flex", flexWrap: "wrap", gap: 20, padding: "16px 0" },
	device: {
		display: "flex",
		flexDirection: "column",
		flexGrow: 1,
		gap: 4,
		justifyContent: "center",
		minWidth: 250
	},
	keyboardDevice: { minWidth: 0, overflowX: "auto" },
	pad: { display: "block", height: "auto", maxWidth: 380, width: "100%" },
	padBody: { fill: tokens.colorSurface, stroke: tokens.colorBorder, strokeWidth: 1.5 },
	hit: { cursor: "pointer" },
	control: {
		fill: tokens.colorSurfaceInset,
		stroke: tokens.colorBorderStrong,
		strokeWidth: 1
	},
	controlBound: { fill: tokens.colorAccent, stroke: tokens.colorAccent },
	controlContested: { fill: tokens.colorWarning, stroke: tokens.colorWarningStrong },
	controlSelected: { stroke: tokens.colorTextStrong, strokeWidth: 2 },
	controlLabel: {
		dominantBaseline: "central",
		fill: tokens.colorTextFaint,
		fontFamily: tokens.fontBody,
		fontSize: 9,
		pointerEvents: "none",
		textAnchor: "middle"
	},
	controlLabelBound: { fill: tokens.colorAccentText },
	keyRow: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 },
	keyboardRow: { display: "flex", flexWrap: "nowrap", gap: 4, marginBottom: 4, minWidth: 840 },
	keyGap: { display: "block", flex: "0 0 auto" },
	cap: {
		backgroundColor: { default: tokens.colorSurfaceInset, ":hover": tokens.colorSurfaceHover },
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextFaint,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 10,
		padding: "8px 6px"
	},
	capBound: {
		backgroundColor: tokens.colorAccent,
		borderColor: tokens.colorAccent,
		color: tokens.colorAccentText
	},
	capContested: {
		backgroundColor: tokens.colorWarning,
		borderColor: tokens.colorWarningStrong,
		color: tokens.colorAccentText
	},
	capSelected: { borderColor: tokens.colorTextStrong },
	otherKeys: { display: "flex", flexDirection: "column", gap: 4, marginTop: 8 },
	otherLabel: {
		color: tokens.colorTextFaint,
		fontSize: 9,
		letterSpacing: ".14em",
		textTransform: "uppercase"
	},
	detail: {
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		display: "flex",
		flexDirection: "column",
		gap: 5,
		minHeight: 90,
		paddingTop: 12
	},
	detailHead: { alignItems: "center", display: "flex", gap: 8, marginBottom: 2 },
	detailKey: { color: tokens.colorTextStrong, fontSize: 12, fontWeight: 700 },
	detailDevice: {
		color: tokens.colorTextFaint,
		fontSize: 9,
		letterSpacing: ".14em",
		textTransform: "uppercase"
	},
	detailEmpty: { color: tokens.colorTextFaint, fontSize: 10, margin: 0 },
	claim: { alignItems: "baseline", display: "flex", flexWrap: "wrap", fontSize: 11, gap: 10 },
	claimContext: { color: tokens.colorTextMuted, minWidth: 130 },
	claimAction: { color: tokens.colorTextStrong, minWidth: 130 },
	claimTags: { display: "flex", flexWrap: "wrap", gap: 4 },
	tag: {
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextSubtle,
		fontSize: 9,
		padding: "1px 6px"
	},
	tagQuiet: {
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextFaint,
		fontSize: 9,
		padding: "1px 6px"
	},
	claimText: { color: tokens.colorTextFaint },
	footer: { color: tokens.colorTextFaint, fontSize: 10, marginTop: 12 }
});
