export function localizationScaleEntry(index: number) {
	const key = `Key${String(index).padStart(6, "0")}`;
	const source = `Generated source ${key}: ${"The traveler follows the road to the village. ".repeat(5)}${index % 101 === 0 ? "\u2028" : ""}`;
	const translation = `Generated translation ${key}: ${"Continue along the path. ".repeat(4)}`;
	const path = `/Game/Generated/Text/Table${Math.floor(index / 100)}.Table`;
	const po = `#. Key: ${key}\r\n#: ${path}\r\nmsgctxt "Generated,${key}"\r\nmsgid ""\r\n"${source.slice(0, 120)}"\r\n"${source.slice(120)}"\r\nmsgstr "${translation}"\r\n\r\n`;
	return { key, source, translation, path, po };
}
