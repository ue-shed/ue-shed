import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Effect } from "effect";
import { Show, createSignal, createUniqueId } from "solid-js";
import { createEffectAction } from "./effect-solid.js";
import { Button } from "./button.js";
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
		readonly open: () => Effect.Effect<OpenFeedback<Preset>, Error>;
	};
	readonly query: Query;
	readonly revision: unknown;
	readonly disabled: boolean;
	/** Block every action while the host has an exclusive project operation. */
	readonly blocked?: boolean;
	readonly onOpen: (preset: Preset) => void;
	readonly compact?: boolean;
}) {
	const action = createEffectAction();
	const exportId = createUniqueId();
	const presetId = createUniqueId();
	const [exportOpen, setExportOpen] = createSignal(false);
	const [presetOpen, setPresetOpen] = createSignal(false);
	const [pending, setPending] = createSignal(false);
	const [message, setMessage] = createSignal("");
	const [saved, setSaved] = createSignal<{ readonly key: string; readonly command: string }>();
	const key = () => JSON.stringify([props.query, props.revision]);
	const replay = () => (saved()?.key === key() ? saved()?.command : undefined);
	const run = (operation: "json" | "csv" | "save" | "open") => {
		if (props.blocked) return;
		setExportOpen(false);
		setPresetOpen(false);
		const baseline = key();
		setPending(true);
		setMessage("");
		const task: Effect.Effect<FileFeedback | OpenFeedback<Preset>, Error> =
			operation === "open"
				? props.client.open()
				: operation === "save"
					? props.client.save(props.query)
					: props.client.export(props.query, operation);
		action.run(task, {
			onFailure: (cause) => {
				setPending(false);
				setMessage(`File operation failed: ${String(cause)}`);
			},
			onSuccess: (result) => {
				setPending(false);
				if (result.status === "cancelled") {
					setMessage("Cancelled.");
					return;
				}
				if (result.status === "failed") {
					setMessage(`${result.message} ${result.recovery}`);
					return;
				}
				if (result.status === "opened") {
					setSaved(undefined);
					props.onOpen(result.preset);
					setMessage(`Opened ${result.path}`);
				} else {
					if (result.replayCommand)
						setSaved({ key: baseline, command: result.replayCommand });
					const count = result.rowCount.toLocaleString();
					const noun = result.rowCount === 1 ? "result" : "results";
					setMessage(
						operation === "save"
							? `Saved preset: ${result.path}`
							: `Exported ${count} matching ${noun}: ${result.path}`
					);
				}
			}
		});
	};
	const copy = () => {
		const command = replay();
		if (!command) return;
		action.run(
			Effect.tryPromise({ try: () => navigator.clipboard.writeText(command), catch: String }),
			{
				onSuccess: () => setMessage("PowerShell replay command copied."),
				onFailure: () => setMessage("Could not copy. Select and copy the command below.")
			}
		);
	};
	return (
		<section
			aria-label="Investigation files"
			{...stylex.attrs(styles.panel, props.compact && styles.compact)}
		>
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
								onClick={() => run("open")}
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
							<Button
								{...triggerProps}
								type="button"
								size="compact"
								tone="quiet"
								disabled={pending() || props.disabled || props.blocked}
							>
								Export
							</Button>
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
					</AnchoredPopover>
					<AnchoredPopover
						id={presetId}
						ariaLabel="Investigation presets"
						open={presetOpen()}
						onOpenChange={setPresetOpen}
						placement="bottom-end"
						style={styles.menu}
						trigger={(triggerProps) => (
							<Button
								{...triggerProps}
								type="button"
								size="compact"
								tone="quiet"
								disabled={pending() || props.blocked}
							>
								Presets
							</Button>
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
							onClick={() => run("open")}
						>
							Open preset…
						</Button>
					</AnchoredPopover>
				</Show>
				<Show when={replay()}>
					<Button
						type="button"
						size={props.compact ? "compact" : undefined}
						disabled={pending() || props.blocked}
						onClick={copy}
					>
						Copy CLI replay
					</Button>
				</Show>
			</div>
			<Show when={pending()}>
				<span role="status">Working…</span>
			</Show>
			<Show when={message()}>
				<span role="status">{message()}</span>
			</Show>
			<Show when={replay()}>
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
	compact: { paddingBlock: 0 },
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
