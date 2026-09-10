import * as stylex from "@stylexjs/stylex";
import type { MapChange, PerforceMapHistoryDocument } from "@ue-shed/map-history/contract";
import { For, Show, createMemo } from "solid-js";
import {
	actorKeyFromChange,
	actorKeyFromIdentity,
	changeMatchesActor
} from "./world-log-actors.js";
import {
	changeDetail,
	changeTitle,
	changeTone,
	formatSubmittedAt,
	humanize
} from "./world-log-format.js";
import type {
	WorldLogChangeSelection,
	WorldLogChangelistSelection
} from "./world-log-selection.js";
import { styles } from "./world-log-styles.js";

export type WorldLogChangeFilter = "all" | MapChange["kind"];

const changeFilterLabel = (filter: WorldLogChangeFilter): string =>
	filter === "all"
		? "All"
		: humanize(filter.replace("actor_", "")).replace(/^./, (c) => c.toUpperCase());

export function WorldLogTimeline(props: {
	readonly actorKey: string | undefined;
	readonly filter: WorldLogChangeFilter;
	readonly history: PerforceMapHistoryDocument;
	readonly onSelect: (selection: {
		readonly actorKey: string | undefined;
		readonly changeIndex: number;
		readonly revision: number;
	}) => void;
	readonly onSelectChangelist: (revision: number) => void;
	readonly selectedChangelist: WorldLogChangelistSelection | undefined;
	readonly selected: WorldLogChangeSelection | undefined;
	readonly setFilter: (filter: WorldLogChangeFilter) => void;
}) {
	const selectedChangelistRevision = () =>
		props.selectedChangelist === undefined ? undefined : props.selectedChangelist.revision;
	const totalChanges = () =>
		props.history.revisions.reduce(
			(sum, revision) =>
				sum +
				revision.changes.filter(
					(change) => props.filter === "all" || change.kind === props.filter
				).length,
			0
		);
	return (
		<div {...stylex.attrs(styles.timelineShell)}>
			<section aria-label="History timeline" {...stylex.attrs(styles.timeline)}>
				<header {...stylex.attrs(styles.timelineHeader)}>
					<div>
						<h2 {...stylex.attrs(styles.timelineTitle)}>Timeline</h2>
						<p {...stylex.attrs(styles.timelineSubhead)}>
							{totalChanges()} map actor changes
						</p>
					</div>
					<span
						{...stylex.attrs(
							styles.completePill,
							props.history.completeness === "partial" && styles.partialPill
						)}
					>
						{props.history.completeness}
					</span>
				</header>
				<div role="toolbar" aria-label="Change filters" {...stylex.attrs(styles.filters)}>
					<For
						each={
							[
								"all",
								"actor_added",
								"actor_removed",
								"actor_moved",
								"actor_label_changed"
							] as const
						}
					>
						{(filter) => (
							<button
								type="button"
								aria-pressed={props.filter === filter ? "true" : "false"}
								onClick={() => props.setFilter(filter)}
								{...stylex.attrs(
									styles.filterButton,
									props.filter === filter && styles.filterButtonActive
								)}
							>
								{changeFilterLabel(filter)}
							</button>
						)}
					</For>
				</div>
				<div {...stylex.attrs(styles.timelineList)}>
					<For each={props.history.revisions}>
						{(revision, revisionIndex) => {
							const selectedRevision = () =>
								selectedChangelistRevision() === revisionIndex();
							const selectedChange = (changeIndex: number) =>
								props.selected !== undefined &&
								props.selected.revision === revisionIndex() &&
								props.selected.changeIndex === changeIndex;
							const filteredChanges = () =>
								revision.changes
									.map((change, changeIndex) => ({ change, changeIndex }))
									.filter(
										({ change }) =>
											(props.filter === "all" ||
												change.kind === props.filter) &&
											changeMatchesActor(change, props.actorKey)
									);
							const listedChanges = () =>
								selectedRevision()
									? revision.changes.map((change, changeIndex) => ({
											change,
											changeIndex
										}))
									: filteredChanges();
							const filteredUnclassified = () =>
								revision.unclassifiedPackageChanges.filter(
									(entry) =>
										props.actorKey === undefined ||
										entry.actorIdentities.some(
											(identity) =>
												actorKeyFromIdentity(identity) === props.actorKey
										)
								);
							return (
								<article
									{...stylex.attrs(
										styles.revision,
										props.selectedChangelist !== undefined &&
											props.selectedChangelist.revision === revisionIndex() &&
											styles.revisionSelected
									)}
								>
									<div {...stylex.attrs(styles.revisionMain)}>
										<p {...stylex.attrs(styles.revisionDescription)}>
											{revision.description ?? "No description."}
										</p>
										<span {...stylex.attrs(styles.revisionSummary)}>
											{revision.changes.length} actor changes ·{" "}
											{revision.files.length} packages
											{revision.unclassifiedPackageChanges.length > 0
												? ` · ${revision.unclassifiedPackageChanges.length} unclassified`
												: ""}
										</span>
										<For each={listedChanges()}>
											{({ change, changeIndex }) => (
												<button
													type="button"
													aria-pressed={
														selectedChange(changeIndex)
															? "true"
															: "false"
													}
													onClick={() =>
														props.onSelect({
															actorKey: actorKeyFromChange(change),
															changeIndex,
															revision: revisionIndex()
														})
													}
													{...stylex.attrs(
														styles.changeRow,
														styles[changeTone(change.kind)],
														props.selected !== undefined &&
															props.selected.revision ===
																revisionIndex() &&
															props.selected.changeIndex ===
																changeIndex &&
															styles.changeRowSelected
													)}
												>
													<span {...stylex.attrs(styles.changeType)}>
														{humanize(
															change.kind.replace("actor_", "")
														)}
													</span>
													<strong {...stylex.attrs(styles.changeTitle)}>
														{changeTitle(change)}
													</strong>
													<small {...stylex.attrs(styles.changeDetail)}>
														{changeDetail(change)}
													</small>
												</button>
											)}
										</For>
										<Show when={listedChanges().length === 0}>
											<p {...stylex.attrs(styles.revisionEmpty)}>
												No matching actor changes. Select the changelist to
												see its full diff.
											</p>
										</Show>
										<Show
											when={
												selectedRevision()
													? revision.unclassifiedPackageChanges.length > 0
													: filteredUnclassified().length > 0
											}
										>
											<div {...stylex.attrs(styles.unclassifiedNotice)}>
												<span {...stylex.attrs(styles.sectionLabel)}>
													Unclassified packages
												</span>
												<strong>
													{selectedRevision()
														? revision.unclassifiedPackageChanges.length
														: filteredUnclassified().length}
												</strong>
												<p {...stylex.attrs(styles.unclassifiedNoticeCopy)}>
													These package changes could not be mapped to
													actor events.
												</p>
											</div>
										</Show>
									</div>
									<div {...stylex.attrs(styles.revisionMarker)}>
										<button
											type="button"
											aria-label={`Select changelist ${revision.change}`}
											aria-pressed={selectedRevision() ? "true" : "false"}
											onClick={() =>
												props.onSelectChangelist(revisionIndex())
											}
											{...stylex.attrs(
												styles.changelistSelect,
												props.selectedChangelist !== undefined &&
													props.selectedChangelist.revision ===
														revisionIndex() &&
													styles.changelistSelectActive
											)}
										>
											CL {revision.change}
										</button>
										<time {...stylex.attrs(styles.revisionDate)}>
											{formatSubmittedAt(revision)}
										</time>
										<span {...stylex.attrs(styles.revisionUser)}>
											{revision.user ?? "Unknown user"}
										</span>
									</div>
								</article>
							);
						}}
					</For>
				</div>
			</section>
			<WorldLogEvidencePanel history={props.history} selected={props.selectedChangelist} />
		</div>
	);
}

function WorldLogEvidencePanel(props: {
	readonly history: PerforceMapHistoryDocument;
	readonly selected: WorldLogChangelistSelection | undefined;
}) {
	const revision = createMemo(() =>
		props.selected === undefined ? undefined : props.history.revisions[props.selected.revision]
	);
	const change = createMemo(() => {
		if (props.selected === undefined || props.selected.kind !== "change") return undefined;
		return revision() === undefined
			? undefined
			: revision()!.changes[props.selected.changeIndex];
	});
	return (
		<aside aria-label="Changelist details" {...stylex.attrs(styles.evidencePanel)}>
			<header>
				<h2>
					{revision() === undefined ? "Changelist details" : `CL ${revision()!.change}`}
				</h2>
			</header>
			<Show
				when={revision()}
				fallback={
					<p {...stylex.attrs(styles.evidenceEmpty)}>
						Select a changelist in the timeline to see its actor changes and files.
					</p>
				}
			>
				{(selectedRevision) => (
					<>
						<div {...stylex.attrs(styles.evidenceSummary)}>
							<strong>{selectedRevision().changes.length} actor changes</strong>
							<span>{selectedRevision().files.length} package revisions</span>
							<span>
								{selectedRevision().unclassifiedPackageChanges.length} unclassified
							</span>
						</div>
						<Show when={change()}>
							{(selectedChange) => (
								<div {...stylex.attrs(styles.evidenceKind)}>
									<span>{humanize(selectedChange().kind)}</span>
									<strong>{changeDetail(selectedChange())}</strong>
								</div>
							)}
						</Show>
						<dl {...stylex.attrs(styles.packageList)}>
							<For each={selectedRevision().files}>
								{(file) => (
									<div {...stylex.attrs(styles.packageEntry)}>
										<dt {...stylex.attrs(styles.packageAction)}>
											{file.action}
										</dt>
										<dd {...stylex.attrs(styles.packagePath)}>
											{file.depotPath}#{file.revision}
										</dd>
									</div>
								)}
							</For>
						</dl>
						<Show when={selectedRevision().unclassifiedPackageChanges.length > 0}>
							<div {...stylex.attrs(styles.unclassifiedNotice)}>
								<span {...stylex.attrs(styles.sectionLabel)}>
									Unclassified packages
								</span>
								<strong>
									{selectedRevision().unclassifiedPackageChanges.length}
								</strong>
								<p {...stylex.attrs(styles.unclassifiedNoticeCopy)}>
									No safe actor explanation was available for these changes.
								</p>
							</div>
						</Show>
					</>
				)}
			</Show>
			<footer {...stylex.attrs(styles.coverageFooter)}>
				<span>Baseline</span>
				<strong>
					{props.history.baseline.status === "available"
						? `CL ${props.history.baseline.change}`
						: "Map not yet created"}
				</strong>
			</footer>
		</aside>
	);
}
