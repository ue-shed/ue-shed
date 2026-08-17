import type { CustodianPolicy, ProjectTargetKey } from "./schema.js";

export interface ProjectTargetDefinition {
	readonly key: ProjectTargetKey;
	readonly relativePath: string;
	readonly wildcard?: "plugin";
	readonly description: string;
	readonly rebuildCost: string;
	readonly risk: "low" | "medium" | "high" | "critical";
	readonly defaultOn: boolean;
	readonly minimumAgeDays: number;
}

export const projectTargetDefinitions: readonly ProjectTargetDefinition[] = [
	{
		key: "intermediate",
		relativePath: "Intermediate",
		description: "Build intermediates and compiled shaders",
		rebuildCost: "Full project rebuild and shader recompile",
		risk: "medium",
		defaultOn: true,
		minimumAgeDays: 0
	},
	{
		key: "plugin_intermediate",
		relativePath: "Plugins/*/Intermediate",
		wildcard: "plugin",
		description: "Per-plugin build intermediates",
		rebuildCost: "Rebuilt with the project",
		risk: "medium",
		defaultOn: true,
		minimumAgeDays: 0
	},
	{
		key: "binaries",
		relativePath: "Binaries",
		description: "Compiled editor and game binaries",
		rebuildCost: "Blueprint-only projects regenerate on open; C++ projects require a rebuild",
		risk: "high",
		defaultOn: true,
		minimumAgeDays: 0
	},
	{
		key: "plugin_binaries",
		relativePath: "Plugins/*/Binaries",
		wildcard: "plugin",
		description: "Per-plugin compiled binaries",
		rebuildCost: "Rebuilt with the project",
		risk: "high",
		defaultOn: true,
		minimumAgeDays: 0
	},
	{
		key: "build",
		relativePath: "Build",
		description: "Platform staging output and build receipts",
		rebuildCost: "Regenerated on the next package",
		risk: "medium",
		defaultOn: true,
		minimumAgeDays: 0
	},
	{
		key: "ddc",
		relativePath: "DerivedDataCache",
		description: "Project-local derived data cache",
		rebuildCost: "Re-derived on open; the first load will be slower",
		risk: "low",
		defaultOn: true,
		minimumAgeDays: 0
	},
	{
		key: "cooked",
		relativePath: "Saved/Cooked",
		description: "Cooked content from prior packages",
		rebuildCost: "Re-cooked on the next package",
		risk: "low",
		defaultOn: true,
		minimumAgeDays: 0
	},
	{
		key: "staged",
		relativePath: "Saved/StagedBuilds",
		description: "Staged packaged builds",
		rebuildCost: "Re-staged on the next package",
		risk: "low",
		defaultOn: true,
		minimumAgeDays: 0
	},
	{
		key: "logs",
		relativePath: "Saved/Logs",
		description: "Editor and game logs",
		rebuildCost: "No rebuild cost; historical diagnostics are lost",
		risk: "low",
		defaultOn: true,
		minimumAgeDays: 0
	},
	{
		key: "crashes",
		relativePath: "Saved/Crashes",
		description: "Crash reports",
		rebuildCost: "No rebuild cost; crash evidence is lost",
		risk: "low",
		defaultOn: true,
		minimumAgeDays: 0
	},
	{
		key: "autosaves",
		relativePath: "Saved/Autosaves",
		description: "Editor autosaves",
		rebuildCost: "Unrecoverable when autosaves contain unsaved post-crash work",
		risk: "critical",
		defaultOn: true,
		minimumAgeDays: 90
	},
	{
		key: "saved_config",
		relativePath: "Saved/Config",
		description: "Per-user editor layout and settings",
		rebuildCost: "Regenerated, but editor layout and preferences are lost",
		risk: "high",
		defaultOn: false,
		minimumAgeDays: 0
	}
];

const isProjectTargetKey = (value: string): value is ProjectTargetKey =>
	projectTargetDefinitions.some(({ key }) => key === value);

export const defaultCustodianPolicy: CustodianPolicy = {
	enabled: true,
	minAgeDays: 14,
	minFreeGb: 100,
	keepBinariesForCpp: true,
	targets: projectTargetDefinitions.filter(({ defaultOn }) => defaultOn).map(({ key }) => key),
	source: "default"
};

export interface PolicyResolution {
	readonly policy: CustodianPolicy;
	readonly error?: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function resolvePolicyDocument(value: unknown): PolicyResolution {
	if (!isRecord(value)) {
		return {
			policy: { ...defaultCustodianPolicy, enabled: false, targets: [] },
			error: "Policy must be a JSON object."
		};
	}
	const known = new Set([
		"enabled",
		"min_age_days",
		"min_free_gb",
		"keep_binaries_for_cpp",
		"targets"
	]);
	const unknownFields = Object.keys(value).filter((key) => !known.has(key));
	if (unknownFields.length > 0) {
		return {
			policy: { ...defaultCustodianPolicy, enabled: false, targets: [] },
			error: `Unknown policy field(s): ${unknownFields.sort().join(", ")}.`
		};
	}
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
		return {
			policy: { ...defaultCustodianPolicy, enabled: false, targets: [] },
			error: "enabled must be boolean."
		};
	}
	if (value.min_age_days !== undefined && !nonNegativeNumber(value.min_age_days)) {
		return {
			policy: { ...defaultCustodianPolicy, enabled: false, targets: [] },
			error: "min_age_days must be a non-negative number."
		};
	}
	if (value.min_free_gb !== undefined && !nonNegativeNumber(value.min_free_gb)) {
		return {
			policy: { ...defaultCustodianPolicy, enabled: false, targets: [] },
			error: "min_free_gb must be a non-negative number."
		};
	}
	if (
		value.keep_binaries_for_cpp !== undefined &&
		typeof value.keep_binaries_for_cpp !== "boolean"
	) {
		return {
			policy: { ...defaultCustodianPolicy, enabled: false, targets: [] },
			error: "keep_binaries_for_cpp must be boolean."
		};
	}
	let targets = defaultCustodianPolicy.targets;
	if (value.targets !== undefined) {
		if (!Array.isArray(value.targets) || value.targets.some((key) => typeof key !== "string")) {
			return {
				policy: { ...defaultCustodianPolicy, enabled: false, targets: [] },
				error: "targets must be an array of known target keys."
			};
		}
		const unknownTargets = value.targets.filter((key) => !isProjectTargetKey(key));
		if (unknownTargets.length > 0) {
			return {
				policy: { ...defaultCustodianPolicy, enabled: false, targets: [] },
				error: `Unknown target(s): ${unknownTargets.sort().join(", ")}.`
			};
		}
		targets = [...new Set(value.targets.filter(isProjectTargetKey))];
	}
	return {
		policy: {
			enabled: value.enabled ?? defaultCustodianPolicy.enabled,
			minAgeDays: value.min_age_days ?? defaultCustodianPolicy.minAgeDays,
			minFreeGb: value.min_free_gb ?? defaultCustodianPolicy.minFreeGb,
			keepBinariesForCpp:
				value.keep_binaries_for_cpp ?? defaultCustodianPolicy.keepBinariesForCpp,
			targets,
			source: "project"
		}
	};
}
