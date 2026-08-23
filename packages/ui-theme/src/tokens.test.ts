import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const supportedBackgrounds = [
	"colorCanvas",
	"colorSurface",
	"colorSurfaceRaised",
	"colorSurfaceHover",
	"colorSurfaceInset"
] as const;
const secondaryText = ["colorTextSubtle", "colorTextFaint"] as const;

function readColor(source: string, token: string): string {
	const match = new RegExp(`${token}:\\s*"(#[\\da-f]{6})"`, "iu").exec(source);
	if (!match?.[1]) throw new Error(`Missing literal color for ${token}`);
	return match[1];
}

function luminance(hex: string): number {
	const channels = [1, 3, 5].map(
		(offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
	);
	const linear = channels.map((channel) =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
	);
	return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(foreground: string, background: string): number {
	const foregroundLuminance = luminance(foreground);
	const backgroundLuminance = luminance(background);
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
}

for (const file of ["tokens.stylex.ts", "themes.stylex.ts"]) {
	describe(`${file} secondary text contrast`, () => {
		const source = readFileSync(new URL(file, import.meta.url), "utf8");
		for (const foregroundToken of secondaryText) {
			for (const backgroundToken of supportedBackgrounds) {
				it(`${foregroundToken} remains readable on ${backgroundToken}`, () => {
					expect(
						contrast(
							readColor(source, foregroundToken),
							readColor(source, backgroundToken)
						)
					).toBeGreaterThanOrEqual(4.5);
				});
			}
		}
	});
}
