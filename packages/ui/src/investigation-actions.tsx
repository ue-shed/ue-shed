import * as stylex from "@stylexjs/stylex";
import { Effect } from "effect";
import { Show, createSignal } from "solid-js";
import { createEffectAction } from "./effect-solid.js";
import { Button } from "./button.js";

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
	readonly onOpen: (preset: Preset) => void;
}) {
	const action = createEffectAction();
	const [pending, setPending] = createSignal(false);
	const [message, setMessage] = createSignal("");
	const [saved, setSaved] = createSignal<{ readonly key: string; readonly command: string }>();
	const key = () => JSON.stringify([props.query, props.revision]);
	const replay = () => (saved()?.key === key() ? saved()?.command : undefined);
	const run = (operation: "json" | "csv" | "save" | "open") => {
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
					setMessage(
						operation === "save"
							? `Saved preset: ${result.path}`
							: `Exported ${result.rowCount.toLocaleString()} matching results: ${result.path}`
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
		<section aria-label="Investigation files" {...stylex.props(styles.panel)}>
			<div {...stylex.props(styles.actions)}>
				<Button
					type="button"
					disabled={pending() || props.disabled}
					onClick={() => run("json")}
				>
					Export JSON
				</Button>
				<Button
					type="button"
					disabled={pending() || props.disabled}
					onClick={() => run("csv")}
				>
					Export CSV
				</Button>
				<Button
					type="button"
					disabled={pending() || props.disabled}
					onClick={() => run("save")}
				>
					Save preset
				</Button>
				<Button type="button" disabled={pending()} onClick={() => run("open")}>
					Open preset
				</Button>
				<Show when={replay()}>
					<Button type="button" disabled={pending()} onClick={copy}>
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
						<code {...stylex.props(styles.command)}>{command()}</code>
					</details>
				)}
			</Show>
		</section>
	);
}

const styles = stylex.create({
	panel: { display: "flex", flexDirection: "column", gap: 8, paddingBlock: 12, fontSize: 12 },
	actions: { display: "flex", flexWrap: "wrap", gap: 8 },
	command: { display: "block", whiteSpace: "pre-wrap", overflowWrap: "anywhere", paddingBlock: 8 }
});
