export type LocalizationGatherPath = {
	readonly root: "project" | "engine" | "unknown" | "plain";
	readonly path: string;
};

/** Resolves Dashboard root tokens without interpreting host paths or other substitutions. */
export function resolveLocalizationGatherPath(path: string): LocalizationGatherPath {
	const token = /^%([^%]+)%[/\\]?/u.exec(path);
	if (!token) return { root: /%[^%]+%/u.test(path) ? "unknown" : "plain", path };
	const name = token[1]?.toUpperCase();
	if (name === "LOCPROJECTROOT") return { root: "project", path: path.slice(token[0].length) };
	if (name === "LOCENGINEROOT") return { root: "engine", path: path.slice(token[0].length) };
	return { root: "unknown", path };
}
