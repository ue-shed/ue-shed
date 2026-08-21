import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createEffect, createMemo, createSignal, createUniqueId } from "solid-js";
import type { JSX } from "solid-js";
import { pointMapColorForClass } from "./point-map-core.js";
import {
	actorExplorerMatches,
	type ActorExplorerClassOption,
	type ActorExplorerFilters,
	type ActorExplorerItem
} from "./actor-explorer-core.js";

export {
	actorExplorerMatches,
	actorExplorerMatchesQuery,
	noActorExplorerFilters
} from "./actor-explorer-core.js";
export type {
	ActorExplorerClassOption,
	ActorExplorerFilters,
	ActorExplorerItem
} from "./actor-explorer-core.js";

function classLabel(option: ActorExplorerClassOption): string {
	return option.label ?? option.classPath.split(".").at(-1) ?? option.classPath;
}

function itemSecondary(item: ActorExplorerItem): string | undefined {
	return item.secondary === undefined || item.secondary === item.label
		? undefined
		: item.secondary;
}

/**
 * A shared actor browser for saved maps, live worlds, and historical sessions. Data adapters own
 * identity and domain semantics; this component owns the common search, class facets, list
 * selection, and scroll-to-selection behavior.
 */
export function ActorExplorer(props: {
	readonly ariaLabel?: string;
	readonly classMode?: "filter" | "target";
	readonly classSelection?: "multiple" | "single";
	readonly classOptions?: ReadonlyArray<ActorExplorerClassOption>;
	readonly density?: "comfortable" | "compact";
	readonly disabled?: boolean;
	readonly emptyLabel?: string;
	readonly extraControls?: JSX.Element;
	readonly filters: ActorExplorerFilters;
	readonly itemListLabel?: string;
	readonly items: ReadonlyArray<ActorExplorerItem>;
	readonly label?: string;
	readonly onClassPathsChange?: (classPaths: readonly string[] | undefined) => void;
	readonly onClassTargetChange?: (classPath: string | undefined) => void;
	readonly onFocus?: (key: string) => void;
	readonly onFiltersChange: (filters: ActorExplorerFilters) => void;
	readonly onSelect: (key: string | undefined) => void;
	readonly queryAriaLabel?: string;
	readonly role?: "complementary" | "region";
	readonly selectedClassPath: string | undefined;
	readonly selectedKey: string | undefined;
	readonly title?: string;
}) {
	const rowRefs = new Map<string, HTMLButtonElement>();
	let listRef: HTMLUListElement | undefined;
	const classFiltersId = createUniqueId();
	const [classMenuOpen, setClassMenuOpen] = createSignal(false);
	const [collapsedClasses, setCollapsedClasses] = createSignal<ReadonlySet<string>>(new Set());
	const classOptions = createMemo(() => {
		if (props.classOptions !== undefined) return props.classOptions;
		const counts = new Map<string, number>();
		for (const item of props.items)
			counts.set(item.classPath, (counts.get(item.classPath) ?? 0) + 1);
		return [...counts].map(([classPath, count]) => ({ classPath, count }));
	});
	const filteredClassOptions = createMemo(() => {
		const query = props.filters.query.trim().toLocaleLowerCase();
		if (query.length === 0) return classOptions();
		return classOptions().filter(
			(option) =>
				option.classPath.toLocaleLowerCase().includes(query) ||
				classLabel(option).toLocaleLowerCase().includes(query)
		);
	});
	const visibleItems = createMemo(() => {
		const filters =
			props.classMode === "target" && props.selectedClassPath !== undefined
				? { ...props.filters, classPaths: [props.selectedClassPath] }
				: props.filters;
		return props.items.filter((item) => actorExplorerMatches(item, filters));
	});
	const actorGroups = createMemo(() => {
		const optionLabels = new Map(
			classOptions().map((option) => [option.classPath, classLabel(option)] as const)
		);
		const groups = new Map<
			string,
			{
				readonly classPath: string;
				readonly label: string;
				readonly items: ActorExplorerItem[];
			}
		>();
		for (const item of visibleItems()) {
			const group = groups.get(item.classPath);
			if (group === undefined) {
				groups.set(item.classPath, {
					classPath: item.classPath,
					items: [item],
					label: optionLabels.get(item.classPath) ?? classLabel({ ...item, count: 0 })
				});
			} else {
				group.items.push(item);
			}
		}
		return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
	});
	const activeClassCount = createMemo(() => {
		if (props.classMode === "target") return props.selectedClassPath === undefined ? 0 : 1;
		return props.filters.classPaths?.length ?? classOptions().length;
	});
	const classSummary = createMemo(() => {
		const count = activeClassCount();
		if (props.classMode === "target") return count === 0 ? "CHOOSE CLASS" : "CLASS TARGET";
		return count === classOptions().length
			? "ALL CLASSES"
			: `${count} CLASS${count === 1 ? "" : "ES"}`;
	});

	createEffect(() => {
		const key = props.selectedKey;
		if (key === undefined) return;
		const row = rowRefs.get(key);
		if (row === undefined || listRef === undefined) return;
		const rowBounds = row.getBoundingClientRect();
		const listBounds = listRef.getBoundingClientRect();
		if (rowBounds.top < listBounds.top) listRef.scrollTop -= listBounds.top - rowBounds.top;
		else if (rowBounds.bottom > listBounds.bottom)
			listRef.scrollTop += rowBounds.bottom - listBounds.bottom;
	});
	createEffect(() => {
		const selectedKey = props.selectedKey;
		if (selectedKey === undefined) return;
		const selected = props.items.find((item) => item.key === selectedKey);
		if (selected === undefined) return;
		setCollapsedClasses((current) => {
			if (!current.has(selected.classPath)) return current;
			const next = new Set(current);
			next.delete(selected.classPath);
			return next;
		});
	});

	const setQuery = (query: string) => props.onFiltersChange({ ...props.filters, query });
	const toggleClass = (classPath: string) => {
		if (props.classMode === "target") {
			props.onClassTargetChange?.(
				props.selectedClassPath === classPath ? undefined : classPath
			);
			return;
		}
		const current = new Set(
			props.filters.classPaths ?? classOptions().map((option) => option.classPath)
		);
		if (props.classSelection === "single") {
			if (props.filters.classPaths !== undefined && current.has(classPath)) current.clear();
			else {
				current.clear();
				current.add(classPath);
			}
		} else if (current.has(classPath)) current.delete(classPath);
		else current.add(classPath);
		const next = [...current];
		props.onClassPathsChange?.(next.length === classOptions().length ? undefined : next);
	};
	const invertClasses = () => {
		if (props.classMode === "target") return;
		const current = new Set(
			props.filters.classPaths ?? classOptions().map((option) => option.classPath)
		);
		const next = classOptions()
			.filter((option) => !current.has(option.classPath))
			.map((option) => option.classPath);
		props.onClassPathsChange?.(next.length === classOptions().length ? undefined : next);
	};
	const toggleClassGroup = (classPath: string) => {
		setCollapsedClasses((current) => {
			const next = new Set(current);
			if (next.has(classPath)) next.delete(classPath);
			else next.add(classPath);
			return next;
		});
	};

	return (
		<section
			aria-label={props.ariaLabel ?? "Actor explorer"}
			role={props.role}
			onKeyDown={(event) => {
				if (event.key === "Escape") setClassMenuOpen(false);
			}}
			{...stylex.props(
				styles.explorer,
				props.density === "compact" && styles.explorerCompact
			)}
		>
			<div
				{...stylex.props(
					styles.header,
					props.density === "compact" && styles.headerCompact
				)}
			>
				<div>
					<span {...stylex.props(styles.kicker)}>{props.label ?? "ACTOR EXPLORER"}</span>
					<Show when={props.title}>
						{(title) => <strong {...stylex.props(styles.title)}>{title()}</strong>}
					</Show>
				</div>
				<span {...stylex.props(styles.count)}>
					{visibleItems().length} / {props.items.length}
				</span>
			</div>
			<label
				{...stylex.props(
					styles.search,
					props.density === "compact" && styles.searchCompact
				)}
			>
				<span>FIND ACTOR OR CLASS</span>
				<input
					aria-label={props.queryAriaLabel ?? "Find actor or class"}
					disabled={props.disabled}
					value={props.filters.query}
					onInput={(event) => setQuery(event.currentTarget.value)}
					placeholder="label: class: path: package: guid:"
					{...stylex.props(styles.searchInput)}
				/>
			</label>
			<Show when={classOptions().length > 0}>
				<div {...stylex.props(styles.classMenu)}>
					<div
						{...stylex.props(
							styles.classToolbar,
							props.density === "compact" && styles.classToolbarCompact
						)}
					>
						<span {...stylex.props(styles.classToolbarLabel)}>CLASS FILTER</span>
						<button
							type="button"
							disabled={props.disabled}
							aria-expanded={classMenuOpen()}
							aria-controls={classFiltersId}
							aria-label="Toggle actor class filters"
							onClick={() => setClassMenuOpen((open) => !open)}
							{...stylex.props(styles.classSummary)}
						>
							{classSummary()}{" "}
							<b>
								{activeClassCount()}/{classOptions().length}
							</b>{" "}
							<span>{classMenuOpen() ? "⌃" : "⌄"}</span>
						</button>
					</div>
					<Show when={classMenuOpen()}>
						<div
							id={classFiltersId}
							aria-label="Actor class filters"
							{...stylex.props(
								styles.classFilters,
								props.density === "compact" && styles.classFiltersCompact
							)}
						>
							<div {...stylex.props(styles.classFiltersHeader)}>
								<div>
									<strong>FILTER CLASSES</strong>
									<span>
										{filteredClassOptions().length} of {classOptions().length}{" "}
										shown
									</span>
								</div>
								<div {...stylex.props(styles.classFilterActions)}>
									<Show
										when={
											props.classMode !== "target" &&
											props.classSelection !== "single"
										}
									>
										<button
											type="button"
											disabled={props.disabled}
											title="Invert which actor classes are selected"
											onClick={invertClasses}
											{...stylex.props(styles.classAction)}
										>
											INVERT
										</button>
									</Show>
									<button
										type="button"
										onClick={() => setClassMenuOpen(false)}
										{...stylex.props(styles.classAction)}
									>
										CLOSE
									</button>
								</div>
							</div>
							<div {...stylex.props(styles.classOptionGrid)}>
								<For each={filteredClassOptions()}>
									{(option) => {
										const active = () =>
											props.classMode === "target"
												? props.selectedClassPath === option.classPath
												: props.filters.classPaths === undefined ||
													props.filters.classPaths.includes(
														option.classPath
													);
										return (
											<button
												type="button"
												disabled={props.disabled}
												aria-pressed={active()}
												onClick={() => toggleClass(option.classPath)}
												{...stylex.props(
													styles.classOption,
													active() && styles.classOptionActive
												)}
											>
												<i
													{...stylex.props(styles.swatch)}
													style={{
														"background-color": pointMapColorForClass(
															option.classPath
														)
													}}
												/>
												<span {...stylex.props(styles.classOptionLabel)}>
													{classLabel(option)}
												</span>
												<b>{option.count}</b>
											</button>
										);
									}}
								</For>
							</div>
						</div>
					</Show>
				</div>
			</Show>
			<Show when={props.extraControls}>{props.extraControls}</Show>
			<ul
				ref={(element) => {
					listRef = element;
				}}
				aria-label={props.itemListLabel ?? "Actors"}
				{...stylex.props(styles.list)}
			>
				<For each={actorGroups()}>
					{(group) => (
						<li {...stylex.props(styles.classGroup)}>
							<button
								type="button"
								aria-expanded={!collapsedClasses().has(group.classPath)}
								onClick={() => toggleClassGroup(group.classPath)}
								{...stylex.props(
									styles.classGroupHeader,
									props.density === "compact" && styles.classGroupHeaderCompact
								)}
							>
								<span {...stylex.props(styles.classGroupDisclosure)}>
									{collapsedClasses().has(group.classPath) ? "▸" : "▾"}
								</span>
								<strong {...stylex.props(styles.classGroupLabel)}>
									{group.label}
								</strong>
								<small>{group.items.length}</small>
							</button>
							<Show when={!collapsedClasses().has(group.classPath)}>
								<ul {...stylex.props(styles.groupItems)}>
									<For each={group.items}>
										{(item) => (
											<li>
												<button
													ref={(element) =>
														rowRefs.set(item.key, element)
													}
													type="button"
													disabled={props.disabled}
													aria-pressed={props.selectedKey === item.key}
													title={item.path ?? item.label}
													onClick={() => {
														props.onSelect(item.key);
														props.onFocus?.(item.key);
													}}
													{...stylex.props(
														styles.row,
														props.density === "compact" &&
															styles.rowCompact,
														props.selectedKey === item.key &&
															styles.rowSelected
													)}
												>
													<span {...stylex.props(styles.rowGlyph)}>
														•
													</span>
													<span {...stylex.props(styles.rowCopy)}>
														<strong {...stylex.props(styles.rowLabel)}>
															{item.label}
														</strong>
														<Show when={itemSecondary(item)}>
															{(secondary) => (
																<small
																	{...stylex.props(
																		styles.rowSecondary
																	)}
																>
																	{secondary()}
																</small>
															)}
														</Show>
													</span>
													<Show
														when={item.badges && item.badges.length > 0}
													>
														<div {...stylex.props(styles.badges)}>
															<For each={item.badges}>
																{(badge) => <em>{badge}</em>}
															</For>
														</div>
													</Show>
												</button>
											</li>
										)}
									</For>
								</ul>
							</Show>
						</li>
					)}
				</For>
			</ul>
			<Show when={visibleItems().length === 0}>
				<p {...stylex.props(styles.empty)}>
					{props.emptyLabel ?? "No actors match the current filters."}
				</p>
			</Show>
		</section>
	);
}

const styles = stylex.create({
	explorer: {
		position: "relative",
		display: "flex",
		flexDirection: "column",
		minWidth: 0,
		minHeight: 0,
		maxHeight: "min(70vh, 520px)",
		overflow: "visible",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorText
	},
	explorerCompact: { maxHeight: 330 },
	header: {
		display: "flex",
		alignItems: "baseline",
		justifyContent: "space-between",
		gap: 8,
		padding: "12px 14px 10px",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	headerCompact: { padding: "9px 11px 7px" },
	kicker: {
		display: "block",
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		fontWeight: 400
	},
	title: {
		display: "block",
		marginTop: 4,
		color: tokens.colorTextStrong,
		fontSize: 14,
		fontWeight: 590,
		letterSpacing: "-0.01em"
	},
	count: { color: tokens.colorTextSubtle, fontFamily: tokens.fontMono, fontSize: 11 },
	search: {
		display: "grid",
		gap: 6,
		padding: "10px 14px 8px",
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	searchCompact: { padding: "7px 11px 6px" },
	searchInput: {
		width: "100%",
		boxSizing: "border-box",
		borderColor: { default: tokens.colorBorderStrong, ":focus": tokens.colorTextSubtle },
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		padding: "7px 9px",
		fontFamily: tokens.fontMono,
		fontSize: 12,
		outline: "none"
	},
	classMenu: { position: "relative", flex: "0 0 auto", zIndex: 4 },
	classFilters: {
		position: "absolute",
		top: "calc(100% - 1px)",
		left: 12,
		width: "min(460px, calc(100vw - 48px))",
		maxHeight: "min(55vh, 440px)",
		overflow: "hidden",
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: "#161718f2",
		boxShadow: tokens.shadowOverlay,
		backdropFilter: "blur(8px)"
	},
	classFiltersCompact: { maxHeight: "min(48vh, 360px)", left: 8 },
	classFiltersHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		padding: "10px 12px",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	classFilterActions: { display: "flex", gap: 6, flex: "0 0 auto" },
	classOptionGrid: {
		display: "grid",
		gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
		gap: 6,
		maxHeight: "min(46vh, 380px)",
		overflowY: "auto",
		padding: 10
	},
	classToolbar: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
		padding: "7px 14px",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	classToolbarCompact: { padding: "6px 11px" },
	classToolbarLabel: { whiteSpace: "nowrap" },
	classSummary: {
		minWidth: 0,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusBadge,
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.04)"
		},
		color: tokens.colorText,
		padding: "4px 8px",
		fontSize: 11,
		fontWeight: 500,
		cursor: "pointer"
	},
	classAction: {
		borderColor: "transparent",
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.04)"
		},
		color: tokens.colorTextMuted,
		padding: "4px 8px",
		fontSize: 11,
		fontWeight: 500,
		cursor: "pointer"
	},
	classOption: {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 5,
		minWidth: 0,
		width: "100%",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		padding: "5px 8px",
		fontSize: 12,
		cursor: "pointer",
		textAlign: "left"
	},
	classOptionLabel: {
		flex: "1 1 auto",
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	classGroup: { margin: 0, padding: 0 },
	classGroupHeader: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "14px minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 5,
		border: 0,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.03)"
		},
		color: tokens.colorTextMuted,
		padding: "6px 10px",
		textAlign: "left",
		fontSize: 11,
		fontWeight: 500,
		cursor: "pointer"
	},
	classGroupHeaderCompact: { padding: "4px 8px" },
	classGroupDisclosure: { color: tokens.colorTextFaint, fontSize: 10 },
	classGroupLabel: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	groupItems: {
		listStyle: "none",
		margin: 0,
		padding: 0,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	classOptionActive: {
		borderColor: "rgba(228, 242, 34, 0.35)",
		backgroundColor: tokens.colorAccentWash,
		color: tokens.colorTextStrong
	},
	swatch: { width: 6, height: 6, flex: "0 0 auto", borderRadius: "50%" },
	list: {
		flex: "1 1 auto",
		minHeight: 0,
		overflowY: "auto",
		listStyle: "none",
		margin: 0,
		padding: 0,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1
	},
	row: {
		width: "100%",
		display: "flex",
		alignItems: "center",
		justifyContent: "flex-start",
		gap: 8,
		border: 0,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" },
		color: tokens.colorText,
		padding: "7px 10px 7px 22px",
		textAlign: "left",
		cursor: "pointer",
		fontSize: 12
	},
	rowCompact: { padding: "5px 8px 5px 18px" },
	rowSelected: {
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		color: tokens.colorTextStrong
	},
	rowGlyph: { flex: "0 0 auto", color: tokens.colorTextFaint, fontSize: 11 },
	rowCopy: { display: "grid", gap: 2, minWidth: 0, flex: "1 1 auto" },
	rowLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
	rowSecondary: {
		color: tokens.colorTextSubtle,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	badges: {
		display: "flex",
		flexWrap: "wrap",
		justifyContent: "flex-end",
		gap: 4,
		flex: "0 0 auto"
	},
	empty: {
		margin: 0,
		padding: "14px 14px",
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.5
	}
});
