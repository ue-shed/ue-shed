import * as stylex from "@stylexjs/stylex";
import { TextGroupBy } from "@ue-shed/game-text/schema";
import { AnchoredPopover, ToolButton, ToolIcon } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, createEffect, createSignal, createUniqueId } from "solid-js";

const GROUP_LABELS = {
	problem: "Problem",
	folder: "Folder",
	asset: "Asset",
	origin: "Origin",
	namespace: "Namespace",
	audience: "Audience",
	source: "Source text",
	finding: "Finding"
} satisfies Record<TextGroupBy, string>;

/** Source groups answer host queries (texts under several keys); the list does not offer them. */
const MENU_GROUPS: readonly TextGroupBy[] = TextGroupBy.literals.filter(
	(group) => group !== "source"
);

/**
 * How the list is laid out: grouped by problem (the default), folder, asset, origin, namespace,
 * audience or, when the project has rules, finding.
 */
export function DisplayMenu(props: {
	readonly group: TextGroupBy | undefined;
	readonly disabled: boolean;
	/** Whether the project has rules whose findings Browse shows. */
	readonly findings: boolean;
	readonly onGroupChange: (group: TextGroupBy | undefined) => void;
}) {
	const id = createUniqueId();
	const [open, setOpen] = createSignal(false);
	const choices = () => [
		undefined,
		...MENU_GROUPS.filter((group) => props.findings || group !== "finding")
	];
	let radios: HTMLDivElement | undefined;
	const checked = () => radios?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
	// A radio group is one stop: it opens on the current choice, and arrows change the choice.
	createEffect(open, (isOpen) => {
		if (isOpen) queueMicrotask(() => checked()?.focus());
	});
	const move = (event: KeyboardEvent) => {
		const step =
			event.key === "ArrowDown" || event.key === "ArrowRight"
				? 1
				: event.key === "ArrowUp" || event.key === "ArrowLeft"
					? -1
					: 0;
		if (step === 0 && event.key !== "Home" && event.key !== "End") return;
		event.preventDefault();
		event.stopPropagation();
		const listed = choices();
		const current = listed.indexOf(props.group);
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? listed.length - 1
					: (current + step + listed.length) % listed.length;
		props.onGroupChange(listed[next]);
		queueMicrotask(() => checked()?.focus());
	};
	return (
		<AnchoredPopover
			id={id}
			ariaLabel="Display"
			open={open()}
			onOpenChange={setOpen}
			placement="bottom-end"
			style={styles.panel}
			trigger={(trigger) => (
				<ToolButton
					{...trigger}
					label="Display"
					showLabel
					tooltip={`Grouped by ${props.group ? GROUP_LABELS[props.group].toLowerCase() : "nothing"}.`}
					disabled={props.disabled}
				>
					<ToolIcon name="display" />
				</ToolButton>
			)}
		>
			<div
				ref={(element) => {
					radios = element;
				}}
				role="radiogroup"
				aria-label="Group by"
				onKeyDown={move}
				{...stylex.attrs(styles.group)}
			>
				<span {...stylex.attrs(styles.head)}>Group by</span>
				<For each={choices()}>
					{(choice) => (
						<button
							type="button"
							role="radio"
							aria-checked={props.group === choice ? "true" : "false"}
							tabindex={props.group === choice ? 0 : -1}
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
