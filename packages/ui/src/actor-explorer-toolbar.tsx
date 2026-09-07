import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Effect } from "effect";
import { For, Show, on, createEffect, createMemo, createSignal } from "solid-js";
import type { ActorExplorerFilters, ActorExplorerItem } from "./actor-explorer-core.js";
import { Button } from "./button.js";
import { createEffectAction } from "./effect-solid.js";
import {
	actorPresetStorage,
	actorCopyDetails,
	copyActorText,
	readActorFilterPresets,
	writeActorFilterPreset,
	type ActorFilterPreset
} from "./actor-explorer-utilities.js";

export function ActorExplorerUtilities(props: {
	readonly filters: ActorExplorerFilters;
	readonly onFiltersChange: (filters: ActorExplorerFilters) => void;
	readonly selected: ActorExplorerItem | undefined;
	readonly disabled: boolean;
	readonly presetsEnabled: boolean;
	readonly singleClass: boolean;
}) {
	const action = createEffectAction();
	const copyAction = createEffectAction();
	const [presets, setPresets] = createSignal<readonly ActorFilterPreset[]>([]);
	const [name, setName] = createSignal("");
	const [message, setMessage] = createSignal("");
	const [copyValue, setCopyValue] = createSignal("");
	const [pending, setPending] = createSignal(false);
	const details = createMemo(() => (props.selected ? actorCopyDetails(props.selected) : []));
	createEffect(
		on(
			() => props.selected?.key,
			() => {
				copyAction.cancel();
				setCopyValue("");
			}
		)
	);
	const exists = () => presets().some((preset) => preset.name === name().trim());
	function load() {
		action.run(actorPresetStorage.pipe(Effect.flatMap(readActorFilterPresets)), {
			onSuccess: setPresets,
			onFailure: () =>
				setMessage("Could not read saved presets. Existing data has been preserved.")
		});
	}
	function save(remove: boolean) {
		setPending(true);
		action.run(
			actorPresetStorage.pipe(
				Effect.flatMap((storage) =>
					writeActorFilterPreset(storage, name(), remove ? undefined : props.filters)
				)
			),
			{
				onSuccess: (next) => {
					setPresets(next);
					setPending(false);
					setMessage(remove ? "Preset deleted." : "Preset saved on this device.");
					if (remove) setName("");
				},
				onFailure: () => {
					setPending(false);
					setMessage(
						"Could not save presets. Check storage availability and the preset name."
					);
				}
			}
		);
	}
	return (
		<div {...stylex.props(styles.tools)}>
			<Show when={props.presetsEnabled}>
				<details
					{...stylex.props(styles.presetMenu)}
					onToggle={(event) => {
						if (event.currentTarget.open && !pending()) load();
					}}
				>
					<summary>Filter presets</summary>
					<div {...stylex.props(styles.controls, styles.presetPanel)}>
						<select
							{...stylex.props(styles.input)}
							aria-label="Saved actor filter preset"
							disabled={props.disabled || pending()}
							value=""
							onChange={(event) => {
								const selectedName = event.currentTarget.value;
								event.currentTarget.value = "";
								const preset = presets().find(
									(entry) => entry.name === selectedName
								);
								if (!preset) return;
								if (
									props.singleClass &&
									preset.classPaths !== undefined &&
									preset.classPaths.length !== 1
								) {
									setMessage(
										"This view accepts all classes or one class. Choose another preset."
									);
									return;
								}
								props.onFiltersChange({
									query: preset.query,
									classPaths: preset.classPaths
								});
								setName(preset.name);
								setMessage(`Applied ${preset.name}.`);
							}}
						>
							<option value="">Choose preset…</option>
							<For each={presets()}>
								{(preset) => <option value={preset.name}>{preset.name}</option>}
							</For>
						</select>
						<input
							{...stylex.props(styles.input)}
							aria-label="Actor filter preset name"
							placeholder="Preset name"
							maxLength={80}
							value={name()}
							disabled={props.disabled || pending()}
							onInput={(event) => setName(event.currentTarget.value)}
						/>
						<Button
							type="button"
							disabled={props.disabled || pending() || !name().trim()}
							onClick={() => save(false)}
						>
							{exists() ? "Update preset" : "Save preset"}
						</Button>
						<Button
							type="button"
							disabled={props.disabled || pending() || !exists()}
							onClick={() => save(true)}
						>
							Delete preset
						</Button>
						<small>Shared across actor explorers on this device.</small>
					</div>
				</details>
			</Show>
			<Show when={details().length > 0}>
				<div {...stylex.props(styles.controls)} aria-label="Selected actor details">
					<span>{props.selected?.label}</span>
					<For each={details()}>
						{(detail) => (
							<Button
								type="button"
								disabled={props.disabled}
								onClick={() => {
									setCopyValue(detail.value);
									copyAction.run(copyActorText(detail.value), {
										onSuccess: () =>
											setMessage(`Copied actor ${detail.label}.`),
										onFailure: () =>
											setMessage(
												"Clipboard unavailable. Copy the value below."
											)
									});
								}}
							>
								Copy {detail.label}
							</Button>
						)}
					</For>
				</div>
			</Show>
			<Show when={message()}>
				<span role="status">{message()}</span>
			</Show>
			<Show when={copyValue()}>
				<input
					{...stylex.props(styles.input)}
					aria-label="Actor detail to copy"
					readOnly
					value={copyValue()}
					onFocus={(event) => event.currentTarget.select()}
				/>
			</Show>
		</div>
	);
}

const styles = stylex.create({
	input: {
		minWidth: 0,
		maxWidth: "100%",
		padding: "6px 8px",
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		fontSize: 12
	},
	presetMenu: { position: "relative", zIndex: 5 },
	presetPanel: {
		position: "absolute",
		top: "calc(100% + 6px)",
		left: 0,
		width: "min(280px, calc(100vw - 64px))",
		boxSizing: "border-box",
		padding: 10,
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorBorderStrong,
		borderWidth: 1,
		borderStyle: "solid",
		borderRadius: tokens.radiusControl,
		boxShadow: tokens.shadowOverlay
	},
	tools: {
		flexShrink: 0,
		display: "grid",
		gap: 6,
		padding: 8,
		fontSize: 12,
		color: tokens.colorText
	},
	controls: { display: "flex", flexWrap: "wrap", gap: 6, paddingTop: 6 }
});
