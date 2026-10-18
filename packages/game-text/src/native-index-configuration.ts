import { createHash } from "node:crypto";
import type { GameTextIndexConfiguration } from "@ue-shed/protocol";
import type { SharedIndexOptions } from "./shared-index.js";

/** Translate host cache identity to the paired native store identity. */
export function nativeIndexConfiguration(options: SharedIndexOptions): GameTextIndexConfiguration {
	const base = {
		cacheRoot: options.cacheRoot,
		projectKey: options.projectKey,
		targetKey: options.targetKey
	};
	if (!options.projectView) return { ...base, sharedProject: false };
	const identity =
		options.projectView.kind === "source"
			? ["source"]
			: ["localization", options.projectView.target];
	return {
		...base,
		sharedProject: true,
		viewPrefix: `target-join.${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}.`
	};
}
