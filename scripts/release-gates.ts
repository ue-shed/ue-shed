import type { GateScope } from "./release-evidence.ts";

/** How `release:prepare` runs a gate. */
export type GateCommand =
	| { readonly kind: "scripts"; readonly scripts: readonly string[] }
	| { readonly kind: "clean-pack" }
	| { readonly kind: "plugins"; readonly engine: string };

export interface ReleaseGate {
	readonly id: string;
	readonly title: string;
	/** The files whose changes invalidate this gate's evidence. */
	readonly scope: GateScope;
	readonly lane: "portable" | "pack" | "unreal";
	/**
	 * `always` gates must pass before `pnpm release` publishes. `unreal` gates must pass too unless
	 * the operator records why this release has no Unreal evidence (`--without-unreal`).
	 */
	readonly requirement: "always" | "unreal";
	readonly command: GateCommand;
}

/**
 * The release gates in the order a serial run takes them. Release text runs first because it is
 * fast and catches formatting and release-plan problems before the long gates start.
 */
export const RELEASE_GATES: readonly ReleaseGate[] = [
	{
		id: "release-text",
		title: "Release text (formatting and release tests)",
		scope: "everything",
		lane: "portable",
		requirement: "always",
		command: { kind: "scripts", scripts: ["format:check", "test:release"] }
	},
	{
		id: "check",
		title: "Full local check (pnpm check)",
		scope: "code",
		lane: "portable",
		requirement: "always",
		command: { kind: "scripts", scripts: ["check"] }
	},
	{
		id: "pack",
		title: "Clean release pack",
		scope: "packed",
		lane: "pack",
		requirement: "always",
		command: { kind: "clean-pack" }
	},
	{
		id: "engine-matrix",
		title: "UAsset engine matrix (UE 5.7 and 5.8)",
		scope: "code",
		lane: "unreal",
		requirement: "unreal",
		command: { kind: "scripts", scripts: ["test:uasset-engine-matrix"] }
	},
	{
		id: "unreal",
		title: "Live Unreal gate (check:unreal)",
		scope: "code",
		lane: "unreal",
		requirement: "unreal",
		command: { kind: "scripts", scripts: ["check:unreal"] }
	},
	...["5.7", "5.8", "4.27"].map(
		(engine): ReleaseGate => ({
			id: `plugins-${engine}`,
			title: `Plugin compatibility on UE ${engine}`,
			scope: "code",
			lane: "unreal",
			requirement: "unreal",
			command: { kind: "plugins", engine }
		})
	)
];
