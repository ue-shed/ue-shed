import * as stylex from "@stylexjs/stylex";
import { createEffectAction, SavedMapPicker } from "@ue-shed/ui";
import type { SavedWorldMap } from "@ue-shed/protocol";
import { Cause } from "effect";
import { createSignal, onMount } from "solid-js";
import type { MapReviewClientApi } from "./map-review-client.js";

export function ReviewMapPicker(props: {
	readonly client: Pick<MapReviewClientApi, "openMapInUnreal">;
	readonly maps: readonly SavedWorldMap[];
	readonly mapPath: string;
	readonly onMapPathChange: (path: string) => void;
	readonly onOpened?: () => void;
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
		<SavedMapPicker
			label="Map"
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
	);
}

export function LiveReviewMapPicker(props: {
	readonly client: Pick<MapReviewClientApi, "savedWorldMaps" | "openMapInUnreal">;
	readonly onOpened: () => void;
}) {
	const action = createEffectAction();
	const [maps, setMaps] = createSignal<readonly SavedWorldMap[]>([]);
	const [path, setPath] = createSignal("");
	const [error, setError] = createSignal<string>();
	onMount(() => {
		if (props.client.savedWorldMaps)
			action.run(props.client.savedWorldMaps(), {
				onSuccess: setMaps,
				onFailure: (cause) => setError(Cause.pretty(cause))
			});
	});
	return (
		<div {...stylex.props(styles.livePicker)}>
			<ReviewMapPicker
				client={props.client}
				maps={maps()}
				mapPath={path()}
				onMapPathChange={setPath}
				onOpened={props.onOpened}
			/>
			{error() && <span role="alert">{error()}</span>}
		</div>
	);
}

const styles = stylex.create({
	livePicker: { maxWidth: 560, marginBottom: 16 }
});
