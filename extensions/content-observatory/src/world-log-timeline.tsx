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
		<div {...stylex.props(styles.timelineShell)}>
			<section aria-label="History timeline" {...stylex.props(styles.timeline)}>
				<header {...stylex.props(styles.timelineHeader)}>
					<div>
						<span {...stylex.props(styles.sectionKicker)}>SUBMITTED RECORD</span>
						<h2>{totalChanges()} map actor changes</h2>
						<p {...stylex.props(styles.timelineSubhead)}>
							Select a changelist for its full-map diff. View Filters keep every
							submitted changelist selectable.
						</p>
					</div>
					<span
						{...stylex.props(
							styles.completePill,
							props.history.completeness === "partial" && styles.partialPill
						)}
					>
						{props.history.completeness}
					</span>
				</header>
				<div
					role="toolbar"
					aria-label="Change View Filter"
					{...stylex.props(styles.filters)}
				>
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
								aria-pressed={props.filter === filter}
								onClick={() => props.setFilter(filter)}
								{...stylex.props(
									styles.filterButton,
									props.filter === filter && styles.filterButtonActive
								)}
							>
								{filter === "all" ? "ALL" : humanize(filter.replace("actor_", ""))}
							</button>
						)}
					</For>
				</div>
				<div {...stylex.props(styles.timelineList)}>
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
									{...stylex.props(
										styles.revision,
										props.selectedChangelist !== undefined &&
											props.selectedChangelist.revision === revisionIndex() &&
											styles.revisionSelected
									)}
								>
									<div {...stylex.props(styles.changeMarker)}>
										<span {...stylex.props(styles.changeMarkerLabel)}>
											<span>CL</span>
											<strong>{revision.change}</strong>
										</span>
										<button
											type="button"
											aria-label={`Select changelist ${revision.change}`}
											aria-pressed={selectedRevision()}
											onClick={() =>
												props.onSelectChangelist(revisionIndex())
											}
											{...stylex.props(
												styles.changelistSelect,
												props.selectedChangelist !== undefined &&
													props.selectedChangelist.revision ===
														revisionIndex() &&
													styles.changelistSelectActive
											)}
										>
											SELECT
										</button>
									</div>
									<div {...stylex.props(styles.revisionBody)}>
										<header {...stylex.props(styles.revisionHeader)}>
											<div {...stylex.props(styles.revisionMeta)}>
												<strong>
													{revision.user ?? "unknown submitter"}
												</strong>
												<span>{formatSubmittedAt(revision)}</span>
											</div>
											<p {...stylex.props(styles.revisionDescription)}>
												{revision.description ??
													"No changelist description."}
											</p>
										</header>
										<div {...stylex.props(styles.revisionSummary)}>
											{revision.changes.length} semantic /{" "}
											{revision.files.length} package /{" "}
											{revision.unclassifiedPackageChanges.length}{" "}
											unclassified
										</div>
										<For each={listedChanges()}>
											{({ change, changeIndex }) => (
												<button
													type="button"
													aria-pressed={selectedChange(changeIndex)}
													onClick={() =>
														props.onSelect({
															actorKey: actorKeyFromChange(change),
															changeIndex,
															revision: revisionIndex()
														})
													}
													{...stylex.props(
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
													<span {...stylex.props(styles.changeType)}>
														{humanize(
															change.kind.replace("actor_", "")
														)}
													</span>
													<strong {...stylex.props(styles.changeTitle)}>
														{changeTitle(change)}
													</strong>
													<small {...stylex.props(styles.changeDetail)}>
														{changeDetail(change)}
													</small>
												</button>
											)}
										</For>
										<Show when={listedChanges().length === 0}>
											<p {...stylex.props(styles.revisionEmpty)}>
												No matching actor change. Select this changelist to
												inspect the full diff.
											</p>
										</Show>
										<Show
											when={
												selectedRevision()
													? revision.unclassifiedPackageChanges.length > 0
													: filteredUnclassified().length > 0
											}
										>
											<div {...stylex.props(styles.unclassifiedNotice)}>
												<span>UNCLASSIFIED PACKAGE EVIDENCE</span>
												<strong>
													{selectedRevision()
														? revision.unclassifiedPackageChanges.length
														: filteredUnclassified().length}
												</strong>
												<p {...stylex.props(styles.unclassifiedNoticeCopy)}>
													Changed bytes were retained because this
													projection cannot explain them as actor changes.
												</p>
											</div>
										</Show>
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
		<aside aria-label="Selected changelist evidence" {...stylex.props(styles.evidencePanel)}>
			<header>
				<span {...stylex.props(styles.sectionKicker)}>EVIDENCE LEDGER</span>
				<h2>
					{revision() === undefined ? "Select a changelist" : `CL ${revision()!.change}`}
				</h2>
			</header>
			<Show
				when={revision()}
				fallback={
					<p {...stylex.props(styles.evidenceEmpty)}>
						Choose a submitted changelist to see its semantic, package, and unclassified
						evidence.
					</p>
				}
			>
				{(selectedRevision) => (
					<>
						<div {...stylex.props(styles.evidenceSummary)}>
							<strong>{selectedRevision().changes.length} semantic changes</strong>
							<span>{selectedRevision().files.length} package revisions</span>
							<span>
								{selectedRevision().unclassifiedPackageChanges.length} unclassified
							</span>
						</div>
						<Show when={change()}>
							{(selectedChange) => (
								<div {...stylex.props(styles.evidenceKind)}>
									<span>{humanize(selectedChange().kind)}</span>
									<strong>{changeDetail(selectedChange())}</strong>
								</div>
							)}
						</Show>
						<dl {...stylex.props(styles.packageList)}>
							<For each={selectedRevision().files}>
								{(file) => (
									<div {...stylex.props(styles.packageEntry)}>
										<dt {...stylex.props(styles.packageAction)}>
											{file.action}
										</dt>
										<dd {...stylex.props(styles.packagePath)}>
											{file.depotPath}#{file.revision}
										</dd>
									</div>
								)}
							</For>
						</dl>
						<Show when={selectedRevision().unclassifiedPackageChanges.length > 0}>
							<div {...stylex.props(styles.unclassifiedNotice)}>
								<span>UNCLASSIFIED PACKAGE EVIDENCE</span>
								<strong>
									{selectedRevision().unclassifiedPackageChanges.length}
								</strong>
								<p {...stylex.props(styles.unclassifiedNoticeCopy)}>
									The evidence is retained in this diff because no safe actor
									explanation was available.
								</p>
							</div>
						</Show>
					</>
				)}
			</Show>
			<footer {...stylex.props(styles.coverageFooter)}>
				<span>BASELINE</span>
				<strong>
					{props.history.baseline.status === "available"
						? `CL ${props.history.baseline.change}`
						: "map not yet created"}
				</strong>
			</footer>
		</aside>
	);
}
