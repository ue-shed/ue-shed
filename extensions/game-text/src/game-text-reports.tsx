import * as stylex from "@stylexjs/stylex";
import {
	explainLocalizationFile,
	type WorkspaceReportPage,
	type WorkspaceReportFileRequest
} from "@ue-shed/game-text/corpus";
import { textCountLabel } from "@ue-shed/game-text/labels";
import {
	LocalizationUnknownReason,
	type TextCorpusQuerySummary,
	type LocalizationSelection
} from "@ue-shed/game-text/schema";
import { Button, createEffectAction } from "@ue-shed/ui";
import { For, Show, createEffect, createSignal } from "solid-js";
import type { LocalizationFileChange } from "@ue-shed/game-text/schema";
import type { GameTextClientApi } from "./game-text-client.js";
import { GameTextFileComparison, type ReadyFileComparison } from "./game-text-file-comparison.js";
import { unknownLabels } from "./game-text-localization-view.js";
import { styles } from "./game-text-styles.js";

const number = (value: number | null | undefined) =>
	value === null || value === undefined ? "Unknown" : value.toLocaleString();
const reviewTracked = (report: WorkspaceReportPage) =>
	report.rows.some((row) => row.reviewedLines !== undefined);
const percent = (value: number | null) =>
	value === null
		? "Unknown"
		: value.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%";

/** Changes a file comparison loads at a time. */
const COMPARISON_PAGE = 200;

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
	const compare = createEffectAction();
	const [comparison, setComparison] = createSignal<ReadyFileComparison>();
	const [compared, setCompared] = createSignal<readonly LocalizationFileChange[]>([]);
	const [comparing, setComparing] = createSignal(false);
	/** Two files the person chooses, or the next page of the open comparison. */
	const compareFiles = (more?: ReadyFileComparison) => {
		const action = props.client.compareLocalizationFiles;
		if (!action) return;
		setComparing(true);
		compare.run(
			action({
				...(more ? { files: more.files } : undefined),
				changes: { offset: more ? compared().length : 0, limit: COMPARISON_PAGE }
			}),
			{
				onFailure: () => {
					setComparing(false);
					setFailed(true);
					setFeedback("Couldn’t compare the files. Try again.");
				},
				onSuccess: (result) => {
					setComparing(false);
					if (result.status === "ready") {
						setCompared((previous) =>
							more ? [...previous, ...result.changes] : result.changes
						);
						setComparison(result);
						setFailed(false);
						setFeedback(undefined);
					} else if (result.status === "failed") {
						setFailed(true);
						setFeedback(result.message + " " + result.recovery);
					}
				}
			}
		);
	};
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
				<Show when={props.client.compareLocalizationFiles}>
					<Button
						size="compact"
						tone="quiet"
						disabled={props.disabled || comparing()}
						onClick={() => compareFiles()}
					>
						Compare two files…
					</Button>
				</Show>
				<Show when={feedback()}>
					<span
						role={failed() ? "alert" : "status"}
						{...stylex.attrs(styles.muted, failed() && styles.warning)}
					>
						{feedback()}
					</span>
				</Show>
			</div>
			<Show when={comparison()}>
				{(open) => (
					<GameTextFileComparison
						comparison={open()}
						changes={compared()}
						loadingMore={comparing()}
						onMore={() => compareFiles(open())}
						onClose={() => {
							compare.cancel();
							setComparing(false);
							setComparison(undefined);
							setCompared([]);
						}}
					/>
				)}
			</Show>
			<section
				aria-label="Reports"
				hidden={comparison() !== undefined}
				{...stylex.attrs(styles.pane, styles.reportPane)}
			>
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
											<Show when={reviewTracked(report())}>
												<th>Reviewed</th>
												<th>Proofread</th>
											</Show>
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
													<Show when={reviewTracked(report())}>
														<td>{number(row.reviewedLines ?? 0)}</td>
														<td>{number(row.proofreadLines ?? 0)}</td>
													</Show>
													<Show when={report().baseline}>
														<td>{number(row.newWords)}</td>
														<td>{number(row.changedWords)}</td>
													</Show>
												</tr>
											)}
										</For>
									</tbody>
								</table>
								<Show when={!reviewTracked(report())}>
									<p {...stylex.attrs(styles.muted)}>
										Reviewed · Proofread: not tracked yet
									</p>
								</Show>
								<p {...stylex.attrs(styles.muted)}>
									Progress counts gathered lines with current imported
									translations. Pending PO edits are counted separately.
								</p>
								<p {...stylex.attrs(styles.muted)}>
									Coverage:{" "}
									{textCountLabel(report().coverage.inspectedPackages, "asset")}{" "}
									read · {report().coverage.partialPackages} partly read ·{" "}
									{report().coverage.failedPackages} unread ·{" "}
									<Show when={report().coverage.missingGatherableText}>
										{(missing) =>
											`${textCountLabel(missing(), "gathered line")} not read · `
										}
									</Show>
									{textCountLabel(report().gatherFilesRead, "localization file")}{" "}
									read
									<Show when={report().gatherFilesMissing}>
										{(missing) => ` · ${missing().toLocaleString()} missing`}
									</Show>{" "}
									·{" "}
									{report().gatherFilesFailed -
										(report().gatherFilesMissing ?? 0)}{" "}
									unread.
								</p>
								<Show when={report().gatherFileProblems?.length}>
									<Show when={report().localizationFolder}>
										{(folder) => (
											<p {...stylex.attrs(styles.muted)}>
												Looked in {folder()}
											</p>
										)}
									</Show>
									<For each={report().gatherFileProblems}>
										{(problem) => {
											const text = explainLocalizationFile(problem);
											return (
												<p {...stylex.attrs(styles.muted)}>
													{text.message}
													{text.recovery ? ` ${text.recovery}` : ""}
												</p>
											);
										}}
									</For>
								</Show>
								<Show when={report().wordCountUnknown > 0}>
									<p {...stylex.attrs(styles.muted)}>
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
											<Show when={baseline().since}>
												{(since) =>
													` · since then ${since().added.toLocaleString()} new · ${since().removed.toLocaleString()} removed · ${since().keyChanged.toLocaleString()} key changed · ${since().changed.toLocaleString()} source changed`
												}
											</Show>
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
