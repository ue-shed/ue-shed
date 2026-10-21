/**
 * Asset type labels. An asset type is the class path of the main asset of the package that holds
 * the text, as the saved reader reports it (uasset-io `assetClass`). The key is the class path, so
 * a host can show its own names without changing what filters match.
 */

/** Names that differ from the class's own: Unreal shows a World as a Level. */
export const TEXT_ASSET_TYPE_LABELS = {
	"/Script/Engine.World": "Level"
} as const;
const knownLabels = new Map(Object.entries(TEXT_ASSET_TYPE_LABELS));

const isUpper = (char: string | undefined) => char !== undefined && char >= "A" && char <= "Z";
const isLower = (char: string | undefined) => char !== undefined && char >= "a" && char <= "z";

/**
 * How writers see an asset type, in sentence case like the origin labels. An engine or plugin
 * class is split into words where a capital follows a lowercase letter or starts a word after an
 * acronym (`/Script/UMGEditor.WidgetBlueprint` reads "Widget blueprint"); acronyms keep their
 * case. A Blueprint class keeps its asset name without the `_C` suffix.
 */
export function textAssetTypeLabel(classPath: string): string {
	const known = knownLabels.get(classPath);
	if (known !== undefined) return known;
	const name = classPath.slice(
		Math.max(classPath.lastIndexOf("."), classPath.lastIndexOf("/")) + 1
	);
	if (!classPath.startsWith("/Script/")) return name.replace(/_C$/u, "") || classPath;
	const words: string[] = [];
	let word = "";
	for (let index = 0; index < name.length; index++) {
		const char = name[index]!;
		const previous = name[index - 1];
		if (
			word !== "" &&
			isUpper(char) &&
			(isLower(previous) || (isUpper(previous) && isLower(name[index + 1])))
		) {
			words.push(word);
			word = "";
		}
		word += char;
	}
	if (word !== "") words.push(word);
	if (words.length === 0) return classPath;
	return words
		.map((part, index) =>
			index === 0 || (part.length > 1 && part === part.toUpperCase())
				? part
				: part.toLowerCase()
		)
		.join(" ");
}
