import * as stylex from "@stylexjs/stylex";
import { savedMapPathToGameMapPath } from "@ue-shed/cameras/browser";
import { createEffectAction, SavedMapPicker } from "@ue-shed/ui";
import type { SavedWorldMap } from "@ue-shed/protocol";
import { Cause } from "effect";
import { createEffect, createMemo, createSignal, onSettled, Show } from "solid-js";
import type { MapReviewClientApi } from "./map-review-client.js";

export function ReviewMapPicker(props: {
	readonly client: Pick<MapReviewClientApi, "openMapInUnreal">;
	readonly maps: readonly SavedWorldMap[];
	readonly mapPath: string;
	readonly onMapPathChange: (path: string) => void;
	readonly onOpened?: () => void;
	readonly label?: string;
}) {
	const action = createEffectAction();
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string>();
	const open = (path: string) => {
		if (!props.client.openMapInUnreal || busy()) return;
		setBusy(true);
		setError(undefined);
		action.run(props.client.openMapInUnreal(path), {
			onFailure: (cause) => {
				setBusy(false);
				setError(Cause.pretty(cause));
			},
			onSuccess: (result) => {
				setBusy(false);
				if (result.outcome === "failed" || result.outcome === "rejected") {
					setError(`${result.message} ${result.recovery}`);
				} else {
					props.onOpened?.();
				}
			}
		});
	};
	return (
		<>
			<SavedMapPicker
				label={props.label ?? "Map"}
				ariaLabel={props.label ?? "Saved map"}
				maps={props.maps}
				mapPath={props.mapPath}
				disabled={busy()}
				openingInUnreal={busy()}
				openInUnrealError={error()}
				onMapPathChange={(path) => {
					setError(undefined);
					props.onMapPathChange(path);
				}}
				onOpenInUnreal={props.client.openMapInUnreal ? open : undefined}
			/>
			<Show when={busy()}>
				<p role="status">
					Opening map in Unreal… Large maps can take several minutes. Waiting for Unreal
					to finish; the open command is sent only once.
				</p>
			</Show>
		</>
	);
}

export function LiveReviewMapPicker(props: {
	readonly client: Pick<MapReviewClientApi, "savedWorldMaps" | "openMapInUnreal">;
	readonly onOpened: () => void;
	readonly editorMapPath?: string | undefined;
	readonly onMapPathChange?: ((path: string) => void) | undefined;
}) {
	const action = createEffectAction();
	const [maps, setMaps] = createSignal<readonly SavedWorldMap[]>([]);
	const [path, setPath] = createSignal("");
	const [error, setError] = createSignal<string>();
	const editorMap = createMemo(() => props.editorMapPath);
	createEffect(
		() => ({ current: editorMap(), maps: maps() }),
		({ current, maps }) => {
			const selected = maps.find((map) => savedMapPathToGameMapPath(map.mapPath) === current);
			if (selected) setPath(selected.mapPath);
		}
	);
	onSettled(() => {
		if (props.client.savedWorldMaps)
			action.run(props.client.savedWorldMaps(), {
				onSuccess: setMaps,
				onFailure: (cause) => setError(Cause.pretty(cause))
			});
	});
	return (
		<div {...stylex.attrs(styles.livePicker)}>
			<ReviewMapPicker
				label="Open another map in Unreal"
				client={props.client}
				maps={maps()}
				mapPath={path()}
				onMapPathChange={(path) => {
					setPath(path);
					props.onMapPathChange?.(path);
				}}
				onOpened={props.onOpened}
			/>
			{error() && <span role="alert">{error()}</span>}
		</div>
	);
}

const styles = stylex.create({
	livePicker: { maxWidth: 560, marginBottom: 16 }
});
