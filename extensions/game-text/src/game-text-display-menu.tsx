import * as stylex from "@stylexjs/stylex";
import { TextGroupBy } from "@ue-shed/game-text/browser";
import { AnchoredPopover, Button } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, createSignal, createUniqueId } from "solid-js";

const GROUP_LABELS = {
	problem: "Problem",
	folder: "Folder",
	asset: "Asset",
	origin: "Origin",
	namespace: "Namespace"
} satisfies Record<TextGroupBy, string>;

/** How the list is laid out: grouped by problem (the default), folder, asset, origin or namespace. */
export function DisplayMenu(props: {
	readonly group: TextGroupBy | undefined;
	readonly disabled: boolean;
	readonly onGroupChange: (group: TextGroupBy | undefined) => void;
}) {
	const id = createUniqueId();
	const [open, setOpen] = createSignal(false);
	const choices = [undefined, ...TextGroupBy.literals];
	return (
		<AnchoredPopover
			id={id}
			ariaLabel="Display"
			open={open()}
			onOpenChange={setOpen}
			placement="bottom-end"
			style={styles.panel}
			trigger={(trigger) => (
				<Button {...trigger} type="button" size="compact" disabled={props.disabled}>
					Display
				</Button>
			)}
		>
			<div role="radiogroup" aria-label="Group by" {...stylex.attrs(styles.group)}>
				<span {...stylex.attrs(styles.head)}>Group by</span>
				<For each={choices}>
					{(choice) => (
						<button
							type="button"
							role="radio"
							aria-checked={props.group === choice ? "true" : "false"}
							onClick={() => props.onGroupChange(choice)}
							{...stylex.attrs(
								styles.choice,
								props.group === choice && styles.chosen
							)}
						>
							{choice === undefined ? "No grouping" : GROUP_LABELS[choice]}
						</button>
					)}
				</For>
			</div>
		</AnchoredPopover>
	);
}

const styles = stylex.create({
	panel: {
		display: "grid",
		gap: 8,
		width: 220,
		boxSizing: "border-box",
		padding: 8,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
		zIndex: 20
	},
	group: { display: "grid", gap: 2 },
	head: { paddingInline: 6, paddingBottom: 2, color: tokens.colorTextFaint, fontSize: 11 },
	choice: {
		minHeight: 28,
		paddingInline: 8,
		borderWidth: 0,
		borderRadius: 5,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 12.5,
		textAlign: "start",
		cursor: "pointer",
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: -2 }
	},
	chosen: { backgroundColor: tokens.colorAccentWash, color: tokens.colorTextStrong }
});
