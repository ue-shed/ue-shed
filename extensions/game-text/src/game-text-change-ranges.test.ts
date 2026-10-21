import { expect, it } from "vitest";
import { changeRanges } from "./game-text-change-ranges.js";
it("highlights complete renamed arguments while keeping ordinary edits narrow", () => {
	const before = "Hallo {Name}",
		after = "Hallo {PlayerName}";
	const ranges = changeRanges(before, after);
	expect(ranges.before.map((range) => before.slice(range.start, range.end))).toEqual(["{Name}"]);
	expect(ranges.after.map((range) => after.slice(range.start, range.end))).toEqual([
		"{PlayerName}"
	]);
	expect(changeRanges(after, before)).toEqual({ before: ranges.after, after: ranges.before });
	expect(changeRanges("cat", "car")).toEqual({
		before: [{ start: 2, end: 3 }],
		after: [{ start: 2, end: 3 }]
	});
	expect(changeRanges(before, before)).toEqual({ before: [], after: [] });
});
