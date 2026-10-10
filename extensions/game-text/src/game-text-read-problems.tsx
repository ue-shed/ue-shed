import * as stylex from "@stylexjs/stylex";
import {
	textCountLabel,
	type TextCorpusDiagnostic,
	type TextCorpusQuerySummary
} from "@ue-shed/game-text/browser";
import { AnchoredPopover } from "@ue-shed/ui";
import { For, Show, createUniqueId } from "solid-js";
import { styles } from "./game-text-styles.js";

const diagnosticLabels = {
	package_inspection_failed: "Asset could not be read",
	package_partially_decoded: "Asset not fully read",
	unsupported_text_history: "Text field not decoded",
	package_not_gatherable: "Excluded because Unreal does not gather it"
};

/** Scan-wide coverage stays available from either view without a summary strip. */
export function ReadProblems(props: { readonly summary: TextCorpusQuerySummary }) {
	const id = createUniqueId();
	const unread = () =>
		props.summary.coverage.partialPackages + props.summary.coverage.failedPackages;
	const excluded = () => props.summary.notGatherablePackages ?? 0;
	const label = () => {
		if (unread() > 0) return textCountLabel(unread(), "asset") + " not fully read";
		if (excluded() > 0) return textCountLabel(excluded(), "asset") + " excluded from gather";
		const unsupported = props.summary.coverage.unsupportedTextProperties;
		return unsupported > 0
			? textCountLabel(unsupported, "text field") + " not decoded"
			: "Read problems";
	};
	return (
		<Show
			when={
				props.summary.status === "partial" ||
				excluded() > 0 ||
				props.summary.diagnosticCount > 0 ||
				props.summary.coverage.unsupportedTextProperties > 0
			}
		>
			{" · "}
			<AnchoredPopover
				id={id}
				ariaLabel="Read problems"
				placement="bottom-end"
				style={styles.readProblems}
				trigger={(triggerProps) => (
					<button
						{...triggerProps}
						type="button"
						aria-label="Read problems"
						title="Inspect excluded assets, incomplete reads and text fields that could not be decoded."
						{...stylex.attrs(styles.readProblemsTrigger)}
					>
						{label()}
					</button>
				)}
			>
				<p {...stylex.attrs(styles.problemMessage)}>
					{props.summary.status === "partial"
						? "Only part of the project's saved text was read. " +
							"Writing checks cover the lines that were read."
						: "Saved text was read with warnings."}
				</p>
				<Show when={excluded() > 0}>
					<p {...stylex.attrs(styles.problemMessage)}>
						{textCountLabel(excluded(), "asset")} excluded because Unreal does not
						gather them. Their text payloads were not inspected.
					</p>
				</Show>
				<p {...stylex.attrs(styles.problemMessage)}>
					{props.summary.coverage.inspectedPackages.toLocaleString()} of{" "}
					{textCountLabel(props.summary.coverage.discoveredPackages, "asset")} read ·{" "}
					{textCountLabel(props.summary.coverage.partialPackages, "asset")} partly read ·{" "}
					{textCountLabel(props.summary.coverage.failedPackages, "asset")} could not be
					read
				</p>
				<Show when={props.summary.coverage.unsupportedTextProperties > 0}>
					<p {...stylex.attrs(styles.problemMessage, styles.warning)}>
						{textCountLabel(
							props.summary.coverage.unsupportedTextProperties,
							"text field"
						)}{" "}
						could not be decoded. Some lines may be missing.
					</p>
				</Show>
				<p {...stylex.attrs(styles.problemMessage)}>
					Select a line to inspect read problems for its assets under Where it appears.
				</p>
			</AnchoredPopover>
		</Show>
	);
}

export function CoverageNotes(props: { readonly diagnostics: readonly TextCorpusDiagnostic[] }) {
	return (
		<Show when={props.diagnostics.length > 0}>
			<section
				aria-label="Read problems for this line"
				{...stylex.attrs(styles.detailSection)}
			>
				<h3 {...stylex.attrs(styles.section)}>Read problems</h3>
				<For each={props.diagnostics}>
					{(diagnostic) => (
						<article {...stylex.attrs(styles.card)}>
							<strong {...stylex.attrs(styles.warning)}>
								{diagnosticLabels[diagnostic.code]}
							</strong>
							<p {...stylex.attrs(styles.problemMessage)}>{diagnostic.message}</p>
							<code {...stylex.attrs(styles.mono)}>{diagnostic.packageFile}</code>
							<Show when={diagnostic.objectPath}>
								<code {...stylex.attrs(styles.mono)}>{diagnostic.objectPath}</code>
							</Show>
							<Show when={diagnostic.propertyPath}>
								<code {...stylex.attrs(styles.mono)}>
									{diagnostic.propertyPath}
								</code>
							</Show>
						</article>
					)}
				</For>
			</section>
		</Show>
	);
}
