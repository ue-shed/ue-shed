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
				setMessage("Command failed");
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
					<strong {...stylex.props(styles.settingsTitle)}>Session monitor port</strong>
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
							{settingsPending() ? "Applying…" : "Apply"}
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
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: 8,
		width: "100%"
	},
	lamp: { width: 6, height: 6, borderRadius: "50%", backgroundColor: "#383b3f" },
	live: { backgroundColor: tokens.colorSuccess, boxShadow: "0 0 8px rgba(76, 183, 130, 0.4)" },
	paused: {
		backgroundColor: tokens.colorWarning,
		boxShadow: "0 0 8px rgba(242, 153, 74, 0.3)"
	},
	label: {
		minWidth: 78,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500,
		whiteSpace: "nowrap"
	},
	settings: { position: "relative" },
	settingsSummary: {
		padding: "4px 6px",
		borderRadius: tokens.radiusBadge,
		color: { default: tokens.colorTextMuted, ":hover": tokens.colorTextStrong },
		cursor: "pointer",
		fontFamily: tokens.fontMono,
		fontSize: 11,
		listStyle: "none",
		whiteSpace: "nowrap"
	},
	settingsPanel: {
		position: "absolute",
		right: 0,
		top: "calc(100% + 14px)",
		zIndex: 40,
		width: 300,
		padding: 16,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: tokens.shadowOverlay
	},
	settingsTitle: {
		color: tokens.colorTextStrong,
		fontSize: 12,
		fontWeight: 590,
		letterSpacing: "-0.005em"
	},
	settingsDetail: {
		margin: "8px 0 12px",
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.55
	},
	portForm: { display: "grid", gridTemplateColumns: "1fr auto", gap: 8 },
	portInput: {
		minWidth: 0,
		height: 30,
		padding: "0 10px",
		borderColor: { default: tokens.colorBorderStrong, ":focus": tokens.colorTextSubtle },
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontMono,
		fontSize: 12,
		outline: "none"
	},
	applyButton: {
		height: 30,
		padding: "0 12px",
		borderColor: { default: tokens.colorBorderStrong, ":hover": "#4a4e54" },
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.04)",
			":active": "rgba(255, 255, 255, 0.08)"
		},
		color: tokens.colorText,
		cursor: { default: "pointer", ":disabled": "wait" },
		fontSize: 12,
		fontWeight: 500
	},
	portMessage: {
		display: "block",
		marginTop: 8,
		color: "#f2a9a1",
		fontSize: 11,
		lineHeight: 1.45
	},
	storageNote: {
		display: "block",
		marginTop: 10,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	actions: { display: "flex", gap: 4, width: "100%" },
	button: {
		minWidth: 42,
		height: 26,
		padding: "0 9px",
		borderColor: { default: tokens.colorBorder, ":hover": tokens.colorBorderStrong },
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: { default: tokens.colorTextMuted, ":hover": tokens.colorText },
		fontFamily: tokens.fontBody,
		fontSize: 11,
		fontWeight: 500,
		cursor: { default: "pointer", ":disabled": "wait" },
		opacity: { default: 1, ":disabled": 0.45 }
	},
	primary: {
		borderColor: "rgba(228, 242, 34, 0.45)",
		color: tokens.colorAccent,
		":hover": {
			backgroundColor: tokens.colorAccentWash,
			borderColor: "rgba(228, 242, 34, 0.7)",
			color: tokens.colorAccent
		}
	}
});
