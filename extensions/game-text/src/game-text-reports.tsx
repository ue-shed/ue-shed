import * as stylex from "@stylexjs/stylex";
import {
	LocalizationUnknownReason,
	textCountLabel,
	type TextCorpusQuerySummary,
	type WorkspaceReportPage,
	type WorkspaceReportFileRequest,
	type LocalizationSelection
} from "@ue-shed/game-text/browser";
import { Button, createEffectAction } from "@ue-shed/ui";
import { For, Show, createEffect, createSignal } from "solid-js";
import type { GameTextClientApi } from "./game-text-client.js";
import { unknownLabels } from "./game-text-localization-view.js";
import { styles } from "./game-text-styles.js";

const number = (value: number | null | undefined) =>
	value === null || value === undefined ? "Unknown" : value.toLocaleString();
const percent = (value: number | null) =>
	value === null
		? "Unknown"
		: value.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%";

export function GameTextReports(props: {
	readonly client: GameTextClientApi;
	readonly disabled?: boolean;
	readonly target: LocalizationSelection["target"];
	readonly revision: TextCorpusQuerySummary | undefined;
}) {
	const query = createEffectAction();
	const file = createEffectAction();
	const [page, setPage] = createSignal<WorkspaceReportPage>();
	const [loading, setLoading] = createSignal(true);
	const [feedback, setFeedback] = createSignal<string>();
	const [failed, setFailed] = createSignal(false);
	const [fileBusy, setFileBusy] = createSignal(false);
	let generation = 0;
	const load = (offset?: number) => {
		const request = props.client.localizationReport;
		if (!request) return;
		const version = ++generation;
		setLoading(true);
		query.run(
			request({ target: props.target, ...(offset !== undefined ? { offset } : undefined) }),
			{
				onFailure: () => {
					if (version === generation) {
						setLoading(false);
						setFailed(true);
						setFeedback("Couldn’t load reports. Rescan to try again.");
					}
				},
				onSuccess: (result) => {
					if (version !== generation) return;
					setLoading(false);
					if (result.status === "ready") {
						setPage((previous) =>
							offset && previous
								? { ...result.page, rows: [...previous.rows, ...result.page.rows] }
								: result.page
						);
						setFailed(false);
					} else {
						setFailed(true);
						setFeedback(
							result.status === "failed"
								? result.message + " " + result.recovery
								: "Reports are unavailable. Rescan to try again."
						);
					}
				}
			}
		);
	};
	createEffect(
		() => ({ target: props.target, revision: props.revision }),
		() => {
			file.cancel();
			setFileBusy(false);
			setPage(undefined);
			setFeedback(undefined);
			load();
		}
	);
	const operation = (operation: WorkspaceReportFileRequest["operation"]) => {
		const action = props.client.localizationReportFile;
		if (!action) return;
		const target = props.target;
		const version = generation;
		setFileBusy(true);
		file.run(action({ target, operation }), {
			onFailure: () => {
				if (version === generation) {
					setFileBusy(false);
					setFailed(true);
					setFeedback("Couldn’t complete the file operation. Try again.");
				}
			},
			onSuccess: (result) => {
				if (version !== generation) return;
				setFileBusy(false);
				if (result.status === "compared") {
					setPage(result.page);
					setFailed(false);
					setFeedback("Baseline compared.");
				} else if (result.status === "saved") {
					setFailed(false);
					setFeedback(result.message);
				} else if (result.status === "failed") {
					setFailed(true);
					setFeedback(result.message + " " + result.recovery);
				}
			}
		});
	};
	return (
		<div {...stylex.attrs(styles.workspace)}>
			<div {...stylex.attrs(styles.bar)}>
				<Button
					size="compact"
					tone="quiet"
					disabled={props.disabled || loading() || fileBusy() || !page()}
					onClick={() => operation("save_baseline")}
				>
					Save baseline…
				</Button>
				<Button
					size="compact"
					tone="quiet"
					disabled={props.disabled || loading() || fileBusy() || !page()}
					onClick={() => operation("compare_baseline")}
				>
					Compare with baseline…
				</Button>
				<Button
					size="compact"
					tone="quiet"
					disabled={props.disabled || loading() || fileBusy() || !page()}
					onClick={() => operation("export_csv")}
				>
					Export CSV
				</Button>
				<Show when={feedback()}>
					<span
						role={failed() ? "alert" : "status"}
						{...stylex.attrs(styles.muted, failed() && styles.warning)}
					>
						{feedback()}
					</span>
				</Show>
			</div>
			<section aria-label="Reports" {...stylex.attrs(styles.pane, styles.reportPane)}>
				<Show
					when={!loading() || page()}
					fallback={
						<p role="status" {...stylex.attrs(styles.empty)}>
							Loading reports…
						</p>
					}
				>
					<Show when={page()}>
						{(report) => (
							<>
								<table
									aria-label="Localization report"
									{...stylex.attrs(styles.reportTable)}
								>
									<thead>
										<tr>
											<th>Culture</th>
											<th>Lines translated / total</th>
											<th>% by lines</th>
											<th>% by words</th>
											<th>Words needing work</th>
											<th>Not synced</th>
											<Show when={report().baseline}>
												<th>New words</th>
												<th>Changed words</th>
											</Show>
										</tr>
									</thead>
									<tbody>
										<For each={report().rows}>
											{(row) => (
												<tr aria-label={row.culture}>
													<td>{row.culture}</td>
													<td>
														{number(row.translatedLines)} /{" "}
														{number(row.totalLines)}
													</td>
													<td>{percent(row.linesPercent)}</td>
													<td>{percent(row.wordsPercent)}</td>
													<td>{number(row.wordsNeedingWork)}</td>
													<td>{number(row.notSynced)}</td>
													<Show when={report().baseline}>
														<td>{number(row.newWords)}</td>
														<td>{number(row.changedWords)}</td>
													</Show>
												</tr>
											)}
										</For>
									</tbody>
								</table>
								<p {...stylex.attrs(styles.muted)}>
									Reviewed · Proofread: not tracked yet
								</p>
								<p {...stylex.attrs(styles.muted)}>
									Progress counts gathered lines with current imported
									translations. Pending PO edits are counted separately.
								</p>
								<p {...stylex.attrs(styles.muted)}>
									Coverage:{" "}
									{textCountLabel(report().coverage.inspectedPackages, "asset")}{" "}
									read · {report().coverage.partialPackages} partly read ·{" "}
									{report().coverage.failedPackages} unread ·{" "}
									{textCountLabel(
										report().coverage.unsupportedTextProperties,
										"unsupported field"
									)}
									·{" "}
									{textCountLabel(report().gatherFilesRead, "localization file")}{" "}
									read · {report().gatherFilesFailed} unread.
								</p>
								<Show when={report().wordCountUnknown > 0}>
									<p {...stylex.attrs(styles.warning)}>
										Word counts are unavailable for some source languages.
									</p>
								</Show>
								<For
									each={LocalizationUnknownReason.literals.filter(
										(reason) => report().unknownReasons[reason] > 0
									)}
								>
									{(reason) => (
										<p {...stylex.attrs(styles.muted)}>
											{unknownLabels[reason]} (
											{report().unknownReasons[reason].toLocaleString()})
										</p>
									)}
								</For>
								<Show when={report().baseline}>
									{(baseline) => (
										<p {...stylex.attrs(styles.muted)}>
											Baseline: {baseline().target} ·{" "}
											{new Date(baseline().createdAt).toLocaleString()}
										</p>
									)}
								</Show>
								<Show when={report().nextOffset !== undefined}>
									<Button
										size="compact"
										disabled={loading()}
										onClick={() => load(report().nextOffset)}
									>
										Show more cultures
									</Button>
								</Show>
							</>
						)}
					</Show>
				</Show>
			</section>
		</div>
	);
}
