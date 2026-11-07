import { BuiltInCheckId } from "./localization-check-ids.js";
import { localizationCheckCatalogue } from "./localization-check-catalogue.js";
/** The package README's check table: generated from the catalogue, never edited by hand. */
export const CHECK_TABLE_START = "<!-- check table: generated from localizationCheckCatalogue; do not edit -->";
export const CHECK_TABLE_END = "<!-- end of check table -->";
/** Each built-in check's README row: ID, basis, default severity and default condition. */
export function localizationCheckRows() {
    return BuiltInCheckId.literals.map((id) => {
        const check = localizationCheckCatalogue[id];
        return [`\`${id}\``, check.basis, check.severity, check.defaultCondition];
    });
}
/** The check table as Markdown, columns padded to their widest cell. */
export function localizationCheckTable() {
    const rows = [["Check", "Basis", "Severity", "Reports"], ...localizationCheckRows()];
    const widths = [0, 1, 2, 3].map((column) => Math.max(...rows.map((row) => [...row[column]].length)));
    const line = (cells) => `| ${cells.map((cell, column) => cell + " ".repeat(widths[column] - [...cell].length)).join(" | ")} |`;
    return [
        line(rows[0]),
        line(widths.map((width) => "-".repeat(width))),
        ...rows.slice(1).map(line)
    ].join("\n");
}
/** The README with its check table, between the markers, replaced by the generated one. */
export function withLocalizationCheckTable(readme) {
    const start = readme.indexOf(CHECK_TABLE_START), end = readme.indexOf(CHECK_TABLE_END);
    if (start < 0 || end < start)
        return undefined;
    return (readme.slice(0, start + CHECK_TABLE_START.length) +
        "\n\n" +
        localizationCheckTable() +
        "\n\n" +
        readme.slice(end));
}
/** The table's rows as trimmed cells, so formatting changes to padding do not count. */
export function checkTableCells(markdown) {
    return markdown
        .split("\n")
        .filter((row) => row.startsWith("|") && !/^\|[\s|-]+\|$/u.test(row))
        .map((row) => row
        .slice(1, -1)
        .split(" | ")
        .map((cell) => cell.trim()));
}
