import * as stylex from "@stylexjs/stylex";
import type { EditorPlaySessionCommand } from "@ue-shed/protocol";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Exit } from "effect";
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import type { WorkbenchRendererClient } from "./workbench-client.js";
import {
	editorSessionTransportActions,
	editorSessionTransportLabel,
	parseRemoteControlPort,
	type EditorSessionTransportState
} from "./editor-session-transport-model.js";

const remoteControlPortStorageKey = "ue-shed.remote-control-port";

export function EditorSessionTransport(props: { readonly client: WorkbenchRendererClient }) {
	const action = createEffectAction();
	const settingsAction = createEffectAction();
	const subscription = createEffectSubscription();
	const [state, setState] = createSignal<EditorSessionTransportState>({ status: "offline" });
	const [pending, setPending] = createSignal(false);
	const [settingsPending, setSettingsPending] = createSignal(false);
	const [message, setMessage] = createSignal<string>();
	const [port, setPort] = createSignal<number>();
	const [portDraft, setPortDraft] = createSignal("");
	const [portMessage, setPortMessage] = createSignal<string>();
	const actions = createMemo(() => editorSessionTransportActions(state()));

	const applyPort = (nextPort: number, persist: boolean) => {
		setSettingsPending(true);
		setPortMessage(undefined);
		settingsAction.run(props.client.setUnrealConnectionPort(nextPort), {
			onFailure: () => {
				setSettingsPending(false);
				setPortMessage("Could not change the monitored port.");
			},
			onSuccess: (settings) => {
				setSettingsPending(false);
				setPort(settings.port);
				setPortDraft(String(settings.port));
				setState({ status: "offline" });
				if (persist) {
					try {
						window.localStorage.setItem(
							remoteControlPortStorageKey,
							String(settings.port)
						);
					} catch {
						setPortMessage("Port changed for this run, but could not be saved.");
					}
				}
			}
		});
	};

	onMount(() => {
		subscription.subscribe(props.client.editorSessionStatuses, {
			onValue: (exit) => {
				if (Exit.isSuccess(exit)) {
					setState(exit.value.state);
					setMessage(undefined);
				} else {
					setState({ status: "offline" });
				}
			}
		});
		settingsAction.run(props.client.unrealConnectionSettings(), {
			onSuccess: (settings) => {
				setPort(settings.port);
				setPortDraft(String(settings.port));
				try {
					const storedPort = parseRemoteControlPort(
						window.localStorage.getItem(remoteControlPortStorageKey) ?? ""
					);
					if (storedPort !== undefined && storedPort !== settings.port) {
						applyPort(storedPort, false);
					}
				} catch {
					// Storage is optional; the process-level setting remains usable for this run.
				}
			}
		});
	});

	const submitPort = (event: SubmitEvent) => {
		event.preventDefault();
		const nextPort = parseRemoteControlPort(portDraft());
		if (nextPort === undefined) {
			setPortMessage("Enter a whole-number port from 1 to 65535.");
			return;
		}
		applyPort(nextPort, true);
	};

	const execute = (command: EditorPlaySessionCommand) => {
		setPending(true);
		setMessage(undefined);
		action.run(props.client.executeEditorSessionCommand(command), {
			onFailure: () => {
				setPending(false);
				setMessage("COMMAND FAILED");
			},
			onSuccess: (result) => {
				setPending(false);
				setState(result.state);
				setMessage(result.outcome === "rejected" ? result.message : undefined);
			}
		});
	};

	return (
		<section
			aria-label="Editor play session"
			title={message()}
			{...stylex.props(styles.transport)}
		>
			<span
				aria-hidden="true"
				{...stylex.props(
					styles.lamp,
					state().status === "running" && styles.live,
					state().status === "paused" && styles.paused
				)}
			/>
			<span {...stylex.props(styles.label)}>{editorSessionTransportLabel(state())}</span>
			<details {...stylex.props(styles.settings)}>
				<summary
					aria-label="Change Unreal session monitor port"
					title="Unreal session monitor port"
					{...stylex.props(styles.settingsSummary)}
				>
					:{port() ?? "—"}
				</summary>
				<div {...stylex.props(styles.settingsPanel)}>
					<strong {...stylex.props(styles.settingsTitle)}>SESSION MONITOR PORT</strong>
					<p {...stylex.props(styles.settingsDetail)}>
						Workbench will immediately monitor this port for an Unreal Editor session.
					</p>
					<form onSubmit={submitPort} {...stylex.props(styles.portForm)}>
						<input
							type="number"
							aria-label="Remote Control port"
							min="1"
							max="65535"
							step="1"
							value={portDraft()}
							onInput={(event) => setPortDraft(event.currentTarget.value)}
							{...stylex.props(styles.portInput)}
						/>
						<button
							type="submit"
							disabled={settingsPending()}
							{...stylex.props(styles.applyButton)}
						>
							{settingsPending() ? "APPLYING…" : "APPLY"}
						</button>
					</form>
					<Show when={portMessage()} keyed>
						{(detail) => (
							<span role="alert" {...stylex.props(styles.portMessage)}>
								{detail}
							</span>
						)}
					</Show>
					<small {...stylex.props(styles.storageNote)}>Saved on this device.</small>
				</div>
			</details>
			<div {...stylex.props(styles.actions)}>
				<For each={actions()}>
					{(item) => (
						<button
							type="button"
							disabled={pending()}
							onClick={() => execute(item.command)}
							{...stylex.props(styles.button, item.primary && styles.primary)}
						>
							{item.label}
						</button>
					)}
				</For>
			</div>
		</section>
	);
}

const styles = stylex.create({
	transport: {
		marginLeft: "auto",
		height: "100%",
		display: "flex",
		alignItems: "center",
		gap: 7,
		padding: "0 10px",
		borderLeft: `1px solid ${tokens.colorBorder}`,
		borderRight: `1px solid ${tokens.colorBorder}`
	},
	lamp: { width: 6, height: 6, borderRadius: "50%", backgroundColor: "#59615b" },
	live: { backgroundColor: tokens.colorAccent, boxShadow: "0 0 8px #b8ff5566" },
	paused: { backgroundColor: "#d89a53", boxShadow: "0 0 8px #d89a5355" },
	label: {
		minWidth: 78,
		color: tokens.colorTextSubtle,
		fontSize: 8,
		letterSpacing: ".09em",
		whiteSpace: "nowrap"
	},
	settings: { position: "relative" },
	settingsSummary: {
		padding: "5px 4px",
		color: { default: "#79827c", ":hover": tokens.colorAccent },
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 8,
		letterSpacing: ".04em",
		listStyle: "none",
		whiteSpace: "nowrap"
	},
	settingsPanel: {
		position: "absolute",
		right: 0,
		top: "calc(100% + 13px)",
		zIndex: 40,
		width: 286,
		padding: 14,
		border: `1px solid ${tokens.colorBorder}`,
		borderTopColor: tokens.colorAccent,
		backgroundColor: "#121614",
		boxShadow: "0 16px 38px #00000088"
	},
	settingsTitle: {
		color: tokens.colorText,
		fontSize: 9,
		letterSpacing: ".12em"
	},
	settingsDetail: {
		margin: "7px 0 11px",
		color: tokens.colorTextSubtle,
		fontSize: 9,
		lineHeight: 1.5
	},
	portForm: { display: "grid", gridTemplateColumns: "1fr auto", gap: 6 },
	portInput: {
		minWidth: 0,
		height: 30,
		padding: "0 9px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#0b0e0c",
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 11,
		outlineColor: tokens.colorAccent
	},
	applyButton: {
		height: 30,
		padding: "0 10px",
		border: `1px solid ${tokens.colorAccent}`,
		backgroundColor: { default: "#19220d", ":hover": "#273713" },
		color: tokens.colorAccent,
		cursor: { default: "pointer", ":disabled": "wait" },
		fontFamily: tokens.fontBody,
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".08em"
	},
	portMessage: {
		display: "block",
		marginTop: 8,
		color: "#f1b8ad",
		fontSize: 8,
		lineHeight: 1.4
	},
	storageNote: {
		display: "block",
		marginTop: 9,
		color: "#667068",
		fontSize: 8
	},
	actions: { display: "flex", gap: 3 },
	button: {
		minWidth: 42,
		height: 24,
		padding: "0 7px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "#242a26" },
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontBody,
		fontSize: 8,
		letterSpacing: ".08em",
		cursor: { default: "pointer", ":disabled": "wait" },
		opacity: { default: 1, ":disabled": 0.45 }
	},
	primary: {
		borderColor: tokens.colorAccent,
		color: tokens.colorAccent
	}
});
