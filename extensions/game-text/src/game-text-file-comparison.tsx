import * as stylex from "@stylexjs/stylex";
import type {
	LocalizationFileChange,
	LocalizationFileComparisonResult,
	LocalizationFileField
} from "@ue-shed/game-text/schema";
import { Button, TextDiff, type TextDiffEntry, type TextDiffField } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createMemo } from "solid-js";

export type ReadyFileComparison = Extract<LocalizationFileComparisonResult, { status: "ready" }>;

const FIELD_LABELS = {
	source: "Source",
	source_plural: "Source, plural",
	translation: "Translation",
	path: "Path",
	notes: "Notes",
	comments: "Comments",
	references: "References",
	flags: "Flags"
} as const satisfies Record<LocalizationFileField["name"], string>;

/** Fields that hold identifiers or paths rather than prose, shown in the code font. */
const CODE_FIELDS = new Set<LocalizationFileField["name"]>(["path", "references", "flags"]);

const fullKey = (key: { readonly namespace: string; readonly key: string }) =>
	key.namespace === "" ? key.key : `${key.namespace},${key.key}`;

function field(field: LocalizationFileField): TextDiffField {
	return {
		label:
			field.form === undefined
				? FIELD_LABELS[field.name]
				: `${FIELD_LABELS[field.name]} [${field.form}]`,
		...(field.before === undefined ? undefined : { before: field.before }),
		...(field.after === undefined ? undefined : { after: field.after }),
		...(CODE_FIELDS.has(field.name) ? { code: true } : undefined)
	};
}

/**
 * A page of a file comparison as `TextDiff` entries: the key, its namespace as the place, and each
 * field. A new key shows its old and new key as a field of its own, like a changelist's.
 */
export function fileComparisonEntries(
	file: string,
	changes: readonly LocalizationFileChange[],
	offset: number
): TextDiffEntry[] {
	return changes.map((change, index) => {
		const key = change.after ?? change.before;
		const fields = change.fields.map(field);
		if (change.kind === "rekeyed" && change.before && change.after)
			fields.push({
				label: "Key",
				before: fullKey(change.before),
				after: fullKey(change.after),
				code: true
			});
		return {
			id: String(offset + index),
			kind: change.kind,
			...(change.before
				? { before: { label: change.before.key, full: fullKey(change.before) } }
				: undefined),
			...(change.after
				? { after: { label: change.after.key, full: fullKey(change.after) } }
				: undefined),
			file,
			...(key && key.namespace !== "" ? { place: key.namespace } : undefined),
			fields
		};
	});
}

const fileName = (path: string | undefined) => path?.split(/[/\\]/u).at(-1) ?? "";

/** Two localization files compared, page by page, as a text diff. */
export function GameTextFileComparison(props: {
	readonly comparison: ReadyFileComparison;
	/** The changes loaded so far, from the first page on. */
	readonly changes: readonly LocalizationFileChange[];
	readonly loadingMore: boolean;
	readonly onMore: () => void;
	readonly onClose: () => void;
}) {
	const file = () => props.comparison.files.after ?? props.comparison.files.before ?? "";
	const entries = createMemo(() => fileComparisonEntries(file(), props.changes, 0));
	return (
		<section aria-label="File comparison" {...stylex.attrs(styles.comparison)}>
			<header {...stylex.attrs(styles.header)}>
				<div {...stylex.attrs(styles.files)}>
					<span
						{...stylex.attrs(styles.file)}
						title={props.comparison.files.before ?? ""}
					>
						{fileName(props.comparison.files.before) || "No file"}
					</span>
					<span aria-hidden="true" {...stylex.attrs(styles.arrow)}>
						→
					</span>
					<span {...stylex.attrs(styles.file)} title={props.comparison.files.after ?? ""}>
						{fileName(props.comparison.files.after) || "No file"}
					</span>
				</div>
				<Button size="compact" tone="quiet" onClick={() => props.onClose()}>
					Back to reports
				</Button>
			</header>
			<TextDiff
				label="Changed entries"
				entries={entries()}
				counts={props.comparison.counts}
				unchanged={props.comparison.counts.unchanged}
				total={props.comparison.total}
				loadingMore={props.loadingMore}
				onMore={props.onMore}
			/>
		</section>
	);
}

const styles = stylex.create({
	comparison: { display: "grid", gap: 12, minHeight: 0, overflowY: "auto", paddingBlock: 4 },
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		minWidth: 0
	},
	files: { display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 },
	file: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		fontFamily: tokens.fontMono,
		fontSize: 12,
		color: tokens.colorTextStrong
	},
	arrow: { color: tokens.colorTextMuted }
});
