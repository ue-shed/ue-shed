import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Effect } from "effect";
import { Show, createSignal, createUniqueId } from "solid-js";
import { createEffectAction } from "./effect-solid.js";
import { Button } from "./button.js";
import { ToolButton } from "./tool-button.js";
import { ToolIcon } from "./tool-icon.js";
import { AnchoredPopover } from "./anchored-popover.js";

type FileFeedback =
	| {
			readonly status: "saved";
			readonly path: string;
			readonly rowCount: number;
			readonly replayCommand?: string;
	  }
	| { readonly status: "failed"; readonly message: string; readonly recovery: string }
	| { readonly status: "cancelled" };
type Notice = { readonly tone: "status" | "alert"; readonly text: string };
type OpenFeedback<Preset> =
	| Exclude<FileFeedback, { readonly status: "saved" }>
	| { readonly status: "opened"; readonly preset: Preset; readonly path: string };

/** A file toolbar whose host owns dialogs and serialization. */
export function InvestigationActions<Query, Preset, Error>(props: {
	readonly client: {
		readonly export: (
			query: Query,
			format: "json" | "csv"
		) => Effect.Effect<FileFeedback, Error>;
		readonly save: (query: Query) => Effect.Effect<FileFeedback, Error>;
		readonly open: Effect.Effect<OpenFeedback<Preset>, Error>;
	};
	readonly query: Query;
	readonly revision: unknown;
	readonly disabled: boolean;
	/** Block every action while the host has an exclusive project operation. */
	readonly blocked?: boolean;
	/** Shows an opened preset; answers why when the view can't show it. */
	readonly onOpen: (preset: Preset) => string | undefined;
	readonly onRequestOpen?: (open: () => void) => void;
	readonly disabledReason?: string | undefined;
	readonly compact?: boolean;
	/** Compact tools show "Export" and "Presets" beside their icons, for toolbars whose commands are all named. */
	readonly showLabels?: boolean;
	/** A host-specific export offered beside CSV and JSON, such as one file for every language. */
	readonly extraExport?:
		| {
				readonly label: string;
				readonly run: () => Effect.Effect<FileFeedback, Error>;
		  }
		| undefined;
}) {
	const action = createEffectAction();
	const expiry = createEffectAction();
	const exportId = createUniqueId();
	const presetId = createUniqueId();
	const [exportOpen, setExportOpen] = createSignal(false);
	const [presetOpen, setPresetOpen] = createSignal(false);
	const [pending, setPending] = createSignal(false);
	const [notice, setNoticeState] = createSignal<Notice>();
	// Results are transient: a status clears itself, while a failure stays until the next action.
	const setNotice = (next: Notice | undefined) => {
		expiry.cancel();
		setNoticeState(next);
		if (next?.tone === "status")
			expiry.run(Effect.sleep("8 seconds"), { onSuccess: () => setNoticeState(undefined) });
	};
	const status = (text: string) => setNotice({ tone: "status", text });
	const alert = (text: string) => setNotice({ tone: "alert", text });
	const [saved, setSaved] = createSignal<{ readonly key: string; readonly command: string }>();
	const key = () => JSON.stringify([props.query, props.revision]);
	const replay = () => (saved()?.key === key() ? saved()?.command : undefined);
	const run = (operation: "json" | "csv" | "save" | "open" | "extra") => {
		if (props.blocked) return;
		setExportOpen(false);
		setPresetOpen(false);
		const baseline = key();
		setPending(true);
		setNotice(undefined);
		const task: Effect.Effect<FileFeedback | OpenFeedback<Preset>, Error> =
			operation === "open"
				? props.client.open
				: operation === "save"
					? props.client.save(props.query)
					: operation === "extra"
						? (props.extraExport?.run() ??
							Effect.succeed({ status: "cancelled" as const }))
						: props.client.export(props.query, operation);
		action.run(task, {
			onFailure: (cause) => {
				setPending(false);
				alert(`File operation failed: ${String(cause)}`);
			},
			onSuccess: (result) => {
				setPending(false);
				if (result.status === "cancelled") {
					status("Cancelled.");
					return;
				}
				if (result.status === "failed") {
					alert(`${result.message} ${result.recovery}`);
					return;
				}
				if (result.status === "opened") {
					setSaved(undefined);
					const refused = props.onOpen(result.preset);
					if (refused === undefined) status(`Opened ${result.path}`);
					else alert(refused);
				} else {
					if (result.replayCommand)
						setSaved({ key: baseline, command: result.replayCommand });
					const count = result.rowCount.toLocaleString();
					const noun = result.rowCount === 1 ? "row" : "rows";
					status(
						operation === "save"
							? `Saved preset: ${result.path}`
							: `Exported ${count} ${noun}: ${result.path}`
					);
				}
			}
		});
	};
	const requestOpen = () => {
		if (props.onRequestOpen) props.onRequestOpen(() => run("open"));
		else run("open");
	};
	const copy = () => {
		const command = replay();
		if (!command) return;
		action.run(
			Effect.tryPromise({ try: () => navigator.clipboard.writeText(command), catch: String }),
			{
				onSuccess: () => status("PowerShell replay command copied."),
				onFailure: () =>
					alert(
						props.compact
							? "Could not copy. Open Presets to select the command."
							: "Could not copy. Select and copy the command below."
					)
			}
		);
	};
	return (
		<section
			aria-label="Investigation files"
			{...stylex.attrs(styles.panel, props.compact && styles.compact)}
		>
			{/* Compact tools explain a disabled export in its tooltip instead of shifting the bar. */}
			<Show when={!props.compact && props.disabled && props.disabledReason}>
				<span role="note">{props.disabledReason}</span>
			</Show>
			<div {...stylex.attrs(styles.actions)}>
				<Show
					when={props.compact}
					fallback={
						<>
							<Button
								type="button"
								disabled={pending() || props.disabled || props.blocked}
								onClick={() => run("json")}
							>
								Export JSON
							</Button>
							<Button
								type="button"
								disabled={pending() || props.disabled || props.blocked}
								onClick={() => run("csv")}
							>
								Export CSV
							</Button>
							<Button
								type="button"
								disabled={pending() || props.disabled || props.blocked}
								onClick={() => run("save")}
							>
								Save preset
							</Button>
							<Button
								type="button"
								disabled={pending() || props.blocked}
								onClick={requestOpen}
							>
								Open preset
							</Button>
						</>
					}
				>
					<AnchoredPopover
						id={exportId}
						ariaLabel="Export formats"
						open={exportOpen()}
						onOpenChange={setExportOpen}
						placement="bottom-end"
						style={styles.menu}
						trigger={(triggerProps) => (
							<ToolButton
								{...triggerProps}
								label="Export"
								showLabel={props.showLabels}
								tooltip={
									props.disabled && props.disabledReason
										? props.disabledReason
										: "Export the matching results as CSV or JSON."
								}
								disabled={pending() || props.disabled || props.blocked}
							>
								<ToolIcon name="export" />
							</ToolButton>
						)}
					>
						<Button
							type="button"
							size="compact"
							tone="quiet"
							disabled={props.blocked}
							onClick={() => run("csv")}
						>
							CSV
						</Button>
						<Button
							type="button"
							size="compact"
							tone="quiet"
							disabled={props.blocked}
							onClick={() => run("json")}
						>
							JSON
						</Button>
						<Show when={props.extraExport}>
							{(extra) => (
								<Button
									type="button"
									size="compact"
									tone="quiet"
									disabled={props.blocked}
									onClick={() => run("extra")}
								>
									{extra().label}
								</Button>
							)}
						</Show>
					</AnchoredPopover>
					<AnchoredPopover
						id={presetId}
						ariaLabel="Investigation presets"
						open={presetOpen()}
						onOpenChange={setPresetOpen}
						placement="bottom-end"
						style={styles.menu}
						trigger={(triggerProps) => (
							<ToolButton
								{...triggerProps}
								label="Presets"
								showLabel={props.showLabels}
								tooltip="Save this view's filters and rules, or open a saved view."
								disabled={pending() || props.blocked}
							>
								<ToolIcon name="presets" />
							</ToolButton>
						)}
					>
						<Button
							type="button"
							size="compact"
							tone="quiet"
							disabled={props.disabled || props.blocked}
							onClick={() => run("save")}
						>
							Save preset…
						</Button>
						<Button
							type="button"
							size="compact"
							tone="quiet"
							disabled={props.blocked}
							onClick={requestOpen}
						>
							Open preset…
						</Button>
						<Show when={replay()}>
							{(command) => (
								<>
									<Button
										type="button"
										size="compact"
										tone="quiet"
										disabled={pending() || props.blocked}
										onClick={copy}
									>
										Copy CLI replay
									</Button>
									<details {...stylex.attrs(styles.menuReplay)}>
										<summary>Replay in PowerShell</summary>
										<code {...stylex.attrs(styles.command)}>{command()}</code>
									</details>
								</>
							)}
						</Show>
					</AnchoredPopover>
				</Show>
				<Show when={!props.compact && replay()}>
					<Button type="button" disabled={pending() || props.blocked} onClick={copy}>
						Copy CLI replay
					</Button>
				</Show>
			</div>
			{/*
			 * One reserved line in the full panel; a floating line under compact tools. Neither moves
			 * neighbouring content when a result arrives or clears.
			 */}
			<div
				{...stylex.attrs(
					styles.notice,
					props.compact && styles.noticeFloating,
					props.compact && (pending() || notice()) && styles.noticeBox
				)}
				title={notice()?.text}
			>
				<span role="status" {...stylex.attrs(styles.status)}>
					{pending() ? "Working…" : notice()?.tone === "status" ? notice()?.text : ""}
				</span>
				<Show when={!pending() && notice()?.tone === "alert"}>
					<span role="alert" {...stylex.attrs(styles.alert)}>
						{notice()?.text}
					</span>
					<Show when={props.compact}>
						<button
							type="button"
							aria-label="Dismiss"
							{...stylex.attrs(styles.dismiss)}
							onClick={() => setNotice(undefined)}
						>
							×
						</button>
					</Show>
				</Show>
			</div>
			<Show when={!props.compact && replay()}>
				{(command) => (
					<details>
						<summary>Replay in PowerShell</summary>
						<code {...stylex.attrs(styles.command)}>{command()}</code>
					</details>
				)}
			</Show>
		</section>
	);
}

const styles = stylex.create({
	panel: { display: "flex", flexDirection: "column", gap: 8, paddingBlock: 12, fontSize: 12 },
	compact: { position: "relative", paddingBlock: 0 },
	notice: {
		display: "flex",
		alignItems: "baseline",
		minHeight: 18,
		minWidth: 0,
		lineHeight: "18px"
	},
	noticeFloating: {
		position: "absolute",
		top: "calc(100% + 4px)",
		right: 0,
		zIndex: 10,
		width: "max-content",
		maxWidth: "min(420px, calc(100vw - 16px))",
		boxSizing: "border-box",
		minHeight: 0
	},
	noticeBox: {
		paddingBlock: 2,
		paddingInline: 8,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised
	},
	status: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: tokens.colorTextMuted
	},
	// Failures keep their recovery guidance readable rather than truncated.
	alert: { minWidth: 0, color: tokens.colorWarning },
	dismiss: {
		flexShrink: 0,
		marginLeft: 6,
		padding: 0,
		borderWidth: 0,
		backgroundColor: "transparent",
		color: tokens.colorTextMuted,
		cursor: "pointer",
		fontSize: 14,
		lineHeight: "18px"
	},
	menuReplay: { maxWidth: 360, paddingInline: 8, fontSize: 12 },
	menu: {
		display: "flex",
		flexDirection: "column",
		gap: 2,
		padding: 4,
		minWidth: 120,
		backgroundColor: tokens.colorSurfaceRaised,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
		zIndex: 20
	},
	actions: { display: "flex", flexWrap: "wrap", gap: 8 },
	command: { display: "block", whiteSpace: "pre-wrap", overflowWrap: "anywhere", paddingBlock: 8 }
});
